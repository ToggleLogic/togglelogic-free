/*
 * ToggleLogic (Free Tier) — model-routing plugin for OpenClaw.
 * (c) 2026 Motherboard, Inc. Source-available under the ToggleLogic Free-Tier
 * License (see LICENSE): free, limited, REVOCABLE use; all rights reserved.
 * PATENT PENDING. The benchmark Intelligence engine + Toggle Registry are NOT
 * in this package.
 */

/**
 * Owner override resolver — GENERIC MECHANISM, DEPLOYMENT-AGNOSTIC.
 *
 * This module reads a deployment-supplied state file and, if it declares an
 * active model, returns that model so the routing hook can apply it ABOVE the
 * intelligence classifier. It is the owner's explicit choice flowing THROUGH
 * ToggleLogic as the top-priority routing input — not a gateway-default bypass
 * the classifier would silently override.
 *
 * INDEPENDENCE: this plugin NEVER writes the state file and contains NO model
 * values or deployment policy. The state file's contents (which model, who set
 * it, why) are entirely deployment-provided DATA. Whatever workflow sets or
 * clears the file — a skill, a CLI, a UI — lives outside this plugin. The
 * override "holds" across requests because this resolver runs per request and
 * keeps applying the file's value until the file says active:false (or is
 * removed).
 *
 * NO EXPIRY/TTL HERE BY DESIGN: lifecycle (when to stop holding, when to ask
 * the owner to switch back) is deployment behavior, not engine policy. The
 * engine's sole job is to read state and apply it generically.
 *
 * State file shape (active + model_ref required; the rest is opaque to us and
 * passed through for audit/observability only):
 *   {
 *     "active":           true,
 *     "model_ref":        "google/gemini-3.5-flash",   // provider/model
 *     "provider_override":"google",                    // optional
 *     "set_by":           "model-switch",
 *     "set_at_ms":        1780000000000,
 *     "reason":           "owner switch",
 *     "family_input":     "gemini"
 *   }
 *
 * FAIL-OPEN: any missing / unreadable / malformed file → no override applied,
 * and the request routes via the classifier as if no override existed. We
 * never throw into the hook.
 */

import { homedir } from "node:os";
import { statSync, readFileSync } from "node:fs";

function expandTilde(p) {
  if (typeof p !== "string") return p;
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return homedir() + p.slice(1);
  return p;
}

/** A model_ref must be "provider/model" — a single non-edge slash. */
function looksLikeModelRef(ref) {
  if (typeof ref !== "string") return false;
  const i = ref.indexOf("/");
  return i > 0 && i < ref.length - 1;
}

// Per-process mtime cache: avoid re-reading + re-parsing the state file on
// every request when it hasn't changed (the common case). Keyed by resolved
// path. A statSync per request is cheap; the read+parse only runs on change,
// so an active override takes effect on the very next request after a write
// (no gateway restart), while steady-state requests pay almost nothing.
const _cache = new Map(); // resolvedPath -> { mtimeMs, result }

const NOT_APPLIED = Object.freeze({ applied: false });

/**
 * @param {{enabled?:boolean, statePath?:string}} ownerOverrideConfig
 * @returns {{applied:boolean, modelRef?:string, providerOverride?:string, state?:object}}
 */
export function resolveOwnerOverride(ownerOverrideConfig) {
  const cfg = ownerOverrideConfig;
  if (!cfg || cfg.enabled !== true || typeof cfg.statePath !== "string") {
    return NOT_APPLIED;
  }
  const path = expandTilde(cfg.statePath);

  let mtimeMs;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    // Missing file = the resume / cleared state. Cache the absence cheaply
    // (sentinel mtime) so we don't statSync-throw-catch every request.
    _cache.set(path, { mtimeMs: -1, result: NOT_APPLIED });
    return NOT_APPLIED;
  }

  const cached = _cache.get(path);
  if (cached && cached.mtimeMs === mtimeMs) {
    return cached.result;
  }

  let result = NOT_APPLIED;
  try {
    const state = JSON.parse(readFileSync(path, "utf8"));
    if (state && state.active === true && looksLikeModelRef(state.model_ref)) {
      // OpenClaw's model-resolve override expects provider and model as
      // SEPARATE fields: providerOverride = the part before the first '/',
      // modelOverride = everything after. Passing the full "provider/model"
      // ref as modelOverride WHILE also setting providerOverride double-
      // prefixes it (→ "google/google/gemini-…"), which fails resolution.
      // This mirrors the intelligence adapter's split exactly (split on the
      // FIRST slash so multi-segment refs like
      // "together/meta-llama/Llama-…" keep their tail intact).
      const ref = state.model_ref;
      const slash = ref.indexOf("/");
      const providerOverride = ref.slice(0, slash);
      const modelOverride = ref.slice(slash + 1);
      result = {
        applied: true,
        modelOverride, // model name only (no provider prefix)
        providerOverride, // provider only
        modelRef: ref, // full ref, for logging/audit
        state,
      };
    }
  } catch {
    result = NOT_APPLIED; // malformed JSON → fail open to classifier
  }

  _cache.set(path, { mtimeMs, result });
  return result;
}

// Exposed for in-process tests only.
export const _internal = { expandTilde, looksLikeModelRef };
