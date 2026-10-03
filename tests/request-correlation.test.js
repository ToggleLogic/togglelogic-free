/*
 * ToggleLogic (Free Tier) — request-correlation unit tests (node --test, no deps).
 * (c) 2026 Motherboard, Inc. Source-available under the ToggleLogic Free Startup Commercial Use License 2.0.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequestCorrelation } from "../src/routing/request-correlation.js";
import { createInterceptor } from "../src/routing/interceptor.js";
import { createCostObserver } from "../src/usage/cost-observer.js";
import { createLogger } from "../src/observability/logger.js";
import { createAuditLogger } from "../src/audit/audit-logger.js";
import { normalizeConfig } from "../src/config/normalize.js";

const output = { provider: "example", model: "model", usage: { input: 100, output: 10 } };
const pricing = {
  async resolve() { return { provider: "example", priced: true, inputPerM: 1, outputPerM: 2 }; },
  costUsd() { return 0.00012; },
};
async function fixture(t, governedEscalation = null) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tl-correlation-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const config = normalizeConfig({ mode: "passthrough" });
  const log = (name) => ({ enabled: true, path: path.join(dir, name), rotateSizeMb: 1 });
  const routing = createLogger(log("routing.jsonl"));
  const audit = createAuditLogger(log("audit.jsonl"));
  const cost = createLogger(log("cost.jsonl"));
  const requestCorrelation = createRequestCorrelation();
  const route = createInterceptor({ config, logger: routing, audit, version: "test", requestCorrelation,
    seam: { status: () => "unavailable" }, governedEscalation });
  const observer = createCostObserver({ config, requestCorrelation, deps: { pricing, logger: cost } });
  const rows = async (logger) => { await logger.flush(); return (await fs.readFile(logger.path, "utf8")).trim().split("\n").map(JSON.parse); };
  return { route, observer, routing, audit, cost, rows };
}

test("one turn writes the same routing requestId, audit correlationId and cost requestId", async (t) => {
  const f = await fixture(t);
  await f.route({ prompt: "hello" }, { sessionKey: "session", runId: "run-a" });
  // Interleave a second run in the same session; the first run must retain its ID.
  await f.route({ prompt: "other" }, { sessionKey: "session", runId: "run-b" });
  await f.observer.handler({ ...output, runId: "run-a" }, { sessionKey: "session" });
  await f.observer.handler({ ...output, runId: "run-a" }, { sessionKey: "session" });
  const [routing] = await f.rows(f.routing);
  const audit = await f.rows(f.audit);
  const costs = await f.rows(f.cost);
  assert.ok(routing.requestId);
  assert.equal(audit.filter((row) => row.correlationId === routing.requestId).length, 2);
  assert.equal(costs.length, 2);
  for (const row of costs) assert.equal(row.requestId, routing.requestId);
});

test("missing identity, unmatched turns and summaries write null with a reason", async (t) => {
  const f = await fixture(t);
  await f.route({ prompt: "hello" }, { sessionKey: "session", runId: "old-run" });
  await f.observer.handler(output, { sessionKey: "session" });
  await f.observer.handler({ ...output, runId: "new-run" });
  // Existing pricing reasons remain intact alongside the correlation reason.
  await f.observer.handler({ ...output, usage: {} });
  f.observer.emitSummary();
  const rows = await f.rows(f.cost);
  assert.deepEqual(rows.map((row) => [row.requestId, row.requestIdReason]), [
    [null, "turn-identity-unavailable"],
    [null, "routing-decision-unavailable"],
    [null, "turn-identity-unavailable"],
    [null, "aggregate-summary"],
  ]);
  assert.equal(rows[2].reason, "priced-but-usage-missing");
});

test("preflight cached routing binds its original decision to the model run", async (t) => {
  const f = await fixture(t);
  await f.route.preflight({ prompt: "hello" }, { sessionKey: "session" });
  await f.route({ prompt: "hello" }, { sessionKey: "session", runId: "model-run" });
  await f.observer.handler({ ...output, runId: "model-run" });
  assert.equal((await f.rows(f.routing))[0].requestId, (await f.rows(f.cost))[0].requestId);
});

test("correlation expires, stays bounded, and scopes turn IDs by session", () => {
  let now = 0;
  const correlation = createRequestCorrelation({ now: () => now, ttlMs: 10, maxEntries: 2 });
  const remember = (runId) => correlation.remember({ requestId: runId }, { runId });
  remember("a"); remember("b"); remember("c");
  assert.equal(correlation.lookup({ runId: "a" }).requestId, null);
  assert.equal(correlation.lookup({ runId: "b" }).requestId, "b");
  now = 10;
  assert.equal(correlation.lookup({ runId: "b" }).requestId, null);
  correlation.remember({ requestId: "turn" }, {}, { sessionKey: "one", turnId: "1" });
  assert.equal(correlation.lookup({}, { sessionKey: "one", turnId: "1" }).requestId, "turn");
  assert.equal(correlation.lookup({}, { sessionKey: "two", turnId: "1" }).requestId, null);
});

test("standalone cost observer explicitly reports unavailable routing correlation", async () => {
  const rows = [];
  const observer = createCostObserver({ config: normalizeConfig({}), deps: {
    pricing, logger: { async write(row) { rows.push(row); } },
  } });
  await observer.handler(output);
  assert.equal(rows[0].requestId, null);
  assert.equal(rows[0].requestIdReason, "routing-correlation-unavailable");
});

test("duplicate resolution does not replace the logged decision ID", async (t) => {
  const f = await fixture(t);
  const context = { sessionKey: "session", runId: "run" };
  await f.route({ prompt: "hello" }, context);
  await f.route({ prompt: "hello" }, context);
  await f.observer.handler(output, context);
  const routing = await f.rows(f.routing);
  assert.equal(routing.length, 1);
  assert.equal((await f.rows(f.cost))[0].requestId, routing[0].requestId);
});
