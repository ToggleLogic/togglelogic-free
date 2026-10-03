/*
 * ToggleLogic (Free Tier) — background ledger replay and monthly budget alerts.
 * (c) 2026 Motherboard, Inc. Source-available under the ToggleLogic Free-Tier
 * License (see LICENSE); all rights reserved.
 * PATENT PENDING.
 */
import { readLedger } from "./ledger-reader.js";
import { classifyLedgerCall, dollarsToMicros, microsToDollars } from "./ledger-row.js";

export function createBudgetTracker({ config = {}, ledgerPath, enabled = true, costLog,
  events, deploymentId, now = () => Date.now(), fallbackLogger } = {}) {
  const active = Number.isFinite(config.monthlyUsd) && config.monthlyUsd > 0;
  const months = new Map();
  const thresholds = config.thresholdsPct ?? [50, 80, 100];
  let historyIncomplete = false;
  function warn(message) { try { fallbackLogger?.warn?.(message); } catch { /* observe only */ } }
  function bucket(month) {
    if (!months.has(month)) months.set(month, { spentMicros: 0, unpricedCalls: 0, usageMissingCalls: 0 });
    return months.get(month);
  }
  function add(row) {
    if (row.kind !== "call" || row.deploymentId !== deploymentId) return null;
    const time = Date.parse(row.ts);
    if (!Number.isFinite(time)) return null;
    const month = new Date(time).toISOString().slice(0, 7), total = bucket(month);
    const state = classifyLedgerCall(row);
    if (state.priced) total.spentMicros += dollarsToMicros(row.costUsd);
    if (state.unpriced) total.unpricedCalls++;
    if (state.usageMissing) total.usageMissingCalls++;
    return month;
  }
  function check(month, requestId = null) {
    const total = bucket(month), spentUsd = microsToDollars(total.spentMicros);
    for (const thresholdPct of thresholds) {
      if (spentUsd * 100 < config.monthlyUsd * thresholdPct) continue;
      void events.emit("budget_threshold_crossed", { month, thresholdPct,
        monthlyUsd: config.monthlyUsd, spentUsd, unpricedCalls: total.unpricedCalls,
        usageMissingCalls: total.usageMissingCalls, historyIncomplete, requestId });
    }
  }
  // Queue ledger appends behind startup replay to avoid counting the first live
  // call twice. Neither replay nor writes are awaited by the llm_output hook.
  let queue = active ? (async () => {
    if (!ledgerPath || !enabled) {
      historyIncomplete = true;
      warn("togglelogic budget: ledger persistence is disabled; totals cannot survive restart");
      return;
    }
    try {
      const diagnostics = await readLedger(ledgerPath, add);
      historyIncomplete = diagnostics.malformedRows > 0 || diagnostics.invalidTimestampRows > 0;
      if (historyIncomplete) warn("togglelogic budget: ledger has unreadable rows; totals are incomplete");
    } catch {
      historyIncomplete = true;
      warn("togglelogic budget: ledger replay failed; totals are incomplete");
    }
    check(new Date(now()).toISOString().slice(0, 7));
  })() : Promise.resolve();

  function write(row) {
    if (!active) return costLog.write(row).catch(() => {});
    queue = queue.then(async () => {
      await costLog.write(row);
      const month = add(row);
      if (month) check(month, row.requestId);
    }).catch(() => { historyIncomplete = true; warn("togglelogic budget: ledger update failed"); });
    return queue;
  }
  async function flush() { await queue; await costLog.flush?.(); await events.flush(); }
  function snapshot(month = new Date(now()).toISOString().slice(0, 7)) {
    const total = bucket(month);
    return { month, spentUsd: microsToDollars(total.spentMicros), unpricedCalls: total.unpricedCalls,
      usageMissingCalls: total.usageMissingCalls, historyIncomplete };
  }
  return { write, flush, snapshot };
}
