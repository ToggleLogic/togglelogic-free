/*
 * ToggleLogic (Free Tier) — owner opt-in invoice eligibility for public-rate estimates.
 * (c) 2026 Motherboard, Inc. Source-available under the ToggleLogic Free-Tier
 * License (see LICENSE); all rights reserved.
 * PATENT PENDING.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { billingFields } from "../src/usage/ledger-row.js";
import { normalizeConfig } from "../src/config/normalize.js";
import { exportLedger } from "../src/usage/cost-export.js";

test("default stays 2.1.5 behavior: no row is invoice-eligible without the owner opt-in", () => {
  assert.deepEqual(billingFields({ priced: true, usageMissing: false }),
    { billable: true, invoiceEligible: false, invoiceEligibleReason: "public-rate-estimate" });
  assert.equal(normalizeConfig({}).costVisibility.attribution.invoiceEstimates, false);
  assert.equal(normalizeConfig({ costVisibility: { attribution: { invoiceEstimates: "yes" } } })
    .costVisibility.attribution.invoiceEstimates, false, "only literal true opts in");
});

test("opt-in: priced, usage-complete, billable rows are eligible and labeled public-rate-estimate", () => {
  assert.equal(normalizeConfig({ costVisibility: { attribution: { invoiceEstimates: true } } })
    .costVisibility.attribution.invoiceEstimates, true);
  assert.deepEqual(billingFields({ priced: true, usageMissing: false, invoiceEstimates: true }),
    { billable: true, invoiceEligible: true, invoiceEligibleReason: "public-rate-estimate" });
});

test("opt-in never makes unpriced, usage-missing or non-billable rows eligible (loud, not $0)", () => {
  for (const [args, reason] of [
    [{ priced: false, usageMissing: false }, "unpriced"],
    [{ priced: true, usageMissing: true }, "usage-missing"],
    [{ priced: true, usageMissing: false, billableDeployment: false }, "not-billable-deployment"],
  ]) {
    const row = billingFields({ ...args, invoiceEstimates: true });
    assert.equal(row.invoiceEligible, false, reason);
    assert.equal(row.billable, false, reason);
    assert.equal(row.invoiceEligibleReason, reason);
  }
});

test("export keeps an opted-in estimate row eligible with its label, drops eligibility on a non-billable row", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tl-invoice-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const ledgerPath = path.join(dir, "cost.jsonl");
  const base = { kind: "call", deploymentId: "deployment-a", costCenter: "team", provider: "example",
    model: "model-v1", resolvedRef: "example/model-v1", inputTok: 10, outputTok: 5,
    priceSource: "models.dev", priceVersion: 1 };
  const rows = [
    { ...base, ts: "2026-11-01T00:00:00Z", costUsd: 0.25, requestId: "r1",
      invoiceEligible: true, invoiceEligibleReason: "public-rate-estimate" },
    { ...base, ts: "2026-11-02T00:00:00Z", costUsd: 0.1, requestId: "r2", invoiceEligible: true, invoiceEligibleReason: null },
    { ...base, ts: "2026-11-03T00:00:00Z", costUsd: 0.5, requestId: "r3", billable: false,
      invoiceEligible: true, invoiceEligibleReason: "public-rate-estimate" },
  ];
  await fs.writeFile(ledgerPath, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  const report = await exportLedger({ ledgerPath, month: "2026-11" });
  const byId = Object.fromEntries(report.rows.map((row) => [row.requestId, row]));
  assert.deepEqual([byId.r1.invoiceEligible, byId.r1.invoiceEligibleReason], [true, "public-rate-estimate"]);
  assert.deepEqual([byId.r2.invoiceEligible, byId.r2.invoiceEligibleReason], [true, null], "reconciled row unchanged");
  assert.deepEqual([byId.r3.invoiceEligible, byId.r3.invoiceEligibleReason], [false, "not-billable-deployment"]);
  for (const row of report.rows) assert.ok(row.requestId, "TL-2: every exported call carries a requestId");
});

test("observer writes the opted-in eligibility into the ledger row; only priced, usage-complete, billable rows qualify", async () => {
  const { createCostObserver } = await import("../src/usage/cost-observer.js");
  for (const priced of [true, false]) for (const present of [true, false]) for (const billable of [true, false]) {
    const rows = [];
    const observer = createCostObserver({ config: normalizeConfig({ costVisibility: {
      attribution: { deploymentId: "deployment", costCenter: "team", billable, invoiceEstimates: true }, log: { enabled: false } } }),
      deps: { logger: { write: async (row) => rows.push(JSON.parse(JSON.stringify(row))) },
        eventLogger: { write: async () => {} },
        pricing: { resolve: async () => ({ priced, source: priced ? "models.dev" : null, priceVersion: priced ? 1 : null }),
          costUsd: () => 0.02 } } });
    await observer.handler({ provider: "example", model: "model-v2", usage: present ? { input: 2, output: 1 } : {} });
    await observer.budgets.flush();
    const expected = priced && present && billable;
    assert.equal(rows[0].invoiceEligible, expected, JSON.stringify({ priced, present, billable }));
    if (expected) assert.equal(rows[0].invoiceEligibleReason, "public-rate-estimate");
  }
});
