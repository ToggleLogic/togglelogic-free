/*
 * ToggleLogic (Free Tier) — persisted monthly budget threshold tests.
 * (c) 2026 Motherboard, Inc. Source-available under the ToggleLogic Free-Tier
 * License (see LICENSE); all rights reserved.
 * PATENT PENDING.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createCostObserver } from "../src/usage/cost-observer.js";
import { normalizeConfig } from "../src/config/normalize.js";

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tl-budget-"));
  const observers = [];
  t.after(async () => { for (const observer of observers) await observer.budgets.flush(); await fs.rm(dir, { recursive: true, force: true }); });
  let time = Date.parse("2026-09-28T12:00:00Z");
  const ledgerPath = path.join(dir, "cost.jsonl"), eventPath = path.join(dir, "events.jsonl");
  const audits = [];
  const config = normalizeConfig({ costVisibility: {
    attribution: { deploymentId: "deployment", costCenter: "team" },
    log: { path: ledgerPath }, events: { path: eventPath }, budgets: { monthlyUsd: 1 } } });
  function make(extra = {}) {
    const observer = createCostObserver({ config, audit: { emit: async (row) => audits.push(row) }, deps: {
      now: () => time, pricing: { resolve: async (ref) => ({ priced: ref !== "example/unknown", source: "test", priceVersion: "fixture" }),
        costUsd: (_price, usage) => usage.input / 100 }, ...extra } });
    observers.push(observer); return observer;
  }
  const call = async (observer, amount, model = "model-v1") => {
    await observer.handler({ provider: "example", model, usage: { input: amount * 100, output: 0 } });
    await observer.budgets.flush();
  };
  const events = async () => {
    try { return (await fs.readFile(eventPath, "utf8")).trim().split("\n").map(JSON.parse).filter((row) => row.event === "budget_threshold_crossed"); }
    catch (error) { if (error.code === "ENOENT") return []; throw error; }
  };
  return { config, make, call, events, audits, ledgerPath, eventPath, time: (value) => { time = Date.parse(value); } };
}

test("budget restores rotated ledger at startup, crosses once across restart, reports both incomplete buckets", async (t) => {
  const f = await fixture(t);
  const seed = (costUsd, extra = {}) => ({ kind: "call", ts: "2026-09-28T00:00:00Z", deploymentId: "deployment", costUsd, ...extra });
  await fs.writeFile(f.ledgerPath + ".1", [seed(0.4), seed(null, { unpriced: true }), seed(null, { usageMissing: true }),
    seed(50, { deploymentId: "other" }), { ...seed(50), kind: "summary" }].map(JSON.stringify).join("\n") + "\n");
  const first = f.make();
  // Queue immediately, while startup replay is still in progress.
  await f.call(first, 0.1);
  let events = await f.events();
  assert.equal(events.length, 1);
  assert.equal(events[0].thresholdPct, 50);
  assert.equal(events[0].spentUsd, 0.5);
  assert.equal(events[0].unpricedCalls, 1); assert.equal(events[0].usageMissingCalls, 1);
  assert.equal(events[0].monthlyUsd, 1); assert.equal(events[0].month, "2026-09");
  assert.equal(events[0].historyIncomplete, false);
  assert.equal(f.audits.filter((row) => row.event === "budget_threshold_crossed").length, 1);
  f.time("2026-09-29T12:00:00Z");
  const restarted = f.make(); await restarted.budgets.flush();
  assert.equal(restarted.budgets.snapshot().spentUsd, 0.5);
  assert.equal((await f.events()).length, 1, "same month's event is remembered across days and restart");
  await f.call(restarted, 0.3); await f.call(restarted, 0.2); await f.call(restarted, 0.01);
  events = await f.events();
  assert.deepEqual(events.map((row) => row.thresholdPct), [50, 80, 100]);
  assert.equal(restarted.budgets.snapshot().spentUsd, 1.01);
  const again = f.make(); await again.budgets.flush();
  assert.equal((await f.events()).length, 3);
});

test("UTC month rollover resets spend and each threshold may emit again", async (t) => {
  const f = await fixture(t), observer = f.make();
  f.time("2026-09-30T23:59:59Z"); await f.call(observer, 1);
  f.time("2026-10-01T00:00:00Z"); await f.call(observer, 0.49);
  assert.equal((await f.events()).length, 3);
  await f.call(observer, 0.01);
  assert.deepEqual((await f.events()).map((row) => [row.month, row.thresholdPct]),
    [["2026-09", 50], ["2026-09", 80], ["2026-09", 100], ["2026-10", 50]]);
  assert.equal(observer.budgets.snapshot().spentUsd, 0.5);
});

test("monthly budget uses all priced spend, including non-billable calls", async (t) => {
  const f = await fixture(t); f.config.costVisibility.attribution.billable = false;
  const observer = f.make(); await f.call(observer, 0.5);
  assert.equal((await f.events()).length, 1);
  assert.equal(JSON.parse((await fs.readFile(f.ledgerPath, "utf8")).trim()).billable, false);
});

test("budget replay errors are explicit and never prevent cost observation", async (t) => {
  const f = await fixture(t), warnings = [];
  await fs.writeFile(f.ledgerPath, 'incomplete json\n{"kind":"call","ts":"not-a-time"}\n');
  const observer = createCostObserver({ config: f.config, fallbackLogger: { warn: (message) => warnings.push(message) },
    deps: { pricing: { resolve: async () => ({ priced: true }), costUsd: () => 0.5 } } });
  await observer.handler({ provider: "example", model: "model", usage: { input: 1, output: 1 } });
  await observer.budgets.flush();
  assert.ok(warnings.some((message) => message.includes("incomplete")));
  assert.equal((await f.events())[0].historyIncomplete, true);
});

test("slow budget ledger writes do not delay the host turn", async (t) => {
  const f = await fixture(t), rows = [];
  const observer = f.make({ logger: { path: f.ledgerPath, write: async (row) => {
    await new Promise((resolve) => setTimeout(resolve, 500)); rows.push(row);
  } } });
  await observer.handler({ provider: "example", model: "model", usage: { input: 50, output: 0 } });
  assert.equal(rows.length, 0);
  await observer.budgets.flush();
  assert.equal(rows.length, 1); assert.equal((await f.events()).length, 1);
});

test("budget config defaults and threshold validation", () => {
  assert.deepEqual(normalizeConfig({}).costVisibility.budgets, { monthlyUsd: null, thresholdsPct: [50, 80, 100] });
  assert.deepEqual(normalizeConfig({ costVisibility: { budgets: { monthlyUsd: 20, thresholdsPct: [100, 50, 50, -1, "80", NaN] } } }).costVisibility.budgets,
    { monthlyUsd: 20, thresholdsPct: [50, 100] });
});
