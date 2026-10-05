/*
 * ToggleLogic (Free Tier) — cost-visibility observer.
 * (c) 2026 Motherboard, Inc. Source-available under the ToggleLogic Free-Tier
 * License (see LICENSE); all rights reserved.
 * PATENT PENDING.
 *
 * Subscribes to the core `llm_output` hook (post-completion, OBSERVE-ONLY),
 * prices each call from dynamic public data (see pricing.js), and records the
 * dollar cost — writing a per-call row and a periodic loud summary to the
 * plugin's own cost log. It never blocks, halts, downgrades, or mutates a call
 * (llm_output is void-typed): reporting only. Enforcement is a paid capability.
 */

import { createUsageEvents, isLocalProvider } from "./events.js";
import { deriveLineage, billingFields } from "./ledger-row.js";
import { createBalances } from "./balances.js";
import { createBudgetTracker } from "./budgets.js";
import { createPricing } from "./pricing.js";
import { createTally } from "./cost-tally.js";
import { createLogger } from "../observability/logger.js";
import { hostname } from "node:os";

function num(x) { const n = Number(x); return Number.isFinite(n) ? n : 0; }
function round6(n) { return Math.round((Number(n) || 0) * 1e6) / 1e6; }

export function createCostObserver({ config, hostConfig, audit, fallbackLogger, requestCorrelation = null, deps = {} } = {}) {
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
  const configuredDeploymentId = cv.attribution && cv.attribution.deploymentId;
  const deploymentId = configuredDeploymentId || safeHostname(deps.hostname);
  const costCenter = (cv.attribution && cv.attribution.costCenter) || null;

  const events = createUsageEvents({
    config: cv.events, audit, fallbackLogger, deploymentId, costCenter,
    logger: deps.eventLogger, now,
  });

  const budgets = createBudgetTracker({ config: cv.budgets, ledgerPath: costLog.path,
    enabled: cv.log.enabled, costLog, events, deploymentId, now, fallbackLogger });

  const balances = createBalances({ config: cv.balances, ledgerPath: costLog.path, events, deploymentId, costCenter, now });
  // Replay completes before this observer appends its first live call, avoiding
  // double counting a row that is both on disk and delivered incrementally.
  const balanceReady = cv.log.enabled && costLog.path ? balances.start().catch(() => {
    fallbackLogger?.warn?.("togglelogic balance: startup replay failed");
  }) : Promise.resolve();
  let balanceQueue = balanceReady;
  function writeCall(row) {
    const write = budgets.write(row);
    balanceQueue = balanceQueue.then(async () => {
      await write;
      if (cv.log.enabled && costLog.path) {
        await balances.record(row);
        await balances.check({ requestId: row.requestId, requestIdReason: row.requestIdReason });
      }
    }).catch(() => { fallbackLogger?.warn?.("togglelogic balance: estimate update failed; inspect balance history and ledger"); });
  }

  function safeHostname(hostnameFn = hostname) {
    try {
      const value = String(hostnameFn() || "").trim().toLowerCase();
      return /^[a-z0-9][a-z0-9._-]{0,63}$/.test(value) ? value : "unknown";
    } catch {
      return "unknown";
    }
  }

  function refOf(event) {
    if (event && event.resolvedRef) return event.resolvedRef;
    if (event && event.provider && event.model) return `${event.provider}/${event.model}`;
    return (event && (event.model || event.provider)) || "unknown";
  }

  function emitSummary() {
    try {
      const sum = tally.summarize();
      budgets.write({
        schema: "togglelogic.fleet-usage.v1",
        kind: "summary",
        requestId: null,
        requestIdReason: "aggregate-summary",
        ts: new Date(now()).toISOString(),
        deploymentId,
        costCenter,
        line: tally.loudLine(sum),
        ...sum,
      }).catch(() => {});
    } catch { /* ignore */ }
  }

  /**
   * OBSERVE-ONLY llm_output handler. Always resolves to `undefined` (the hook is
   * void-typed; nothing it returns can affect the call). Never throws into the
   * gateway; a pricing/logging failure is swallowed.
   */
  async function handler(event, context) {
    try {
      // Capture before pricing awaits: another routing hook may run meanwhile.
      const correlation = requestCorrelation?.lookup(event, context) ?? {
        requestId: null, requestIdReason: "routing-correlation-unavailable",
      };
      const ts = now();
      const ref = refOf(event);
      const provider = event?.provider || (ref.includes("/") ? ref.split("/")[0] : "unknown");
      const usage = (event && event.usage) || {};
      const inTok = num(usage.input);
      const outTok = num(usage.output);
      const cacheReadTok = num(usage.cacheRead);
      const cacheWriteTok = num(usage.cacheWrite);
      const cacheTok = cacheReadTok + cacheWriteTok;

      const price = await pricing.resolve(ref);
      let priced = !!(price && price.priced);
      // USAGE VALIDITY GATE (2026-08-02): a numeric dollar cost is trustworthy only when
      // the call actually reported finite input AND output token counts. Absent or
      // non-finite usage on a PRICED model is a false $0.00 waiting to happen — the old
      // code took the priced branch and wrote costUsd: 0.00, indistinguishable from a
      // genuine zero. It must take a LOUD path instead, distinct from both a real cost and
      // a missing price. Three outcomes, not two. (cacheRead/cacheWrite stay optional —
      // absent cache is normal and never gates the cost.)
      const usageValid =
        [usage.input, usage.output].every((value) =>
          (typeof value === "number" || (typeof value === "string" && value.trim() !== "")) &&
          Number.isFinite(Number(value)) && Number(value) >= 0) &&
        inTok + outTok + cacheReadTok + cacheWriteTok > 0;
      let costed = priced && usageValid;
      // Single reconciled cost math (cache-token aware) shared with the receipt.
      // Fall back to costUsd for minimal pricing deps that predate costBreakdown.
      let breakdown = null;
      if (costed) {
        if (typeof pricing.costBreakdown === "function") {
          breakdown = pricing.costBreakdown(price, usage);
        } else {
          const total = pricing.costUsd(price, usage);
          breakdown = Number.isFinite(total)
            ? { total, cacheBasis: "unavailable", cacheReadUsd: 0, cacheWriteUsd: 0, cacheReadRatePerM: null, cacheWriteRatePerM: null }
            : null;
        }
      }
      const cost = breakdown ? breakdown.total : null;
      if (costed && (!Number.isFinite(cost) || cost < 0)) { priced = false; costed = false; }
      const usageMissing = priced && !usageValid;

      const row = {
        schema: "togglelogic.fleet-usage.v1",
        kind: "call",
        ...correlation,
        ts: new Date(ts).toISOString(),
        deploymentId,
        costCenter,
        provider,
        model: event?.model ?? null,
        resolvedRef: ref,
        ...deriveLineage(ref),
        costUsd: null,
        priceSource: price?.source ?? null,
        priceVersion: price?.priceVersion ?? null,
        priced, unpriced: !priced, usageMissing,
        ...billingFields({ priced, usageMissing, billableDeployment: cv.attribution?.billable !== false }),
        inputTok: inTok,
        outputTok: outTok,
        cacheTok,
        cacheReadTok,
        cacheWriteTok,
      };
      if (costed) {
        row.costUsd = round6(cost);
        // Public price-card math is useful attribution evidence, but it is not
        // an authoritative provider invoice. Later reconciliation promotes it to
        // invoice-ready only after the fleet total agrees with provider truth.
        row.costBasis = "public-rate-estimate";
        row.invoiceEligible = false;
        row.inputPerM = price.inputPerM;
        row.outputPerM = price.outputPerM;
        // Cache-token basis is stated LOUDLY so the log and the owner receipt
        // (both derived from pricing.costBreakdown) reconcile on one number and
        // never silently diverge. "input-rate-proxy" flags a source without an
        // explicit cache-tier rate; "source-cache-rate" is provider-stated.
        row.cacheBasis = breakdown.cacheBasis;
        row.cacheReadUsd = round6(breakdown.cacheReadUsd);
        row.cacheWriteUsd = round6(breakdown.cacheWriteUsd);
        if (Number.isFinite(breakdown.cacheReadRatePerM)) row.cacheReadPerM = breakdown.cacheReadRatePerM;
        if (Number.isFinite(breakdown.cacheWriteRatePerM)) row.cacheWritePerM = breakdown.cacheWriteRatePerM;
      } else if (priced) {
        // LOUD: the model IS priced, but usage is absent/non-finite — record it as
        // explicitly usage-missing, NEVER as costUsd: 0. Distinct reason from unpriced so
        // the two failure modes stay diagnosable.
        row.priced = true;
        row.unpriced = false;
        row.usageMissing = true;
        row.reason = "priced-but-usage-missing";
        row.invoiceEligible = false;
      } else {
        // LOUD-FAIL: an unpriced call is recorded as explicitly unpriced with its
        // token count — NEVER as costUsd: 0.
        row.priced = false;
        row.unpriced = true;
        row.reason = price?.curated === false ? "outside-price-coverage" : "no-price-in-source";
        row.invoiceEligible = false;
      }
      await balanceReady;
      writeCall(row);
      tally.record({ ts, ref, provider, inputTok: inTok, outputTok: outTok, cacheTok,
        priced: costed, usageMissing: priced && !usageValid, costUsd: cost });
      if (row.unpriced && !isLocalProvider(provider, cv.localProviders, hostConfig)) {
        void events.emit("model_unpriced", { ts, provider, model: event?.model, resolvedRef: ref,
          reason: row.reason, requestId: correlation.requestId });
      } else if (row.usageMissing) {
        void events.emit("usage_missing", { ts, provider, model: event?.model, resolvedRef: ref,
          calls: 1, requestId: correlation.requestId });
      }

      if (++calls % summaryEvery === 0) emitSummary();
    } catch (e) {
      try { fallbackLogger?.warn?.(`togglelogic cost: observe error (${e?.message ?? e})`); } catch { /* ignore */ }
    }
    return undefined; // observe-only — cannot block/halt/downgrade a call
  }

  // Warm the price index at startup so the first observed call is fast (and so a
  // per-call fetch never happens — cached + refreshed on a slow cadence).
  function warm() { try { return pricing.ensureIndex().catch(() => {}); } catch { return Promise.resolve(); } }

  return { handler, emitSummary, warm, tally, pricing, costLog, events, budgets, balances, flushBalances: () => balanceQueue, logPath: costLog.path, deploymentId, costCenter };
}
