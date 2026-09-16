/*
 * ToggleLogic (Free Tier) — live cloud-spend provider.
 * (c) 2026 Motherboard, Inc. Source-available under the ToggleLogic Free-Tier
 * License (see LICENSE). PATENT PENDING.
 *
 * Turns the deployment-owned, validated cloud-spend snapshot (see
 * spend-snapshot.js) into the single number the coordinator feeds to Intelligence
 * as month-to-date cloud spend — WITHOUT any caller hand-entering it. It is read
 * (and re-verified) per plan so a fresh daily snapshot and any post-snapshot
 * cost-log delta take effect without a restart. NEVER throws; on any trouble it
 * reports status "unavailable" with the reason so the caller can fail closed.
 *
 * The coordinator's fail-closed contract (WI4):
 *   - status "ok"          -> feed the validated month-to-date total (+ optional delta).
 *   - status "unavailable" AND a finite cloud budget applies -> feed the
 *     budget-exhausted sentinel so Intelligence withholds cloud routes (local
 *     routes are never headroom-capped, so local-capable work still resolves).
 *   - status "unavailable" AND no finite cloud budget -> fall back to the static
 *     configured spend (no suppression), but the audit shows the snapshot was absent.
 *
 * The universal no-skill fail-safe runs in the coordinator BEFORE any of this, so
 * spend resolution can never turn an actionable-but-unskilled turn into an answer.
 */

import { resolveOpenClawPath } from "../path-utils.js";
import {
  loadSpendSnapshot,
  applyCostLogDelta,
  resolvePolicyMonth,
  DEFAULT_LOCAL_PROVIDERS,
} from "./spend-snapshot.js";

// A finite dollar figure that exhausts any realistic amortized cloud budget, so
// Intelligence's headroom = max(0, budget - spend) collapses to 0 and cloud
// candidates are withheld while local (never headroom-capped) routes remain. Kept
// well below Number.MAX_SAFE_INTEGER to avoid any float-edge surprises downstream.
export const CLOUD_BUDGET_EXHAUSTED_SENTINEL = 1e12;

export function createSpendProvider(spendConfig, {
  version = "",
  expectedIntelligence = "",
  ownerTimezone = "UTC",
  defaultCostLogPath = "",
  fallbackLogger = null,
  nowFn = () => Date.now(),
  deps = {},
} = {}) {
  const cfg = spendConfig && typeof spendConfig === "object" ? spendConfig : {};
  const enabled = cfg.enabled === true;
  const snapshotPath = resolveOpenClawPath(cfg.snapshotPath || "~/.openclaw/togglelogic/cloud-spend.snapshot.json");
  const maxAgeMs = (Number.isFinite(cfg.maxAgeHours) && cfg.maxAgeHours >= 1 ? cfg.maxAgeHours : 26) * 3_600_000;
  const timezone = (typeof cfg.timezone === "string" && cfg.timezone.trim()) ? cfg.timezone.trim() : (ownerTimezone || "UTC");
  const localProviders = Array.isArray(cfg.localProviders) && cfg.localProviders.length
    ? cfg.localProviders : [...DEFAULT_LOCAL_PROVIDERS];
  const finiteCloudBudgetApplies = cfg.finiteCloudBudgetApplies === true;
  const delta = cfg.delta && typeof cfg.delta === "object" ? cfg.delta : {};
  const deltaEnabled = delta.enabled === true;
  const deltaCostLogPath = (typeof delta.costLogPath === "string" && delta.costLogPath.trim())
    ? resolveOpenClawPath(delta.costLogPath.trim())
    : (defaultCostLogPath ? resolveOpenClawPath(defaultCostLogPath) : "");
  const deltaMaxBytes = Number.isFinite(delta.maxBytes) && delta.maxBytes >= 65536 ? Math.floor(delta.maxBytes) : 8 * 1024 * 1024;

  /**
   * Resolve the effective month-to-date cloud spend for routing right now.
   * Returns a rich object; `.effectiveSpendUsd` is the number to feed Intelligence,
   * and `.cloudSuppressed` records whether that number is the exhaustion sentinel.
   */
  function current(nowMs = nowFn()) {
    const policyMonth = resolvePolicyMonth(nowMs, timezone);
    if (!enabled) {
      return { status: "disabled", policyMonth, effectiveSpendUsd: null, cloudSuppressed: false, reason: "spend.enabled=false" };
    }
    let load;
    try {
      load = loadSpendSnapshot({
        snapshotPath,
        expectedPluginFree: version,
        expectedPluginIntelligence: expectedIntelligence || undefined,
        expectedPolicyMonth: policyMonth,
        // The plugin's OWN configured local set is the classification basis — the
        // snapshot's self-declared local_providers must match it exactly or the
        // snapshot fails closed (Blocker 3).
        expectedLocalProviders: localProviders,
        maxAgeMs,
        nowMs,
        deps,
      });
    } catch (error) {
      load = { ok: false, errors: [`spend snapshot load threw: ${String(error?.message ?? error)}`] };
    }

    if (!load.ok) {
      const base = {
        status: "unavailable",
        policyMonth,
        snapshotPath,
        errors: load.errors || ["spend snapshot unavailable"],
        stale: load.stale === true,
      };
      if (finiteCloudBudgetApplies) {
        try { fallbackLogger?.warn?.(`togglelogic spend: snapshot unavailable and a finite cloud budget applies — withholding cloud routes (local-capable routes remain). ${(load.errors || []).join("; ")}`); } catch { /* ignore */ }
        return { ...base, effectiveSpendUsd: CLOUD_BUDGET_EXHAUSTED_SENTINEL, cloudSuppressed: true, reason: "snapshot_unavailable_finite_budget" };
      }
      try { fallbackLogger?.warn?.(`togglelogic spend: snapshot unavailable; falling back to the static monthlyCloudSpendUsd (no finite cloud budget declared). ${(load.errors || []).join("; ")}`); } catch { /* ignore */ }
      return { ...base, effectiveSpendUsd: null, cloudSuppressed: false, reason: "snapshot_unavailable_static_fallback" };
    }

    let monthToDate = load.monthToDateCostUsd;
    let deltaInfo = null;
    if (deltaEnabled && deltaCostLogPath) {
      deltaInfo = applyCostLogDelta(load, {
        costLogPath: deltaCostLogPath,
        policyMonth,
        timezone,
        localProviders,
        nowMs,
        maxBytes: deltaMaxBytes,
        deps,
      });
      // FAIL CLOSED when the post-through delta cannot be PROVEN complete (Blocker
      // 5). A verified base total is worthless if the plugin knows there may be
      // uncounted post-through cloud spend it could not read/parse/price. Treat it
      // exactly like an unavailable snapshot: suppress cloud under a finite budget,
      // else fall back to the static configured spend — never trust the base total
      // as if verified.
      if (deltaInfo.failClosed) {
        const base = {
          status: "unavailable",
          policyMonth,
          snapshotPath,
          errors: [`post-snapshot cost-log delta could not be verified (${deltaInfo.reason}): ${deltaInfo.note}`],
          stale: false,
          delta: { applied: false, failClosed: true, reason: deltaInfo.reason, note: deltaInfo.note },
        };
        if (finiteCloudBudgetApplies) {
          try { fallbackLogger?.warn?.(`togglelogic spend: post-through cost-log delta unverifiable and a finite cloud budget applies — withholding cloud routes. ${deltaInfo.note}`); } catch { /* ignore */ }
          return { ...base, effectiveSpendUsd: CLOUD_BUDGET_EXHAUSTED_SENTINEL, cloudSuppressed: true, reason: "delta_unverifiable_finite_budget" };
        }
        try { fallbackLogger?.warn?.(`togglelogic spend: post-through cost-log delta unverifiable; falling back to the static monthlyCloudSpendUsd. ${deltaInfo.note}`); } catch { /* ignore */ }
        return { ...base, effectiveSpendUsd: null, cloudSuppressed: false, reason: "delta_unverifiable_static_fallback" };
      }
      if (deltaInfo.deltaApplied && Number.isFinite(deltaInfo.monthToDateCostUsd)) {
        monthToDate = deltaInfo.monthToDateCostUsd;
      }
    }

    return {
      status: "ok",
      policyMonth,
      snapshotPath,
      effectiveSpendUsd: monthToDate,
      cloudSuppressed: false,
      reason: "live_snapshot",
      monthToDateCostUsd: load.monthToDateCostUsd,
      throughMs: load.throughMs,
      ageHours: Number.isFinite(load.ageMs) ? Math.round(load.ageMs / 3_600_000) : null,
      localMissingEntries: load.localMissingEntries,
      ...(deltaInfo ? { delta: { applied: deltaInfo.deltaApplied, complete: deltaInfo.complete === true, usd: deltaInfo.deltaUsd, rows: deltaInfo.deltaRows, reason: deltaInfo.reason, note: deltaInfo.note } } : {}),
    };
  }

  return {
    current,
    enabled,
    finiteCloudBudgetApplies,
    snapshotPath,
    timezone,
    config: { enabled, snapshotPath, maxAgeMs, timezone, localProviders, finiteCloudBudgetApplies, deltaEnabled, deltaCostLogPath },
  };
}
