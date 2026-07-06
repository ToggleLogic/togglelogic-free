/*
 * ToggleLogic (Free Tier) — cost-visibility observer.
 * (c) 2026 Motherboard, Inc. Source-available under the ToggleLogic Free-Tier
 * License (see LICENSE): free, limited, REVOCABLE use; all rights reserved.
 * PATENT PENDING.
 *
 * Subscribes to the core `llm_output` hook (post-completion, OBSERVE-ONLY),
 * prices each call from dynamic public data (see pricing.js), and records the
 * dollar cost — writing a per-call row and a periodic loud summary to the
 * plugin's own cost log. It never blocks, halts, downgrades, or mutates a call
 * (llm_output is void-typed): reporting only. Enforcement is a paid capability.
 */

import { createPricing } from "./pricing.js";
import { createTally } from "./cost-tally.js";
import { createLogger } from "../observability/logger.js";

function num(x) { const n = Number(x); return Number.isFinite(n) ? n : 0; }
function round6(n) { return Math.round((Number(n) || 0) * 1e6) / 1e6; }

export function createCostObserver({ config, fallbackLogger, deps = {} } = {}) {
  const cv = config.costVisibility;
  const now = deps.now ?? (() => Date.now());
  const pricing = deps.pricing ?? createPricing(cv.pricing, fallbackLogger, deps);
  const tally = deps.tally ?? createTally({ now });
  const costLog =
    deps.logger ??
    createLogger(
      { enabled: cv.log.enabled, path: cv.log.path, rotateSizeMb: cv.log.rotateSizeMb },
      fallbackLogger
    );
  const summaryEvery = Math.max(1, cv.summaryEveryCalls ?? 20);
  let calls = 0;

  function refOf(event) {
    if (event && event.resolvedRef) return event.resolvedRef;
    if (event && event.provider && event.model) return `${event.provider}/${event.model}`;
    return (event && (event.model || event.provider)) || "unknown";
  }

  function emitSummary() {
    try {
      const sum = tally.summarize();
      costLog.write({ kind: "summary", ts: new Date(now()).toISOString(), line: tally.loudLine(sum), ...sum }).catch(() => {});
    } catch { /* ignore */ }
  }

  /**
   * OBSERVE-ONLY llm_output handler. Always resolves to `undefined` (the hook is
   * void-typed; nothing it returns can affect the call). Never throws into the
   * gateway; a pricing/logging failure is swallowed.
   */
  async function handler(event) {
    try {
      const ref = refOf(event);
      const usage = (event && event.usage) || {};
      const inTok = num(usage.input);
      const outTok = num(usage.output);
      const cacheTok = num(usage.cacheRead) + num(usage.cacheWrite);

      const price = await pricing.resolve(ref);
      const priced = !!(price && price.priced);
      const cost = priced ? pricing.costUsd(price, usage) : null;

      const row = {
        kind: "call",
        ts: new Date(now()).toISOString(),
        provider: price.provider,
        model: event && event.model,
        resolvedRef: ref,
        inputTok: inTok,
        outputTok: outTok,
        cacheTok,
      };
      if (priced) {
        row.costUsd = round6(cost);
        row.inputPerM = price.inputPerM;
        row.outputPerM = price.outputPerM;
        row.priceSource = price.source;
      } else {
        // LOUD-FAIL: an unpriced call is recorded as explicitly unpriced with its
        // token count — NEVER as costUsd: 0.
        row.priced = false;
        row.unpriced = true;
        row.reason = price.curated ? "no-price-in-source" : "not-in-curated-free-set";
      }
      costLog.write(row).catch(() => {});
      tally.record({ ts: now(), ref, provider: price.provider, inputTok: inTok, outputTok: outTok, cacheTok, priced, costUsd: cost });

      if (++calls % summaryEvery === 0) emitSummary();
    } catch (e) {
      try { fallbackLogger?.warn?.(`togglelogic cost: observe error (${e?.message ?? e})`); } catch { /* ignore */ }
    }
    return undefined; // observe-only — cannot block/halt/downgrade a call
  }

  // Warm the price index at startup so the first observed call is fast (and so a
  // per-call fetch never happens — cached + refreshed on a slow cadence).
  function warm() { try { return pricing.ensureIndex().catch(() => {}); } catch { return Promise.resolve(); } }

  return { handler, emitSummary, warm, tally, pricing, costLog, logPath: costLog.path };
}
