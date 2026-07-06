/*
 * ToggleLogic (Free Tier) — dynamic public pricing for cost visibility.
 * (c) 2026 Motherboard, Inc. Source-available under the ToggleLogic Free-Tier
 * License (see LICENSE): free, limited, REVOCABLE use; all rights reserved.
 * PATENT PENDING. The benchmark Intelligence engine + Toggle Registry are NOT
 * in this package.
 *
 * Prices are fetched LIVE from a public, open-source source (Models.dev, MIT),
 * cached locally, and refreshed on a slow cadence — never hardcoded, never
 * fetched per-call, and NEVER fetched from any Motherboard/HQ endpoint. If the
 * live source is unreachable, pricing degrades to a bundled LiteLLM snapshot
 * (MIT) so the feature never breaks. Anything the curated free-tier set can't
 * price resolves as UNPRICED (loud) — never a silent $0.00.
 *
 * FREE = curated major-provider lineups (Anthropic/OpenAI/Google/xAI/Meta).
 * All-model coverage + a guaranteed-current registry is the paid tier.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

import { candidateKeys, feedIndexKeys, isCurated, providerOf } from "./normalize-ref.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUNDLED_FALLBACK = path.join(HERE, "pricing-fallback.json");

const MODELS_DEV_URL = "https://models.dev/api.json";
// Models.dev 403s a bare urllib/library UA (anti-bot); a browser-like UA is required.
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) togglelogic-cost/1.0";

// Curated first-party provider blocks are indexed FIRST so their prices win over
// aggregator re-keys of the same model.
const FIRST_PARTY = ["anthropic", "openai", "google", "xai", "togetherai", "together"];

function expandTilde(p) {
  if (typeof p !== "string") return p;
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/**
 * Build a resolution index: Map<canonKey, {inputPerM, outputPerM, source}>.
 * Priority (first-write-wins): user override > Models.dev > bundled fallback.
 */
export function buildIndex({ modelsDev, fallback, userOverride } = {}) {
  const idx = new Map();
  const insert = (keys, val) => {
    if (val.inputPerM == null && val.outputPerM == null) return;
    for (const k of keys) if (!idx.has(k)) idx.set(k, val);
  };

  // 1) deployment-supplied override (DATA) — highest priority.
  if (userOverride && typeof userOverride === "object") {
    const entries = Array.isArray(userOverride.models)
      ? userOverride.models.map((e) => [e.m ?? e.model ?? e.ref, e])
      : Object.entries(userOverride);
    for (const [ref, e] of entries) {
      if (!ref) continue;
      const inputPerM = num(e.i ?? e.input ?? e.inputPerM);
      const outputPerM = num(e.o ?? e.output ?? e.outputPerM);
      insert(feedIndexKeys("", ref), { inputPerM, outputPerM, source: "override" });
    }
  }

  // 2) Models.dev (live/cached) — curated first-party providers indexed first.
  if (modelsDev && typeof modelsDev === "object") {
    const provIds = Object.keys(modelsDev);
    const ordered = [
      ...FIRST_PARTY.filter((p) => modelsDev[p]),
      ...provIds.filter((p) => !FIRST_PARTY.includes(p)),
    ];
    for (const p of ordered) {
      const models = modelsDev[p] && modelsDev[p].models;
      if (!models || typeof models !== "object") continue;
      for (const [mid, m] of Object.entries(models)) {
        const cost = m && m.cost;
        if (!cost) continue;
        insert(feedIndexKeys(p, mid), {
          inputPerM: num(cost.input),
          outputPerM: num(cost.output),
          source: "models.dev",
        });
      }
    }
  }

  // 3) bundled fallback (MIT LiteLLM snapshot) — fills gaps only.
  if (fallback && Array.isArray(fallback.models)) {
    for (const e of fallback.models) {
      insert(feedIndexKeys(e.p, e.m), {
        inputPerM: num(e.i),
        outputPerM: num(e.o),
        source: "bundled",
      });
    }
  }

  return idx;
}

function num(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

/**
 * Create the pricing engine. `deps` lets tests inject fetch/clock/paths.
 */
export function createPricing(cfg = {}, fallbackLogger, deps = {}) {
  const cachePath = expandTilde(cfg.cachePath ?? "~/.openclaw/togglelogic/pricing-cache.json");
  const overridePath = cfg.userPriceOverridePath
    ? expandTilde(cfg.userPriceOverridePath)
    : "";
  const refreshMs = Math.max(1, cfg.refreshHours ?? 24) * 3600 * 1000;
  const timeoutMs = Math.max(1000, cfg.timeoutMs ?? 15000);
  const sourceUrl = cfg.sourceUrl ?? MODELS_DEV_URL;
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const now = deps.now ?? (() => Date.now());

  let index = null;
  let builtAt = 0;
  let building = null;
  let warned = false;

  function warnOnce(msg) {
    if (warned) return;
    warned = true;
    try { fallbackLogger?.warn?.(`togglelogic cost: ${msg}`); } catch { /* ignore */ }
  }

  async function loadBundled() {
    try { return JSON.parse(await fs.readFile(BUNDLED_FALLBACK, "utf8")); }
    catch { return { models: [] }; }
  }
  async function loadCache() {
    try { return JSON.parse(await fs.readFile(cachePath, "utf8")); } catch { return null; }
  }
  async function saveCache(data) {
    try {
      await fs.mkdir(path.dirname(cachePath), { recursive: true });
      const tmp = cachePath + ".tmp";
      await fs.writeFile(tmp, JSON.stringify({ fetchedAt: now(), source: sourceUrl, data }));
      await fs.rename(tmp, cachePath);
    } catch (e) { warnOnce(`could not write price cache (${e?.message ?? e})`); }
  }
  async function loadOverride() {
    if (!overridePath) return null;
    try { return JSON.parse(await fs.readFile(overridePath, "utf8")); } catch { return null; }
  }

  async function fetchModelsDev() {
    if (typeof fetchImpl !== "function") return null;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(sourceUrl, {
        headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
        signal: ctrl.signal,
      });
      if (!res || !res.ok) { warnOnce(`pricing source HTTP ${res && res.status}; using cache/fallback`); return null; }
      return await res.json();
    } catch (e) {
      warnOnce(`pricing source unreachable (${e?.message ?? e}); using cache/fallback`);
      return null;
    } finally { clearTimeout(t); }
  }

  async function rebuild() {
    const [fallback, override, cache] = await Promise.all([loadBundled(), loadOverride(), loadCache()]);
    let modelsDev = null;
    const cacheFresh = cache && Number.isFinite(cache.fetchedAt) && now() - cache.fetchedAt < refreshMs;
    if (cacheFresh) {
      modelsDev = cache.data;
    } else {
      modelsDev = await fetchModelsDev();
      if (modelsDev) await saveCache(modelsDev);
      else if (cache && cache.data) modelsDev = cache.data; // stale cache beats nothing
    }
    index = buildIndex({ modelsDev, fallback, userOverride: override });
    builtAt = now();
    return index;
  }

  async function ensureIndex() {
    if (index && now() - builtAt < refreshMs) return index;
    if (building) return building;
    building = rebuild().finally(() => { building = null; });
    return building;
  }

  /**
   * Resolve a price for a usage ref. Returns:
   *   { curated:false }                      -> outside the free-tier set (unpriced-loud)
   *   { curated:true, priced:false }         -> curated but no price found (unpriced-loud)
   *   { curated:true, priced:true, inputPerM, outputPerM, source, matched }
   * NEVER throws; NEVER returns a $0.00 stand-in for "unknown".
   */
  async function resolve(ref) {
    if (!isCurated(ref)) return { ref, provider: providerOf(ref), curated: false, priced: false };
    const idx = await ensureIndex();
    for (const k of candidateKeys(ref)) {
      const v = idx.get(k);
      if (v) {
        return {
          ref, provider: providerOf(ref), curated: true, priced: true,
          inputPerM: v.inputPerM, outputPerM: v.outputPerM, source: v.source, matched: k,
        };
      }
    }
    return { ref, provider: providerOf(ref), curated: true, priced: false };
  }

  /**
   * Dollar cost for a resolved price + token usage. Cache tokens are billed at the
   * standard input rate here (a conservative, source-agnostic estimate — precise
   * cache-tier pricing is a paid-registry concern). Returns null when unpriced.
   */
  function costUsd(priceInfo, usage) {
    if (!priceInfo || !priceInfo.priced) return null;
    const inTok = num(usage?.input) ?? 0;
    const outTok = num(usage?.output) ?? 0;
    const cacheTok = (num(usage?.cacheRead) ?? 0) + (num(usage?.cacheWrite) ?? 0);
    const inRate = priceInfo.inputPerM ?? 0;
    const outRate = priceInfo.outputPerM ?? 0;
    return ((inTok + cacheTok) * inRate + outTok * outRate) / 1e6;
  }

  return { resolve, costUsd, ensureIndex, buildIndex, _paths: { cachePath, overridePath, sourceUrl } };
}
