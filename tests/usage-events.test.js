/*
 * ToggleLogic (Free Tier) — call-time event and summary regression tests.
 * (c) 2026 Motherboard, Inc. Source-available under the ToggleLogic Free-Tier
 * License (see LICENSE); all rights reserved.
 * PATENT PENDING.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createUsageEvents, isLocalProvider } from "../src/usage/events.js";
import { createCostObserver } from "../src/usage/cost-observer.js";
import { createTally } from "../src/usage/cost-tally.js";
import { normalizeConfig } from "../src/config/normalize.js";
import { createAuditLogger } from "../src/audit/audit-logger.js";
import { registerCapabilities } from "../src/capabilities.js";

const call = { provider: "google", model: "gemini-test", usage: { input: 0, output: 0 } };
const identity = { provider: "example", model: "model", resolvedRef: "example/model", requestId: "request-1" };
function fixture({ priced = true, config = {}, hostConfig = {} } = {}) {
  let time = Date.parse("2026-09-28T12:10:00Z");
  const rows = [], events = [], audit = [];
  const observer = createCostObserver({
    config: normalizeConfig({ costVisibility: { attribution: { deploymentId: "test", costCenter: "team" }, ...config } }),
    hostConfig, audit: { emit: async (row) => audit.push(row) },
    requestCorrelation: { lookup: () => ({ requestId: "request-1" }) },
    deps: { now: () => time, logger: { write: async (row) => rows.push(row) },
      eventLogger: { write: async (row) => events.push(row) },
      pricing: { resolve: async () => ({ priced, provider: "vendor" }), costUsd: () => 0.01 } },
  });
  return { observer, rows, events, audit, time: (value) => { time = Date.parse(value); } };
}

test("model_unpriced: first remote call per ref per UTC day, including concurrent calls", async () => {
  const f = fixture({ priced: false });
  await Promise.all(Array.from({ length: 20 }, () => f.observer.handler(call)));
  assert.equal(f.events.length, 1);
  assert.deepEqual(f.events[0], { schema: "togglelogic.event.v1", ts: "2026-09-28T12:10:00.000Z",
    event: "model_unpriced", deploymentId: "test", costCenter: "team", requestId: "request-1",
    provider: "google", model: "gemini-test", resolvedRef: "google/gemini-test", reason: "no-price-in-source" });
  assert.equal(f.audit[0].event, "model_unpriced");
  assert.deepEqual(f.audit[0].details, f.events[0]);
  assert.equal(f.audit[0].correlationId, "request-1");
  f.time("2026-09-28T23:59:59Z"); await f.observer.handler(call);
  assert.equal(f.events.length, 1);
  f.time("2026-09-29T00:00:00Z"); await f.observer.handler(call);
  await f.observer.handler({ ...call, model: "other" });
  assert.equal(f.events.length, 3);
  assert.equal(f.rows.filter((row) => row.kind === "call").length, 23);
});

test("usage_missing: repeated priced zero-usage refusals emit once per UTC hour, never unpriced", async () => {
  const f = fixture();
  // Regression fixture: 50 priced, zero-usage outputs in a single hour.
  await Promise.all(Array.from({ length: 50 }, () => f.observer.handler(call)));
  assert.equal(f.events.length, 1);
  assert.equal(f.events[0].event, "usage_missing");
  assert.equal(f.events[0].calls, 1); // count at first emission, not a later burst total
  assert.deepEqual(f.audit[0].details, f.events[0]);
  assert.equal(f.rows.filter((row) => row.usageMissing && !row.unpriced).length, 50);
  assert.ok(f.rows.filter((row) => row.kind === "call").every((row) => row.costUsd == null));
  let sum = f.observer.tally.summarize();
  assert.equal(sum.usageMissing.calls, 50);
  assert.equal(sum.unpriced.calls, 0);
  const line = f.observer.tally.loudLine(sum);
  assert.match(line, /USAGE MISSING: 50 call\(s\).*priced model, no usage reported/);
  assert.doesNotMatch(line, /UNPRICED|upgrade|curated|tokens|all calls priced/i);
  f.time("2026-09-28T12:59:59Z"); await f.observer.handler(call);
  assert.equal(f.events.length, 1);
  f.time("2026-09-28T13:25:00Z"); await f.observer.handler(call);
  assert.equal(f.events.length, 2, "a burst spanning two UTC hours has two first-hour events");
  assert.equal(f.observer.tally.summarize().usageMissing.calls, 52);
});

test("local unpriced calls stay in ledger; configured provider IDs and loopback endpoints suppress events", async () => {
  for (const provider of ["ollama", "lmstudio", "llamacpp", "vllm-local"]) {
    const f = fixture({ priced: false });
    await f.observer.handler({ ...call, provider });
    assert.equal(f.events.length, 0);
    assert.equal(f.rows[0].unpriced, true);
  }
  const custom = fixture({ priced: false, config: { localProviders: ["CUSTOM"] } });
  await custom.observer.handler({ ...call, provider: "custom" });
  assert.equal(custom.events.length, 0);
  for (const baseUrl of ["http://localhost:1234/v1", "http://127.0.0.1/v1", "http://[::1]:8000/v1"]) {
    const f = fixture({ priced: false, hostConfig: { models: { providers: { proxy: { baseUrl } } } } });
    await f.observer.handler({ ...call, provider: "proxy" });
    assert.equal(f.events.length, 0, baseUrl);
    assert.equal(f.rows[0].provider, "proxy", "use serving provider, not price vendor");
    assert.equal(f.rows[0].unpriced, true);
  }
  for (const baseUrl of ["https://localhost.example.com", "https://127.0.0.1.example.com", "not a URL"]) {
    assert.equal(isLocalProvider("proxy", [], { models: { providers: { proxy: { baseUrl } } } }), false);
  }
  const remote = fixture({ priced: false, config: { localProviders: [] } });
  await remote.observer.handler({ ...call, provider: "ollama" });
  assert.equal(remote.events.length, 1, "explicit empty list replaces defaults");
});

test("three summary buckets stay separate, dollar-only human output, UTC date", () => {
  const tally = createTally({ now: () => Date.parse("2026-09-29T00:00:00Z") });
  tally.record({ ref: "example/priced", priced: true, costUsd: 1.25 });
  tally.record({ ref: "example/unpriced", priced: false, inputTok: 100 });
  tally.record({ ref: "example/missing", priced: false, usageMissing: true });
  const sum = tally.summarize();
  assert.equal(sum.day, "2026-09-29");
  assert.deepEqual([sum.callsPriced, sum.unpriced.calls, sum.usageMissing.calls], [1, 1, 1]);
  const line = tally.loudLine();
  assert.match(line, /\$1\.2500 across 1 priced/);
  assert.match(line, /UNPRICED: 1 call\(s\).*no price available/);
  assert.match(line, /USAGE MISSING: 1 call\(s\).*no usage reported/);
  assert.doesNotMatch(line, /upgrade|curated|tokens|100t|all calls priced/);
  tally.reset();
  tally.record({ ref: "example/priced", priced: true, costUsd: 0.1 });
  assert.match(tally.loudLine(), /all calls priced/);
});

test("missing, null and all-zero usage are missing; cache-only and nonzero usage are costed", async () => {
  const f = fixture();
  for (const usage of [undefined, {}, { input: null, output: null }, { input: 0, output: 0 },
    { input: "", output: "" }, { input: true, output: 1 }, { input: " ", output: 1 }, { input: NaN, output: 0 }, { input: -1, output: 1 }]) {
    await f.observer.handler({ ...call, usage });
    assert.equal(f.rows.at(-1).usageMissing, true);
  }
  for (const usage of [{ input: 1, output: 0 }, { input: 0, output: 0, cacheRead: 20 }]) {
    await f.observer.handler({ ...call, usage });
    assert.equal(f.rows.at(-1).costUsd, 0.01);
  }
});

test("event file append/rotation, audit mirror, payload allowlist, and retained dedupe after restart", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tl-events-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const eventPath = path.join(dir, "events.jsonl");
  const audit = createAuditLogger({ path: path.join(dir, "audit.jsonl") });
  let time = Date.parse("2026-09-28T12:10:00Z");
  const make = () => createUsageEvents({ config: { path: eventPath, rotateSizeMb: 1 },
    audit, deploymentId: "test", now: () => time });
  const first = make();
  await first.emit("model_unpriced", { ...identity, apiKey: "forbidden-field", billingAccountId: "forbidden-field", error: "raw error" });
  await first.emit("usage_missing", { ...identity, requestId: null });
  const before = await fs.readFile(eventPath, "utf8");
  const rows = before.trim().split("\n").map(JSON.parse);
  assert.equal(rows.length, 2);
  assert.equal(rows[1].requestId, null);
  assert.doesNotMatch(before, /forbidden-field|raw error|apiKey|billingAccountId/);
  await fs.appendFile(eventPath, " ".repeat(1024 * 1024) + "\n");
  await first.emit("model_unpriced", { ...identity, resolvedRef: "example/other" });
  assert.ok((await fs.readFile(eventPath + ".1", "utf8")).startsWith(before));
  const restarted = make();
  await restarted.emit("model_unpriced", identity);
  await restarted.emit("usage_missing", identity);
  assert.equal((await fs.readFile(eventPath, "utf8")).trim().split("\n").length, 1);
  time = Date.parse("2026-09-28T13:00:00Z");
  await restarted.emit("usage_missing", identity);
  assert.equal((await fs.readFile(eventPath, "utf8")).trim().split("\n").length, 2);
  await audit.flush();
  const audits = (await fs.readFile(audit.path, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(audits.length, 4);
  assert.equal(audits[0].event, "model_unpriced");
  assert.equal(audits[0].details.schema, "togglelogic.event.v1");
});

test("registration passes host provider config and audit sink to observer", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tl-event-hook-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const config = normalizeConfig({ features: { costVisibility: { enabled: true } },
    costVisibility: { events: { path: path.join(dir, "events.jsonl") }, log: { path: path.join(dir, "cost.jsonl") } } });
  const hooks = {}, audits = [];
  registerCapabilities({ config, version: "test", audit: { emit: async (row) => audits.push(row) },
    api: { config: { models: { providers: { proxy: { baseUrl: "http://[::1]:8000" } } } },
      on: (name, handler) => { hooks[name] = handler; } } });
  // Non-curated refs never fetch pricing; this integration test stays offline.
  await hooks.llm_output({ provider: "proxy", model: "test" });
  assert.equal(audits.length, 0);
  await hooks.llm_output({ provider: "remote-example", model: "test" });
  assert.equal(audits.length, 1);
  assert.equal(audits[0].event, "model_unpriced");
});


test("event configuration defaults and explicit overrides normalize", () => {
  const defaults = normalizeConfig({}).costVisibility;
  assert.equal(defaults.events.path, "~/.openclaw/logs/togglelogic-events.jsonl");
  assert.equal(defaults.events.rotateSizeMb, 50);
  const custom = normalizeConfig({ costVisibility: { events: { path: "events.jsonl", rotateSizeMb: 2 },
    localProviders: [" Custom "] } }).costVisibility;
  assert.deepEqual(custom.events, { path: "events.jsonl", rotateSizeMb: 2 });
  assert.deepEqual(custom.localProviders, ["custom"]);
});

test("valid priced calls emit no alert and remote unpriced coverage reason remains factual", async () => {
  const f = fixture();
  await f.observer.handler({ ...call, usage: { input: 1, output: 1 } });
  assert.equal(f.events.length, 0);
  const records = [];
  const stream = createUsageEvents({ logger: { write: async (row) => records.push(row) } });
  await stream.emit("model_unpriced", { ...identity, reason: "outside-price-coverage" });
  assert.equal(records[0].reason, "outside-price-coverage");
});
