/*
 * ToggleLogic (Free Tier) — offline monthly dollar exports and attribution rollups.
 * (c) 2026 Motherboard, Inc. Source-available under the ToggleLogic Free-Tier
 * License (see LICENSE); all rights reserved.
 * PATENT PENDING.
 */
import { readLedger, monthBounds } from "./ledger-reader.js";
import { deriveLineage, billingFields, classifyLedgerCall, dollarsToMicros, microsToDollars } from "./ledger-row.js";

export const EXPORT_LICENSE = [
  "ToggleLogic (Free Tier) — cost ledger export.",
  "(c) 2026 Motherboard, Inc. Source-available under the ToggleLogic Free-Tier",
  "License (see LICENSE); all rights reserved.", "PATENT PENDING.",
];
const FIELDS = ["ts", "kind", "deploymentId", "costCenter", "provider", "model", "resolvedRef",
  "lineage", "lineageReason", "inputTok", "outputTok", "cacheTok", "cacheReadTok", "cacheWriteTok",
  "costUsd", "priceSource", "priceVersion", "unpriced", "usageMissing", "requestId", "billable",
  "invoiceEligible", "invoiceEligibleReason"];
const TOTALS = ["calls", "pricedUsd", "unpricedCalls", "usageMissingCalls", "billableUsd"];
const GROUP = ["deploymentId", "provider", "lineage"];
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const count = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;

function exportRow(row) {
  const state = classifyLedgerCall(row);
  const billableDeployment = row.billable !== false;
  const billing = billingFields({ priced: !state.unpriced, usageMissing: state.usageMissing, billableDeployment });
  const lineage = deriveLineage(row.resolvedRef);
  // A future reconciler may promote this field. Export never promotes it.
  if (row.invoiceEligible === true) { billing.invoiceEligible = true; billing.invoiceEligibleReason = null; }
  const complete = {
    ...row, ts: new Date(row.ts).toISOString(), kind: "call",
    lineage: row.lineage ?? lineage.lineage, lineageReason: row.lineage ? null : lineage.lineageReason,
    inputTok: count(row.inputTok), outputTok: count(row.outputTok),
    cacheReadTok: count(row.cacheReadTok), cacheWriteTok: count(row.cacheWriteTok),
    cacheTok: count(row.cacheTok ?? count(row.cacheReadTok) + count(row.cacheWriteTok)),
    costUsd: state.priced ? row.costUsd : null, unpriced: state.unpriced, usageMissing: state.usageMissing,
    ...billing,
  };
  // Fixed export columns exclude any accidental provider error/credential fields.
  return Object.fromEntries(FIELDS.map((field) => [field, complete[field] ?? null]));
}

function accumulator() { return { calls: 0, pricedMicros: 0, unpricedCalls: 0, usageMissingCalls: 0, billableMicros: 0 }; }
function add(total, row) {
  total.calls++;
  if (row.unpriced) total.unpricedCalls++;
  if (row.usageMissing) total.usageMissingCalls++;
  if (row.costUsd !== null) {
    total.pricedMicros += dollarsToMicros(row.costUsd);
    if (row.billable) total.billableMicros += dollarsToMicros(row.costUsd);
  }
}
function totals(total) {
  return { calls: total.calls, pricedUsd: microsToDollars(total.pricedMicros),
    unpricedCalls: total.unpricedCalls, usageMissingCalls: total.usageMissingCalls,
    billableUsd: microsToDollars(total.billableMicros) };
}

export async function exportLedger({ month, ledgerPath }) {
  const bounds = monthBounds(month), rows = [], groups = new Map(), all = accumulator();
  const diagnostics = await readLedger(ledgerPath, (raw) => {
    const ts = new Date(raw.ts).toISOString();
    if (ts < bounds.startInclusive || ts >= bounds.endExclusive) return;
    const row = exportRow(raw);
    rows.push(row); add(all, row);
    const key = JSON.stringify(GROUP.map((field) => row[field]));
    if (!groups.has(key)) groups.set(key, { identity: Object.fromEntries(GROUP.map((field) => [field, row[field]])), total: accumulator() });
    add(groups.get(key).total, row);
  });
  rows.sort((a, b) => compare(a.ts, b.ts) || compare(JSON.stringify(a), JSON.stringify(b)));
  return {
    license: EXPORT_LICENSE,
    schema: "togglelogic.cost-export.v1", month, timezone: "UTC", ...bounds,
    basis: "public-rate-estimates; priced spend excludes unpriced and usage-missing calls",
    scope: "retained ledger files only; older rotations may have expired",
    diagnostics,
    incomplete: all.unpricedCalls > 0 || all.usageMissingCalls > 0 ||
      diagnostics.malformedRows > 0 || diagnostics.invalidTimestampRows > 0 || diagnostics.filesRead === 0,
    rows,
    rollup: [...groups].sort(([a], [b]) => compare(a, b)).map(([, group]) => ({ ...group.identity, ...totals(group.total) })),
    totals: totals(all),
  };
}

function csvCell(value) {
  if (value === null || value === undefined) return "";
  let text = String(value);
  if (typeof value === "string" && /^[=+\-@\t\r]/.test(text)) text = "'" + text;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
const csvRow = (values) => values.map(csvCell).join(",");
export function formatExport(report, format = "json") {
  if (format === "json") return JSON.stringify(report, null, 2) + "\n";
  if (format !== "csv") throw new Error("Format must be csv or json");
  const lines = [
    ...EXPORT_LICENSE.map((line) => "# " + line),
    `# month=${report.month}; timezone=UTC; startInclusive=${report.startInclusive}; endExclusive=${report.endExclusive}`,
    `# ${report.basis}`, `# ${report.scope}`,
    `# incomplete=${report.incomplete}; filesRead=${report.diagnostics.filesRead}; malformedRows=${report.diagnostics.malformedRows}; invalidTimestampRows=${report.diagnostics.invalidTimestampRows}`,
    "# rows", csvRow(FIELDS), ...report.rows.map((row) => csvRow(FIELDS.map((field) => row[field]))),
    "# rollup (dollars)", csvRow([...GROUP, ...TOTALS]),
    ...report.rollup.map((row) => csvRow([...GROUP, ...TOTALS].map((field) => row[field]))),
    "# totals (dollars)", csvRow(TOTALS), csvRow(TOTALS.map((field) => report.totals[field])),
  ];
  return lines.join("\n") + "\n";
}
