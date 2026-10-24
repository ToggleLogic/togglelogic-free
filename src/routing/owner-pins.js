/*
 * ToggleLogic (Free Tier) — per-task + all-tasks owner-pin resolver.
 * (c) 2026 Motherboard, Inc. Source-available under the ToggleLogic Free-Tier
 * License (see LICENSE); all rights reserved.
 * PATENT PENDING. The benchmark Intelligence engine + Toggle Registry are NOT
 * in this package.
 */

/**
 * Owner-pin resolver (M6, Free 2.3.0) — GENERIC MECHANISM, DEPLOYMENT-AGNOSTIC.
 *
 * Extends the single all-tasks owner override (owner-override.js) to a scoped
 * model: ONE state file holds every scope (`all` plus `task:<label>` entries),
 * and the routing hook resolves, for this turn, the most specific applicable
 * pin. See docs/design/M6-PER-TASK-OWNER-PINS.md §3–§4 and the v2 schema
 * docs/design/schemas/owner-pins.v2.schema.json.
 *
 * READ-ONLY. Like owner-override.js this module never writes; the only writer
 * is the `togglelogic-pin` CLI. It reuses owner-override.js's TTL verdict and
 * ref helpers rather than forking them.
 *
 * ONE FILE, MANY SCOPES, ONE STAT PER DECISION (§3.1). A per-process mtime cache
 * keyed by resolved path holds the parsed document; one statSync runs per
 * request and the read+parse only runs when the file changes. TTL is then
 * re-evaluated against the injected clock on EVERY request (even cache hits), so
 * a future-deadline pin can lapse to expired with no file change — the same
 * property owner-override.js guarantees for the single override.
 *
 * FAIL-CLOSED on a malformed TTL (§2.2/§3.2): an active pin whose
 * `expires_at_ms` is present but not a finite integer is REJECTED (never
 * applied) and surfaced in `rejections` exactly once per file version, so the
 * caller can emit one loud signal. A malformed scope is still REPORTED on every
 * decision (status not_applied, reason "malformed") via the scope result.
 *
 * FAIL-OPEN on I/O (§2.2): a missing / unreadable / malformed-JSON file yields
 * no pins; the request routes as if unpinned. We never throw into the hook.
 *
 * V1 MIGRATION (§3.3): a file with no `pins`/`schema` key but a top-level
 * `active` + `model_ref` is read (never rewritten) as a single `all`-scope pin,
 * honored exactly as today, and reported `no_expiry:true` when it carries no
 * `expires_at_ms`.
 */

import { statSync, readFileSync } from "node:fs";
import { resolvePath } from "../path-utils.js";
import { ttlVerdict, looksLikeModelRef } from "./owner-override.js";

/**
 * Resolve the owner-pin state-file path from the `ownerOverride` config block.
 * Exported for the `togglelogic-pin` CLI (T5) so set/clear/list write exactly
 * the file decide() reads — the config namespace stays `ownerOverride` (§4.3).
 * Independent of `ownerOverride.enabled`: the CLI may pin on a deployment whose
 * routing is not yet enabled.
 *
 * @param {{enabled?:boolean, statePath?:string}} ownerOverrideConfig
 * @param {{paths?:object|null}} [opts]
 * @returns {string|null} the resolved absolute path, or null when unconfigured.
 */
export function resolveOwnerPinsStatePath(ownerOverrideConfig, { paths = null } = {}) {
  const cfg = ownerOverrideConfig;
  if (!cfg || typeof cfg.statePath !== "string" || !cfg.statePath) return null;
  return resolvePath(cfg.statePath, paths);
}

// Per-process cache: resolvedPath -> { mtimeMs, doc }. `doc` is the parsed +
// classified document (schema version + raw pin objects, per scope). The
// read+parse only runs when the file changes; TTL is recomputed per request.
const _cache = new Map();

const EMPTY = Object.freeze({ schemaVersion: null, allRaw: null, taskRaw: null, rejections: Object.freeze([]) });

function classify(parsed) {
  // v2: an explicit `pins` map. v1: top-level override shape. Anything else:
  // no pins (fail-open). Detection is by the presence of the `pins` key (§3.3).
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    if (parsed.pins && typeof parsed.pins === "object" && !Array.isArray(parsed.pins)) {
      const pins = parsed.pins;
      const taskRaw = new Map();
      for (const [key, pin] of Object.entries(pins)) {
        if (key === "all") continue;
        if (key.startsWith("task:")) taskRaw.set(key.slice("task:".length), pin);
      }
      return { schemaVersion: "v2", allRaw: pins.all ?? null, taskRaw };
    }
    if (parsed.active !== undefined || parsed.model_ref !== undefined) {
      return { schemaVersion: "v1", allRaw: parsed, taskRaw: null };
    }
  }
  return { schemaVersion: null, allRaw: null, taskRaw: null };
}

// Build the intrinsic (pre-ranking) result for one scope from its raw pin.
// `nowMs` drives the TTL verdict so expiry is live on every call. The result
// describes whether the pin is eligible to apply and, if not, the block reason;
// the caller (decide) layers on outranking reasons.
function scopeResult(scopeKey, pin, source, nowMs, resolveFamily) {
  if (!pin || typeof pin !== "object") return null;

  const hasExpiry = Object.prototype.hasOwnProperty.call(pin, "expires_at_ms")
    && pin.expires_at_ms !== null && pin.expires_at_ms !== undefined;
  const expiresAtMs = hasExpiry && typeof pin.expires_at_ms === "number" && Number.isFinite(pin.expires_at_ms)
    ? pin.expires_at_ms : null;

  // Target resolution. Exact ref resolves to itself; a family resolves through
  // the injected resolver (wired by T4) to its newest configured member.
  let pinTarget = "model";
  let modelRef;
  let family;
  let resolvedRef = null;
  let resolutionReason;
  if (looksLikeModelRef(pin.model_ref)) {
    pinTarget = "model";
    modelRef = pin.model_ref;
    resolvedRef = pin.model_ref;
  } else if (typeof pin.family === "string" && pin.family) {
    // A family resolves through the injected resolver (wired in T4 from the host
    // allowlist). A family that resolves to nothing is reported `unavailable`
    // below with the resolver's own reason — never silently dropped.
    pinTarget = "family";
    family = pin.family;
    const r = typeof resolveFamily === "function" ? resolveFamily(pin.family) : null;
    resolvedRef = r && typeof r.resolved_ref === "string" && r.resolved_ref ? r.resolved_ref : null;
    resolutionReason = r?.resolution_reason ?? (resolvedRef ? undefined : "no-configured-child");
  }

  const active = pin.active === true;
  let blockReason = null;
  let rejected = false;
  if (!active) {
    blockReason = "inactive";
  } else {
    const verdict = ttlVerdict(pin, nowMs);
    if (verdict === "malformed") {
      blockReason = "malformed";
      rejected = true; // fail-closed, loud once per version
    } else if (verdict === "expired") {
      blockReason = "expired";
    } else if (!resolvedRef) {
      blockReason = "unavailable"; // no valid target, or a family that resolved to nothing
    }
  }
  const eligible = blockReason === null;

  const result = {
    scope: scopeKey,
    source,
    active,
    eligible,
    blockReason,
    rejected,
    pinTarget,
    resolvedRef,
    expiresAtMs,
    noExpiry: !hasExpiry,
    setBy: typeof pin.set_by === "string" ? pin.set_by : undefined,
    setAtMs: typeof pin.set_at_ms === "number" ? pin.set_at_ms : undefined,
    providerOverride: typeof pin.provider_override === "string" ? pin.provider_override : undefined,
  };
  if (modelRef !== undefined) result.modelRef = modelRef;
  if (family !== undefined) result.family = family;
  if (resolutionReason !== undefined) result.resolutionReason = resolutionReason;
  return result;
}

/**
 * Resolve the owner pins for one turn.
 *
 * @param {{enabled?:boolean, statePath?:string}} ownerOverrideConfig
 * @param {{label?:string|null, paths?:object|null, clock?:()=>number,
 *          resolveFamily?:((family:string)=>({resolved_ref?:string,resolution_reason?:string}|null))|null}} [opts]
 *   `label` is the already-normalized (lowercase/trim) host task label, or null.
 *   `clock` returns the current epoch ms (injected for deterministic tests).
 *   `resolveFamily` resolves a `family` pin to a concrete ref (wired in T4).
 * @returns {{configured:boolean, statePath:string|null, schemaVersion:string|null,
 *            labelSeen:string|null, task:object|null, all:object|null,
 *            rejections:Array<{scope:string, reason:string}>}}
 *   `task`/`all` are intrinsic scope results (or null when no pin is configured
 *   for that scope). `rejections` is non-empty ONLY on the read that first sees
 *   a new file version carrying a malformed scope (loud once per version).
 */
export function resolveOwnerPins(ownerOverrideConfig, { label = null, paths = null, clock = Date.now, resolveFamily = null } = {}) {
  const cfg = ownerOverrideConfig;
  const labelSeen = typeof label === "string" && label ? label : null;
  const statePath = resolveOwnerPinsStatePath(cfg, { paths });
  const base = { configured: false, statePath, schemaVersion: null, labelSeen, task: null, all: null, rejections: [] };
  if (!cfg || cfg.enabled !== true || !statePath) return base;
  base.configured = true;

  let mtimeMs;
  try {
    mtimeMs = statSync(statePath).mtimeMs;
  } catch {
    _cache.set(statePath, { mtimeMs: -1, doc: EMPTY });
    return base;
  }

  const nowMs = clock();
  const cached = _cache.get(statePath);
  let doc;
  let freshVersion = false;
  if (cached && cached.mtimeMs === mtimeMs) {
    doc = cached.doc;
  } else {
    freshVersion = true;
    try {
      const classified = classify(JSON.parse(readFileSync(statePath, "utf8")));
      // Detect malformed scopes once, at parse time (malformed is clock-
      // independent). These become the one-shot `rejections` on this version.
      const rejections = [];
      const flag = (scopeKey, pin) => { if (pin && pin.active === true && ttlVerdict(pin, nowMs) === "malformed") rejections.push({ scope: scopeKey, reason: "malformed_expires_at_ms" }); };
      flag("all", classified.allRaw);
      if (classified.taskRaw) for (const [lbl, pin] of classified.taskRaw) flag(`task:${lbl}`, pin);
      doc = { ...classified, rejections };
    } catch {
      doc = EMPTY; // malformed JSON / unreadable → fail open
    }
    _cache.set(statePath, { mtimeMs, doc });
  }

  base.schemaVersion = doc.schemaVersion;
  base.all = scopeResult("all", doc.allRaw, doc.schemaVersion, nowMs, resolveFamily);
  if (labelSeen && doc.taskRaw && doc.taskRaw.has(labelSeen)) {
    base.task = scopeResult(`task:${labelSeen}`, doc.taskRaw.get(labelSeen), doc.schemaVersion, nowMs, resolveFamily);
  }
  // Loud only on the first read of a new version (quiet on cache hits), exactly
  // like owner-override.js's one-rejection-per-version contract.
  if (freshVersion && doc.rejections && doc.rejections.length) base.rejections = doc.rejections;
  return base;
}

// Exposed for in-process tests only.
export const _internal = { classify, scopeResult, _cache };
