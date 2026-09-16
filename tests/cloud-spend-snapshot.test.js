import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildSpendSnapshotFromUsageCost,
  loadSpendSnapshot,
  applyCostLogDelta,
  computeSpendFingerprint,
  resolvePolicyMonth,
  isLocalRef,
  providerTokenOf,
  SPEND_SNAPSHOT_SCHEMA_VERSION,
  SPEND_SNAPSHOT_KIND,
  SPEND_SNAPSHOT_SOURCE,
} from "../src/usage/spend-snapshot.js";
import { createSpendProvider, CLOUD_BUDGET_EXHAUSTED_SENTINEL } from "../src/usage/spend-provider.js";

// Sept-like usage-cost dump: two September cloud days + one August day (ignored),
// with LOCAL Ollama missing-cost rows that must NOT fail the snapshot. updatedAt is
// mid-September so the derived policy month is 2026-09.
const SEPT_UPDATED_AT = Date.parse("2026-09-16T00:26:07.562Z");
function usageFixture(overrides = {}) {
  return {
    updatedAt: SEPT_UPDATED_AT,
    days: 30,
    daily: [
      { date: "2026-08-31", totalCost: 5.5, missingCostEntries: 0 },
      { date: "2026-09-13", totalCost: 10.0, missingCostEntries: 15, missingCostByModel: { "ollama/glm4:9b": 15 } },
      { date: "2026-09-14", totalCost: 13.1264, missingCostEntries: 21, missingCostByModel: { "ollama/glm4:9b": 21 } },
    ],
    totals: { totalCost: 202.03, missingCostEntries: 36, missingCostByModel: { "ollama/glm4:9b": 36 } },
    ...overrides,
  };
}

const BUILD_OPTS = {
  generatedAtMs: SEPT_UPDATED_AT + 60_000,
  timezone: "America/New_York",
  pluginFree: "1.6.1-rc.3",
  pluginIntelligence: "1.4.1-rc.3",
  localProviders: ["ollama"],
};

test("providerTokenOf / isLocalRef classify local vs cloud refs", () => {
  assert.equal(providerTokenOf("ollama/glm4:9b"), "ollama");
  assert.equal(providerTokenOf("anthropic/claude-sonnet-5"), "anthropic");
  assert.equal(providerTokenOf("bare-model-no-provider"), "");
  assert.equal(isLocalRef("ollama/glm4:9b", ["ollama"]), true);
  assert.equal(isLocalRef("anthropic/claude-sonnet-5", ["ollama"]), false);
  // Unknown provenance (no provider prefix) is treated as CLOUD (fail-closed side).
  assert.equal(isLocalRef("bare-model", ["ollama"]), false);
  assert.equal(isLocalRef("lmstudio/x", ["ollama", "lmstudio"]), true);
});

test("resolvePolicyMonth honors the IANA timezone at the month boundary", () => {
  // 2026-10-01T02:00Z is still 2026-09-30 in America/New_York (UTC-4) → month 2026-09.
  const ms = Date.parse("2026-10-01T02:00:00Z");
  assert.equal(resolvePolicyMonth(ms, "America/New_York"), "2026-09");
  assert.equal(resolvePolicyMonth(ms, "UTC"), "2026-10");
});

test("builder sums CURRENT-month cloud spend and tolerates LOCAL missing costs", () => {
  const built = buildSpendSnapshotFromUsageCost(usageFixture(), BUILD_OPTS);
  assert.equal(built.ok, true, JSON.stringify(built.errors));
  // 10.0 + 13.1264 (Sept only; August 5.5 excluded).
  assert.equal(built.snapshot.month_to_date_cost_usd, 23.1264);
  assert.equal(built.snapshot.policy_month, "2026-09");
  assert.equal(built.snapshot.days_counted, 2);
  assert.equal(built.snapshot.cloud_missing_cost_entries, 0);
  assert.equal(built.snapshot.local_missing_cost_entries, 36);
  assert.equal(built.snapshot.through_ms, SEPT_UPDATED_AT);
  assert.equal(built.snapshot.plugin_pair.free, "1.6.1-rc.3");
  assert.equal(built.snapshot.fingerprint, computeSpendFingerprint(built.snapshot));
  assert.equal(built.snapshot.kind, SPEND_SNAPSHOT_KIND);
  assert.equal(built.snapshot.source, SPEND_SNAPSHOT_SOURCE);
});

test("builder FAILS CLOSED on unpriced CLOUD missing-cost rows", () => {
  const usage = usageFixture();
  usage.daily[2].missingCostByModel = { "ollama/glm4:9b": 21, "anthropic/claude-sonnet-5": 3 };
  const built = buildSpendSnapshotFromUsageCost(usage, BUILD_OPTS);
  assert.equal(built.ok, false);
  assert.match(built.errors.join(" "), /unpriced CLOUD spend/);
  assert.match(built.errors.join(" "), /claude-sonnet-5/);
});

test("builder FAILS CLOSED on unattributable missing cost (count but no by-model)", () => {
  const usage = usageFixture();
  usage.daily[1] = { date: "2026-09-13", totalCost: 10.0, missingCostEntries: 4 }; // no missingCostByModel
  const built = buildSpendSnapshotFromUsageCost(usage, BUILD_OPTS);
  assert.equal(built.ok, false);
  assert.match(built.errors.join(" "), /unpriced CLOUD spend/);
});

test("builder FAILS CLOSED on negative or non-finite day totals", () => {
  const neg = buildSpendSnapshotFromUsageCost(
    usageFixture({ daily: [{ date: "2026-09-14", totalCost: -1, missingCostEntries: 0 }] }), BUILD_OPTS);
  assert.equal(neg.ok, false);
  assert.match(neg.errors.join(" "), /negative/);

  const nan = buildSpendSnapshotFromUsageCost(
    usageFixture({ daily: [{ date: "2026-09-14", totalCost: "oops", missingCostEntries: 0 }] }), BUILD_OPTS);
  assert.equal(nan.ok, false);
  assert.match(nan.errors.join(" "), /non-finite/);
});

test("builder FAILS CLOSED on a stale/wrong-month source (updatedAt month != policy month)", () => {
  // updatedAt is in July but we pin the policy month to September.
  const usage = usageFixture({ updatedAt: Date.parse("2026-07-15T12:00:00Z") });
  const built = buildSpendSnapshotFromUsageCost(usage, { ...BUILD_OPTS, policyMonth: "2026-09" });
  assert.equal(built.ok, false);
  assert.match(built.errors.join(" "), /wrong-month|!= policy month/);
});

test("builder FAILS CLOSED on missing updatedAt / daily", () => {
  assert.equal(buildSpendSnapshotFromUsageCost({ daily: [] }, BUILD_OPTS).ok, false);
  assert.equal(buildSpendSnapshotFromUsageCost({ updatedAt: SEPT_UPDATED_AT }, BUILD_OPTS).ok, false);
  assert.equal(buildSpendSnapshotFromUsageCost(null, BUILD_OPTS).ok, false);
});

test("round-trip build -> load verifies and returns the month-to-date total", () => {
  const built = buildSpendSnapshotFromUsageCost(usageFixture(), BUILD_OPTS);
  const load = loadSpendSnapshot({
    snapshot: built.snapshot,
    expectedPluginFree: "1.6.1-rc.3",
    expectedPolicyMonth: "2026-09",
    maxAgeMs: 26 * 3_600_000,
    nowMs: BUILD_OPTS.generatedAtMs + 3_600_000,
  });
  assert.equal(load.ok, true, JSON.stringify(load.errors));
  assert.equal(load.monthToDateCostUsd, 23.1264);
  assert.equal(load.policyMonth, "2026-09");
  assert.equal(load.throughMs, SEPT_UPDATED_AT);
});

test("loader FAILS CLOSED on wrong schema/kind/source", () => {
  const built = buildSpendSnapshotFromUsageCost(usageFixture(), BUILD_OPTS);
  for (const mutate of [
    (s) => { s.schema_version = 99; },
    (s) => { s.kind = "something-else"; },
    (s) => { s.source = "not the authoritative command"; },
  ]) {
    const snap = JSON.parse(JSON.stringify(built.snapshot));
    mutate(snap);
    snap.fingerprint = computeSpendFingerprint(snap); // re-sign so we test the field check, not drift
    const load = loadSpendSnapshot({ snapshot: snap, expectedPluginFree: "1.6.1-rc.3", expectedPolicyMonth: "2026-09", nowMs: BUILD_OPTS.generatedAtMs });
    assert.equal(load.ok, false);
  }
});

test("loader FAILS CLOSED on wrong plugin pair and wrong policy month", () => {
  const built = buildSpendSnapshotFromUsageCost(usageFixture(), BUILD_OPTS);
  const wrongFree = loadSpendSnapshot({ snapshot: built.snapshot, expectedPluginFree: "9.9.9", expectedPolicyMonth: "2026-09", nowMs: BUILD_OPTS.generatedAtMs });
  assert.equal(wrongFree.ok, false);
  assert.match(wrongFree.errors.join(" "), /Free version/);

  const wrongMonth = loadSpendSnapshot({ snapshot: built.snapshot, expectedPluginFree: "1.6.1-rc.3", expectedPolicyMonth: "2026-10", nowMs: BUILD_OPTS.generatedAtMs });
  assert.equal(wrongMonth.ok, false);
  assert.match(wrongMonth.errors.join(" "), /wrong-month|!= current policy month/);
});

test("loader FAILS CLOSED on stale and future snapshots", () => {
  const built = buildSpendSnapshotFromUsageCost(usageFixture(), BUILD_OPTS);
  const stale = loadSpendSnapshot({ snapshot: built.snapshot, expectedPluginFree: "1.6.1-rc.3", expectedPolicyMonth: "2026-09", maxAgeMs: 26 * 3_600_000, nowMs: BUILD_OPTS.generatedAtMs + 48 * 3_600_000 });
  assert.equal(stale.ok, false);
  assert.equal(stale.stale, true);
  assert.match(stale.errors.join(" "), /stale/);

  const future = loadSpendSnapshot({ snapshot: built.snapshot, expectedPluginFree: "1.6.1-rc.3", expectedPolicyMonth: "2026-09", nowMs: BUILD_OPTS.generatedAtMs - 3_600_000 });
  assert.equal(future.ok, false);
  assert.match(future.errors.join(" "), /future/);
});

test("loader FAILS CLOSED on fingerprint tamper (edited dollar amount)", () => {
  const built = buildSpendSnapshotFromUsageCost(usageFixture(), BUILD_OPTS);
  const tampered = JSON.parse(JSON.stringify(built.snapshot));
  tampered.month_to_date_cost_usd = 1.0; // liar: understate spend, keep old fingerprint
  const load = loadSpendSnapshot({ snapshot: tampered, expectedPluginFree: "1.6.1-rc.3", expectedPolicyMonth: "2026-09", nowMs: BUILD_OPTS.generatedAtMs });
  assert.equal(load.ok, false);
  assert.match(load.errors.join(" "), /fingerprint/);
});

test("loader FAILS CLOSED on a hand-planted cloud missing-cost count", () => {
  const built = buildSpendSnapshotFromUsageCost(usageFixture(), BUILD_OPTS);
  const snap = JSON.parse(JSON.stringify(built.snapshot));
  snap.cloud_missing_cost_entries = 2;
  snap.fingerprint = computeSpendFingerprint(snap); // re-sign: test the explicit field check
  const load = loadSpendSnapshot({ snapshot: snap, expectedPluginFree: "1.6.1-rc.3", expectedPolicyMonth: "2026-09", nowMs: BUILD_OPTS.generatedAtMs });
  assert.equal(load.ok, false);
  assert.match(load.errors.join(" "), /unpriced CLOUD/);
});

test("loader FAILS CLOSED on a missing snapshot file (never ran the generator)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tl-spend-"));
  const load = loadSpendSnapshot({ snapshotPath: path.join(dir, "does-not-exist.json"), expectedPluginFree: "1.6.1-rc.3", expectedPolicyMonth: "2026-09" });
  assert.equal(load.ok, false);
  assert.match(load.errors.join(" "), /could not read/);
});

test("applyCostLogDelta adds ONLY post-through cloud rows in the policy month, no double-price", () => {
  const built = buildSpendSnapshotFromUsageCost(usageFixture(), BUILD_OPTS);
  const load = loadSpendSnapshot({ snapshot: built.snapshot, expectedPluginFree: "1.6.1-rc.3", expectedPolicyMonth: "2026-09", nowMs: BUILD_OPTS.generatedAtMs });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tl-spend-delta-"));
  const logPath = path.join(dir, "cost.jsonl");
  const before = new Date(SEPT_UPDATED_AT - 60_000).toISOString();     // already in snapshot
  const after1 = new Date(SEPT_UPDATED_AT + 60_000).toISOString();     // counts
  const after2 = new Date(SEPT_UPDATED_AT + 120_000).toISOString();    // counts
  const otherMonth = new Date(Date.parse("2026-10-02T12:00:00Z")).toISOString();
  const rows = [
    { schema: "togglelogic.fleet-usage.v1", kind: "call", ts: before, resolvedRef: "anthropic/claude-sonnet-5", costUsd: 99 },
    { schema: "togglelogic.fleet-usage.v1", kind: "call", ts: after1, resolvedRef: "anthropic/claude-sonnet-5", costUsd: 0.5 },
    { schema: "togglelogic.fleet-usage.v1", kind: "call", ts: after2, provider: "openai", model: "gpt-5", costUsd: 0.25 },
    { schema: "togglelogic.fleet-usage.v1", kind: "call", ts: after2, resolvedRef: "ollama/glm4:9b", costUsd: 0 },   // local: skip
    { schema: "togglelogic.fleet-usage.v1", kind: "call", ts: otherMonth, resolvedRef: "anthropic/claude-sonnet-5", costUsd: 7 }, // other month: skip
    { schema: "togglelogic.fleet-usage.v1", kind: "summary", ts: after2 }, // not a call: skip
  ];
  fs.writeFileSync(logPath, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const delta = applyCostLogDelta(load, { costLogPath: logPath, policyMonth: "2026-09", timezone: "America/New_York", localProviders: ["ollama"] });
  assert.equal(delta.deltaApplied, true);
  assert.equal(delta.complete, true);
  assert.equal(delta.failClosed, false);
  assert.equal(delta.deltaRows, 2);
  assert.equal(delta.deltaUsd, 0.75);
  assert.equal(delta.monthToDateCostUsd, 23.8764);
});

test("applyCostLogDelta returns base unchanged (and COMPLETE) when the cost log is absent", () => {
  const built = buildSpendSnapshotFromUsageCost(usageFixture(), BUILD_OPTS);
  const load = loadSpendSnapshot({ snapshot: built.snapshot, expectedPluginFree: "1.6.1-rc.3", expectedPolicyMonth: "2026-09", nowMs: BUILD_OPTS.generatedAtMs });
  const delta = applyCostLogDelta(load, { costLogPath: path.join(os.tmpdir(), "tl-nope-" + Math.random().toString(16).slice(2), "cost.jsonl") });
  assert.equal(delta.monthToDateCostUsd, 23.1264);
  assert.equal(delta.deltaApplied, false);
  assert.equal(delta.complete, true, "an absent ledger means no post-through rows — base is complete");
  assert.equal(delta.failClosed, false);
  assert.match(delta.note, /absent/);
});

// ---- delta FAIL-CLOSED matrix (Blocker 5): the delta must never trust the base
// total when it cannot PROVE it counted every post-through cloud row. ----

function deltaHarness(rows, { maxBytes, localProviders = ["ollama"], deps } = {}) {
  const built = buildSpendSnapshotFromUsageCost(usageFixture(), BUILD_OPTS);
  const load = loadSpendSnapshot({ snapshot: built.snapshot, expectedPluginFree: "1.6.1-rc.3", expectedPolicyMonth: "2026-09", nowMs: BUILD_OPTS.generatedAtMs });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tl-delta-fc-"));
  const logPath = path.join(dir, "cost.jsonl");
  fs.writeFileSync(logPath, rows.map((r) => (typeof r === "string" ? r : JSON.stringify(r))).join("\n") + "\n");
  return applyCostLogDelta(load, { costLogPath: logPath, policyMonth: "2026-09", timezone: "America/New_York", localProviders, ...(maxBytes ? { maxBytes } : {}), ...(deps ? { deps } : {}) });
}
const AFTER = new Date(SEPT_UPDATED_AT + 60_000).toISOString();
const BEFORE = new Date(SEPT_UPDATED_AT - 60_000).toISOString();

test("delta FAILS CLOSED on a post-through CLOUD call lacking a finite cost (no silent skip)", () => {
  const d = deltaHarness([
    { kind: "call", ts: AFTER, resolvedRef: "anthropic/claude-sonnet-5", costUsd: 0.5 },
    { kind: "call", ts: AFTER, resolvedRef: "anthropic/claude-opus-4-8", unpriced: true }, // no costUsd
  ]);
  assert.equal(d.failClosed, true);
  assert.equal(d.deltaApplied, false);
  assert.equal(d.reason, "cost_log_unpriced_cloud");
});

test("delta FAILS CLOSED on a post-through call row with unknown provider provenance", () => {
  const d = deltaHarness([
    { kind: "call", ts: AFTER, model: "mystery-model", costUsd: 0.5 }, // no provider prefix → unknown provenance
  ]);
  assert.equal(d.failClosed, true);
  assert.equal(d.reason, "cost_log_unknown_provenance");
});

test("delta FAILS CLOSED on an unparseable (non-partial) row that could conceal post-through spend", () => {
  const d = deltaHarness([
    { kind: "call", ts: BEFORE, resolvedRef: "anthropic/claude-sonnet-5", costUsd: 1 },
    "{ this is not valid json",
    { kind: "call", ts: AFTER, resolvedRef: "anthropic/claude-sonnet-5", costUsd: 0.5 },
  ]);
  assert.equal(d.failClosed, true);
  assert.equal(d.reason, "cost_log_unparseable_row");
});

test("delta FAILS CLOSED on a call row with no parseable timestamp (cannot bound it)", () => {
  const d = deltaHarness([
    { kind: "call", ts: "not-a-date", resolvedRef: "anthropic/claude-sonnet-5", costUsd: 0.5 },
  ]);
  assert.equal(d.failClosed, true);
  assert.equal(d.reason, "cost_log_call_missing_ts");
});

test("delta FAILS CLOSED when a too-large ledger tail cannot prove it reaches back to through_ms", () => {
  // Every parsed row is AFTER through_ms and the file exceeds maxBytes → the tail
  // cannot prove it captured the FIRST post-through row → fail closed (no tail-skip).
  const filler = [];
  for (let i = 0; i < 400; i += 1) filler.push({ kind: "call", ts: AFTER, resolvedRef: "anthropic/claude-sonnet-5", costUsd: 0.001 });
  const d = deltaHarness(filler, { maxBytes: 8192 }); // file (~40KB) far exceeds the tail window
  assert.equal(d.failClosed, true);
  assert.equal(d.reason, "cost_log_tail_incomplete");
});

test("delta APPLIES on a too-large ledger when the tail DOES reach back to through_ms (completeness proven)", () => {
  // A row at/before through_ms inside the tail window proves every post-through row
  // is captured. The leading (truncated) partial line is tolerated.
  const rows = [];
  for (let i = 0; i < 300; i += 1) rows.push({ kind: "call", ts: BEFORE, resolvedRef: "anthropic/claude-sonnet-5", costUsd: 0.001 }); // pre-through padding
  rows.push({ kind: "call", ts: AFTER, resolvedRef: "anthropic/claude-sonnet-5", costUsd: 0.5 });
  const d = deltaHarness(rows, { maxBytes: 16384 });
  assert.equal(d.failClosed, false);
  assert.equal(d.complete, true);
  assert.equal(d.deltaRows, 1);
  assert.equal(d.deltaUsd, 0.5);
});

test("delta FAILS CLOSED when the ledger is unreadable (I/O error, not merely absent)", () => {
  const built = buildSpendSnapshotFromUsageCost(usageFixture(), BUILD_OPTS);
  const load = loadSpendSnapshot({ snapshot: built.snapshot, expectedPluginFree: "1.6.1-rc.3", expectedPolicyMonth: "2026-09", nowMs: BUILD_OPTS.generatedAtMs });
  const deps = { statSync: () => { const e = new Error("EACCES"); e.code = "EACCES"; throw e; } };
  const d = applyCostLogDelta(load, { costLogPath: "/some/unreadable/cost.jsonl", policyMonth: "2026-09", timezone: "America/New_York", localProviders: ["ollama"], deps });
  assert.equal(d.failClosed, true);
  assert.equal(d.reason, "cost_log_unreadable");
});

test("delta: a local post-through row is $0 marginal ONLY when its provider is in the configured local set", () => {
  // With ollama configured local, the row is skipped and the delta is clean.
  const local = deltaHarness([{ kind: "call", ts: AFTER, resolvedRef: "ollama/glm4:9b", costUsd: 0 }], { localProviders: ["ollama"] });
  assert.equal(local.failClosed, false);
  assert.equal(local.deltaRows, 0);
  // With ollama NOT in the configured local set, the same row is CLOUD; unpriced → fail closed.
  const notLocal = deltaHarness([{ kind: "call", ts: AFTER, resolvedRef: "ollama/glm4:9b", unpriced: true }], { localProviders: ["lmstudio"] });
  assert.equal(notLocal.failClosed, true);
  assert.equal(notLocal.reason, "cost_log_unpriced_cloud");
});

// ---- missing-cost attribution reconciliation (Blocker 4) ----

test("builder FAILS CLOSED when missingCostByModel does not sum to missingCostEntries (deficit)", () => {
  const usage = usageFixture();
  // 10 entries missing but only 1 attributed to a local model — the other 9 are unexplained.
  usage.daily[1] = { date: "2026-09-13", totalCost: 10.0, missingCostEntries: 10, missingCostByModel: { "ollama/glm4:9b": 1 } };
  const built = buildSpendSnapshotFromUsageCost(usage, BUILD_OPTS);
  assert.equal(built.ok, false);
  assert.match(built.errors.join(" "), /does not reconcile/);
  assert.match(built.errors.join(" "), /unpriced CLOUD/); // the 9 unexplained entries are charged to cloud
});

test("builder FAILS CLOSED on a surplus attribution (sum > entries)", () => {
  const usage = usageFixture();
  usage.daily[1] = { date: "2026-09-13", totalCost: 10.0, missingCostEntries: 15, missingCostByModel: { "ollama/glm4:9b": 20 } };
  const built = buildSpendSnapshotFromUsageCost(usage, BUILD_OPTS);
  assert.equal(built.ok, false);
  assert.match(built.errors.join(" "), /does not reconcile/);
});

test("builder FAILS CLOSED on a negative/fractional/malformed missing-cost count", () => {
  for (const bad of [{ "ollama/x": -1 }, { "ollama/x": 1.5 }, { "ollama/x": "15" }]) {
    const usage = usageFixture();
    usage.daily[1] = { date: "2026-09-13", totalCost: 10.0, missingCostEntries: 15, missingCostByModel: bad };
    const built = buildSpendSnapshotFromUsageCost(usage, BUILD_OPTS);
    assert.equal(built.ok, false, `expected fail for ${JSON.stringify(bad)}`);
  }
});

test("builder FAILS CLOSED on a non-integer missingCostEntries", () => {
  const usage = usageFixture();
  usage.daily[1] = { date: "2026-09-13", totalCost: 10.0, missingCostEntries: 4.5, missingCostByModel: { "ollama/glm4:9b": 4.5 } };
  const built = buildSpendSnapshotFromUsageCost(usage, BUILD_OPTS);
  assert.equal(built.ok, false);
  assert.match(built.errors.join(" "), /nonnegative integer/);
});

test("builder ACCEPTS a fully-reconciled mixed-local attribution", () => {
  const usage = usageFixture();
  usage.daily[1] = { date: "2026-09-13", totalCost: 10.0, missingCostEntries: 5, missingCostByModel: { "ollama/glm4:9b": 3, "ollama/qwen2:7b": 2 } };
  const built = buildSpendSnapshotFromUsageCost(usage, BUILD_OPTS);
  assert.equal(built.ok, true, JSON.stringify(built.errors));
  assert.equal(built.snapshot.cloud_missing_cost_entries, 0);
  assert.equal(built.snapshot.local_missing_cost_entries, 5 + 21); // day1 (3+2) + day2 (21)
});

// ---- fingerprint binds all trust/freshness fields (Blocker 3) ----

test("fingerprint binds generated_at_ms — a hand-edit to bypass staleness now DRIFTS the fingerprint", () => {
  const built = buildSpendSnapshotFromUsageCost(usageFixture(), BUILD_OPTS);
  // Snapshot is genuinely stale (age > max). The attack: forge generated_at_ms to "now"
  // WITHOUT re-signing, hoping to pass the staleness check.
  const forged = JSON.parse(JSON.stringify(built.snapshot));
  const nowMs = BUILD_OPTS.generatedAtMs + 100 * 3_600_000;
  forged.generated_at_ms = nowMs; // fresh-looking, but fingerprint no longer matches
  const load = loadSpendSnapshot({ snapshot: forged, expectedPluginFree: "1.6.1-rc.3", expectedPolicyMonth: "2026-09", maxAgeMs: 26 * 3_600_000, nowMs });
  assert.equal(load.ok, false);
  assert.match(load.errors.join(" "), /fingerprint/);
});

test("fingerprint binds local_providers and local_missing_cost_by_model (tamper drifts the fingerprint)", () => {
  const built = buildSpendSnapshotFromUsageCost(usageFixture(), BUILD_OPTS);
  for (const mutate of [
    (s) => { s.local_providers = ["ollama", "anthropic"]; },     // widen local set to hide cloud spend
    (s) => { s.local_missing_cost_by_model = { "ollama/glm4:9b": 1 }; }, // rewrite attribution
    (s) => { s.generated_at = new Date(BUILD_OPTS.generatedAtMs + 5_000).toISOString(); },
  ]) {
    const snap = JSON.parse(JSON.stringify(built.snapshot));
    mutate(snap);
    const load = loadSpendSnapshot({ snapshot: snap, expectedPluginFree: "1.6.1-rc.3", expectedPolicyMonth: "2026-09", nowMs: BUILD_OPTS.generatedAtMs });
    assert.equal(load.ok, false);
    assert.match(load.errors.join(" "), /fingerprint/);
  }
});

test("loader FAILS CLOSED when snapshot local_providers != configured local providers (classification basis mismatch)", () => {
  const built = buildSpendSnapshotFromUsageCost(usageFixture(), BUILD_OPTS);
  // Valid snapshot built for ["ollama"], but the running config declares a different local set.
  const load = loadSpendSnapshot({ snapshot: built.snapshot, expectedPluginFree: "1.6.1-rc.3", expectedPolicyMonth: "2026-09", expectedLocalProviders: ["lmstudio"], nowMs: BUILD_OPTS.generatedAtMs });
  assert.equal(load.ok, false);
  assert.match(load.errors.join(" "), /classification basis mismatch|local_providers/);
});

test("loader PASSES when snapshot local_providers matches the configured set (order/case-insensitive)", () => {
  const built = buildSpendSnapshotFromUsageCost(usageFixture(), BUILD_OPTS);
  const load = loadSpendSnapshot({ snapshot: built.snapshot, expectedPluginFree: "1.6.1-rc.3", expectedPolicyMonth: "2026-09", expectedLocalProviders: ["OLLAMA"], nowMs: BUILD_OPTS.generatedAtMs });
  assert.equal(load.ok, true, JSON.stringify(load.errors));
});

// ---- spend provider ----

function writeSnapshot(dir, snapshot) {
  const p = path.join(dir, "cloud-spend.snapshot.json");
  fs.writeFileSync(p, JSON.stringify(snapshot, null, 2) + "\n");
  return p;
}

test("spend provider: disabled yields status 'disabled'", () => {
  const provider = createSpendProvider({ enabled: false });
  assert.equal(provider.current().status, "disabled");
});

test("spend provider: enabled + valid snapshot yields the live total", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tl-spend-prov-"));
  const built = buildSpendSnapshotFromUsageCost(usageFixture(), BUILD_OPTS);
  const snapshotPath = writeSnapshot(dir, built.snapshot);
  const provider = createSpendProvider(
    { enabled: true, snapshotPath, maxAgeHours: 26, timezone: "America/New_York", localProviders: ["ollama"], finiteCloudBudgetApplies: true, delta: { enabled: false } },
    { version: "1.6.1-rc.3", ownerTimezone: "America/New_York", nowFn: () => BUILD_OPTS.generatedAtMs + 3_600_000 },
  );
  const cur = provider.current();
  assert.equal(cur.status, "ok");
  assert.equal(cur.effectiveSpendUsd, 23.1264);
  assert.equal(cur.cloudSuppressed, false);
});

test("spend provider: unavailable snapshot + finite budget suppresses cloud (sentinel)", () => {
  const provider = createSpendProvider(
    { enabled: true, snapshotPath: path.join(os.tmpdir(), "nope-" + Math.random().toString(16).slice(2) + ".json"), finiteCloudBudgetApplies: true },
    { version: "1.6.1-rc.3", ownerTimezone: "America/New_York" },
  );
  const cur = provider.current();
  assert.equal(cur.status, "unavailable");
  assert.equal(cur.cloudSuppressed, true);
  assert.equal(cur.effectiveSpendUsd, CLOUD_BUDGET_EXHAUSTED_SENTINEL);
});

test("spend provider: unavailable snapshot + NO finite budget falls back to static (no suppression)", () => {
  const provider = createSpendProvider(
    { enabled: true, snapshotPath: path.join(os.tmpdir(), "nope-" + Math.random().toString(16).slice(2) + ".json"), finiteCloudBudgetApplies: false },
    { version: "1.6.1-rc.3", ownerTimezone: "America/New_York" },
  );
  const cur = provider.current();
  assert.equal(cur.status, "unavailable");
  assert.equal(cur.cloudSuppressed, false);
  assert.equal(cur.effectiveSpendUsd, null);
  assert.match(cur.reason, /static_fallback/);
});

test("spend provider: a stale snapshot with a finite budget also suppresses cloud", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tl-spend-stale-"));
  const built = buildSpendSnapshotFromUsageCost(usageFixture(), BUILD_OPTS);
  const snapshotPath = writeSnapshot(dir, built.snapshot);
  const provider = createSpendProvider(
    { enabled: true, snapshotPath, maxAgeHours: 26, timezone: "America/New_York", finiteCloudBudgetApplies: true },
    { version: "1.6.1-rc.3", ownerTimezone: "America/New_York", nowFn: () => BUILD_OPTS.generatedAtMs + 100 * 3_600_000 },
  );
  const cur = provider.current();
  assert.equal(cur.status, "unavailable");
  assert.equal(cur.stale, true);
  assert.equal(cur.cloudSuppressed, true);
});
