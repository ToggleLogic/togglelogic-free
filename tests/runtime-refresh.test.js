import test from "node:test";
import assert from "node:assert/strict";

import { runRuntimeRefresh, checkCompatiblePair, checkSpendNonRegression, RUNTIME_REFRESH_SENTINEL_SCHEMA } from "../src/maintenance/runtime-refresh.js";

let clock = 1_000_000;
const now = () => (clock += 5);

test("runRuntimeRefresh: all stages ok yields a success sentinel", async () => {
  const ran = [];
  const s = await runRuntimeRefresh([
    { name: "a", run: () => { ran.push("a"); return { ok: true, detail: { x: 1 } }; } },
    { name: "b", run: async () => { ran.push("b"); return { ok: true }; } },
  ], { now });
  assert.equal(s.overall, "success");
  assert.equal(s.schema, RUNTIME_REFRESH_SENTINEL_SCHEMA);
  assert.deepEqual(ran, ["a", "b"]);
  assert.deepEqual(s.stages.map((r) => r.status), ["ok", "ok"]);
  assert.deepEqual(s.failed_stages, []);
});

test("runRuntimeRefresh: FAILS CLOSED — a failed stage skips the rest and cleans up", async () => {
  const ran = [];
  let cleanupOverall = null;
  const s = await runRuntimeRefresh([
    { name: "present", run: () => ({ ok: true }) },
    { name: "spend", run: () => { ran.push("spend"); return { ok: false, detail: { error: "unpriced cloud spend" } }; } },
    { name: "commit", run: () => { ran.push("commit"); return { ok: true }; } },
  ], { now, onCleanup: (overall) => { cleanupOverall = overall; } });
  assert.equal(s.overall, "failure");
  assert.deepEqual(s.failed_stages, ["spend"]);
  assert.deepEqual(ran, ["spend"]);                       // commit never ran (fail closed)
  assert.equal(s.stages.find((r) => r.name === "commit").status, "skipped");
  assert.equal(cleanupOverall, "failure");                // cleanup saw the failure
  assert.match(JSON.stringify(s.stages), /unpriced cloud spend/);
});

test("runRuntimeRefresh: a throwing stage is recorded failed, not propagated", async () => {
  const s = await runRuntimeRefresh([
    { name: "boom", run: () => { throw new Error("kaboom"); } },
  ], { now });
  assert.equal(s.overall, "failure");
  assert.equal(s.stages[0].status, "failed");
  assert.match(s.stages[0].detail.error, /kaboom/);
});

test("checkCompatiblePair: a validated rc pair passes", () => {
  const r = checkCompatiblePair("1.6.1-rc.3", {
    version: "1.4.1-rc.3",
    release_state: "release_candidate",
    plugin_compatibility: { validated_versions: ["1.6.1-rc.3"] },
  });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.intelligenceVersion, "1.4.1-rc.3");
});

test("checkCompatiblePair: FAILS on a free version not in validated_versions", () => {
  const r = checkCompatiblePair("1.6.1-rc.99", {
    version: "1.4.1-rc.3",
    release_state: "release_candidate",
    plugin_compatibility: { validated_versions: ["1.6.1-rc.3"] },
  });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(" "), /not in Intelligence validated_versions/);
});

test("checkCompatiblePair: FAILS on release-state mismatch (rc free vs released intelligence)", () => {
  const r = checkCompatiblePair("1.6.1-rc.3", {
    version: "1.4.1",
    release_state: "released",
    plugin_compatibility: { validated_versions: ["1.6.1-rc.3"] },
  });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(" "), /release-state mismatch/);
});

test("checkCompatiblePair: FAILS closed on a missing manifest", () => {
  const r = checkCompatiblePair("1.6.1-rc.3", null);
  assert.equal(r.ok, false);
  assert.match(r.errors.join(" "), /manifest is missing/);
});

test("checkSpendNonRegression rejects a transient same-month spend decrease", () => {
  const r = checkSpendNonRegression(
    { policy_month: "2026-09", month_to_date_cost_usd: 23.30 },
    { policy_month: "2026-09", month_to_date_cost_usd: 0 },
  );
  assert.equal(r.ok, false);
  assert.match(r.error, /regressed from 23\.3 to 0/);
});

test("checkSpendNonRegression permits growth and a new policy month", () => {
  assert.equal(checkSpendNonRegression(
    { policy_month: "2026-09", month_to_date_cost_usd: 23.30 },
    { policy_month: "2026-09", month_to_date_cost_usd: 23.31 },
  ).ok, true);
  assert.equal(checkSpendNonRegression(
    { policy_month: "2026-09", month_to_date_cost_usd: 23.30 },
    { policy_month: "2026-10", month_to_date_cost_usd: 0 },
  ).ok, true);
});
