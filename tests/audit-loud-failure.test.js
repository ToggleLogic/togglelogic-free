/*
 * ToggleLogic (Free Tier) — audit-write failures are loud, counted and recovered (2.1.5).
 * (c) 2026 Motherboard, Inc. Source-available under the ToggleLogic Free-Tier
 * License (see LICENSE); all rights reserved.
 * PATENT PENDING.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as realFs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAuditLogger, FAILURE_REPORT_INTERVAL_MS } from "../src/audit/audit-logger.js";
import { normalizeConfig } from "../src/config/normalize.js";
import { registerCapabilities } from "../src/capabilities.js";

function capture() {
  const logs = { error: [], warn: [], info: [] };
  return { logs, logger: { error: (m) => logs.error.push(m), warn: (m) => logs.warn.push(m), info: (m) => logs.info.push(m) } };
}

async function tempDir(t, prefix) {
  const dir = await realFs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => realFs.rm(dir, { recursive: true, force: true }));
  return dir;
}

// An fs facade that fails appends while `failing` is set, with a chosen code.
function flakyFs(state) {
  return {
    mkdir: realFs.mkdir, stat: realFs.stat, rename: realFs.rename,
    appendFile: async (...args) => {
      if (state.failing) { const err = new Error("simulated"); err.code = state.code; throw err; }
      return realFs.appendFile(...args);
    },
  };
}

const readRows = async (file) => (await realFs.readFile(file, "utf8")).trim().split("\n").map((line) => JSON.parse(line));

test("every failure is counted; error log on first failure and then at most once per interval; recovery record states the gap", async (t) => {
  const dir = await tempDir(t, "tl-audit-loud-");
  const file = path.join(dir, "audit.jsonl");
  const state = { failing: false, code: "ENOSPC" };
  let clock = Date.parse("2026-10-13T12:00:00.000Z");
  const { logs, logger } = capture();
  const reports = [];
  const audit = createAuditLogger({ path: file }, logger, { pluginVersion: "test" }, { fs: flakyFs(state), now: () => clock });
  audit.onFailureReport((info) => reports.push(info));

  await audit.emit({ event: "config.load" });
  assert.deepEqual(audit.health().ready, true);

  state.failing = true;
  for (let i = 0; i < 5; i++) { clock += 1000; await audit.emit({ event: "routing.decision" }); }
  assert.equal(logs.error.length, 1, "one error log for a burst inside the interval");
  assert.match(logs.error[0], /ENOSPC/);
  assert.match(logs.error[0], /NOT READY/);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].failedCount, 1);
  const h = audit.health();
  assert.equal(h.ready, false);
  assert.equal(h.reason, "audit-write-failing");
  assert.equal(h.failures.current, 5, "every failure is counted, not just the reported one");
  assert.equal(h.failures.lastErrorCode, "ENOSPC");

  clock += FAILURE_REPORT_INTERVAL_MS;
  state.code = "EIO";
  await audit.emit({ event: "routing.decision" });
  assert.equal(logs.error.length, 2, "reported again after the interval");
  assert.equal(reports[1].failedCount, 6);
  assert.equal(reports[1].sinceLastReport, 5, "the four unreported failures plus this one");
  assert.equal(reports[1].errorCode, "EIO");

  state.failing = false;
  clock += 1000;
  await audit.emit({ event: "plugin.register" });
  const rows = await readRows(file);
  assert.deepEqual(rows.map((r) => r.event), ["config.load", "plugin.register", "audit.write.recovered"]);
  const recovered = rows.at(-1);
  assert.equal(recovered.details.failedCount, 6);
  assert.equal(recovered.details.recordsLost, 6);
  assert.equal(recovered.details.lastErrorCode, "EIO");
  assert.equal(recovered.details.firstFailureAt, "2026-10-13T12:00:01.000Z");
  assert.ok(recovered.controls.includes("AU-5"));
  assert.equal(audit.health().ready, true);
  assert.equal(audit.health().failures.lifetime, 6);
  assert.ok(logs.warn.some((m) => /recovered; 6 record\(s\)/.test(m)));

  // A new failure window starts fresh and reports immediately.
  state.failing = true;
  await audit.emit({ event: "routing.decision" });
  assert.equal(logs.error.length, 3);
  assert.equal(reports.at(-1).failedCount, 1);
});

test("a real filesystem failure (parent path is a file) is loud and never throws into the caller", async (t) => {
  const dir = await tempDir(t, "tl-audit-real-");
  const blocker = path.join(dir, "not-a-dir");
  await realFs.writeFile(blocker, "x");
  const { logs, logger } = capture();
  const audit = createAuditLogger({ path: path.join(blocker, "audit.jsonl") }, logger);
  await assert.doesNotReject(audit.emit({ event: "config.load" }));
  await audit.emit({ event: "plugin.register" });
  assert.equal(logs.error.length, 1);
  assert.match(logs.error[0], /ENOTDIR|EEXIST/);
  assert.equal(audit.health().ready, false);
  assert.equal(audit.health().failures.current, 2);
});

test("disabled audit is reported as disabled, not failing", () => {
  const audit = createAuditLogger({ enabled: false }, null);
  assert.deepEqual({ ready: audit.health().ready, reason: audit.health().reason, enabled: audit.health().enabled },
    { ready: true, reason: "disabled", enabled: false });
});

test("plugin wiring: audit gate recorded, failures reach the events stream, session_start repeats the error", async (t) => {
  const dir = await tempDir(t, "tl-audit-wire-");
  const blocker = path.join(dir, "blocked");
  await realFs.writeFile(blocker, "x");
  const eventsPath = path.join(dir, "events.jsonl");
  const { logs, logger } = capture();
  const hooks = new Map();
  const raw = { mode: "passthrough", intelligence: { enabled: false },
    features: { routing: { enabled: false }, costVisibility: { enabled: false } },
    audit: { path: path.join(blocker, "audit.jsonl") },
    costVisibility: { attribution: { deploymentId: "test" }, events: { path: eventsPath } } };
  const config = normalizeConfig(raw);
  const audit = createAuditLogger(config.audit, logger, { pluginVersion: "test" });
  const api = { config: {}, logger, on(name, fn) { hooks.set(name, [...(hooks.get(name) ?? []), fn]); } };
  const { gates, usageEvents } = registerCapabilities({ api, audit, fallbackLogger: logger, version: "test", config });

  const gate = gates.find((g) => g.id === "audit");
  assert.deepEqual(gate, { id: "audit", enabled: true, reason: "ok", ready: true }, "ready until a write fails");

  await audit.emit({ event: "plugin.register" });
  await usageEvents.flush();
  const events = (await realFs.readFile(eventsPath, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(events.length, 1);
  assert.equal(events[0].event, "audit_write_failed");
  assert.equal(events[0].failedCount, 1);
  assert.match(events[0].errorCode, /^E[A-Z]+$/);
  assert.equal(events[0].deploymentId, "test");
  assert.doesNotMatch(JSON.stringify(events[0]), /blocked|audit\.jsonl/, "no filesystem paths in the event");

  const before = logs.error.length;
  for (const fn of hooks.get("session_start") ?? []) fn({}, {});
  assert.equal(logs.error.length, before + 1);
  assert.match(logs.error.at(-1), /NOT READY/);
});
