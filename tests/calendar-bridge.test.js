/*
 * ToggleLogic (Free Tier) — subprocess calendar bridge ADAPTER tests.
 *
 * These drive the REAL subprocess path end to end: createSubprocessCalendarTransport
 * spawns an actual child process (a fake bridge fixture that emits controlled
 * envelopes / exits non-zero / hangs / prints garbage / echoes its argv), feeds it
 * into the production createGraphCalendarPort, and asserts the fail-closed contract:
 * unique event returns; zero / ambiguous / auth-failure / timeout / invalid-output
 * all return null; and adversarial arguments reach the child as literal, un-split
 * strings (no shell). No live Microsoft Graph or vault access occurs.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createSubprocessCalendarTransport } from "../src/skill-routing/calendar-bridge.js";
import { createGraphCalendarPort } from "../src/skill-routing/calendar-graph.js";

const TZ = "America/New_York";
const NOW = Date.parse("2026-09-15T17:00:00Z"); // 13:00 EDT
const TWO_PM = 14 * 60;

// A real fake bridge: a node script whose behavior is chosen by env TL_MODE.
const FIXTURE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "tl-cal-bridge-"));
const FIXTURE = path.join(FIXTURE_DIR, "fake-bridge.mjs");
fs.writeFileSync(FIXTURE, `
const args = process.argv.slice(2);
const get = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
const mode = process.env.TL_MODE || "unique";
const S = "togglelogic-calendar-view/v1";
const ev = (id, iso) => ({ id, subject: "Sync", start: { dateTime: iso, timeZone: "UTC" }, end: { dateTime: iso, timeZone: "UTC" } });
const emit = (o) => process.stdout.write(JSON.stringify(o));
if (mode === "unique") emit({ ok: true, schema: S, count: 1, events: [ev("evt-1", "2026-09-15T18:00:00.0000000")] });
else if (mode === "zero") emit({ ok: true, schema: S, count: 0, events: [] });
else if (mode === "ambiguous") emit({ ok: true, schema: S, count: 2, events: [ev("a", "2026-09-15T18:00:00Z"), ev("b", "2026-09-15T18:00:00Z")] });
else if (mode === "auth_exit") { emit({ ok: false, schema: S, error_class: "auth", message: "reauth" }); process.exit(4); }
else if (mode === "auth_ok0") { emit({ ok: false, schema: S, error_class: "auth", message: "reauth" }); }
else if (mode === "garbage") process.stdout.write("<html>500 Internal Server Error</html>");
else if (mode === "nonzero") { emit({ ok: true, schema: S, count: 0, events: [] }); process.exit(3); }
else if (mode === "wrong_schema") emit({ ok: true, schema: "some-other/v9", count: 0, events: [] });
else if (mode === "hang") setTimeout(() => {}, 60000);
else if (mode === "echo") emit({ ok: true, schema: S, count: 1, events: [{ id: "echo", subject: JSON.stringify(args), start: { dateTime: "2026-09-15T18:00:00Z", timeZone: "UTC" } }] });
`);

process.on("exit", () => fs.rmSync(FIXTURE_DIR, { recursive: true, force: true }));

function portFor(mode, { timeoutMs = 5000, bridge = {} } = {}) {
  const transport = createSubprocessCalendarTransport(
    { command: process.execPath, args: [FIXTURE], env: { TL_MODE: mode }, ...bridge },
    { timeoutMs },
  );
  return createGraphCalendarPort({ transport, timeoutMs });
}

test("bridge: a UNIQUE future event is returned via the real subprocess", async () => {
  const port = portFor("unique");
  assert.equal(port.hasTransport, true);
  const hit = await port.findEvent({ minutesOfDay: TWO_PM, nowMs: NOW, timeZone: TZ });
  assert.ok(hit);
  assert.equal(hit.id, "evt-1");
});

test("bridge: zero events fails closed (null)", async () => {
  const port = portFor("zero");
  assert.equal(await port.findEvent({ minutesOfDay: TWO_PM, nowMs: NOW, timeZone: TZ }), null);
});

test("bridge: multiple events at the referenced time are ambiguous → fail closed", async () => {
  const port = portFor("ambiguous");
  assert.equal(await port.findEvent({ minutesOfDay: TWO_PM, nowMs: NOW, timeZone: TZ }), null);
});

test("bridge: an auth failure (non-zero exit) fails closed", async () => {
  const port = portFor("auth_exit");
  assert.equal(await port.findEvent({ minutesOfDay: TWO_PM, nowMs: NOW, timeZone: TZ }), null);
});

test("bridge: an ok:false envelope on a zero exit still fails closed", async () => {
  const port = portFor("auth_ok0");
  assert.equal(await port.findEvent({ minutesOfDay: TWO_PM, nowMs: NOW, timeZone: TZ }), null);
});

test("bridge: a non-zero exit code fails closed even with ok:true stdout", async () => {
  const port = portFor("nonzero");
  assert.equal(await port.findEvent({ minutesOfDay: TWO_PM, nowMs: NOW, timeZone: TZ }), null);
});

test("bridge: a timeout kills the child and fails closed", async () => {
  const port = portFor("hang", { timeoutMs: 400 });
  const started = Date.now();
  assert.equal(await port.findEvent({ minutesOfDay: TWO_PM, nowMs: NOW, timeZone: TZ }), null);
  assert.ok(Date.now() - started < 5000, "did not wait for the 60s child; the child was killed");
});

test("bridge: invalid (non-JSON) output fails closed", async () => {
  const port = portFor("garbage");
  assert.equal(await port.findEvent({ minutesOfDay: TWO_PM, nowMs: NOW, timeZone: TZ }), null);
});

test("bridge: a wrong schema tag fails closed", async () => {
  const port = portFor("wrong_schema");
  assert.equal(await port.findEvent({ minutesOfDay: TWO_PM, nowMs: NOW, timeZone: TZ }), null);
});

test("bridge: an unconfigured command yields no transport (unwired, fails closed)", async () => {
  const transport = createSubprocessCalendarTransport({ command: "" });
  assert.equal(transport, null);
  const port = createGraphCalendarPort({ transport });
  assert.equal(port.hasTransport, false);
  assert.equal(await port.findEvent({ minutesOfDay: TWO_PM, nowMs: NOW, timeZone: TZ }), null);
});

// The echo fixture returns the exact argv it received as the event subject, so
// these assert the TRANSPORT's real argv construction (not a hand-built copy).
async function echoedArgv(bridgeExtra, query) {
  const transport = createSubprocessCalendarTransport(
    { command: process.execPath, args: [FIXTURE], env: { TL_MODE: "echo" }, ...bridgeExtra },
    { timeoutMs: 5000 },
  );
  const resp = await transport({ query });
  return JSON.parse(resp.value[0].subject);
}

test("bridge: adversarial window arguments reach the child LITERALLY (no shell, injection-safe)", async () => {
  const evil = "2026-09-15T17:00:00Z; rm -rf / && echo $(whoami) | cat";
  const argv = await echoedArgv(
    { accountArg: "clickitco`whoami`" },
    { startDateTime: evil, endDateTime: "2026-09-16T17:00:00Z" },
  );
  // The malicious start value survives as ONE literal argv element — never split,
  // never shell-expanded ($(whoami) / backticks / ; & | are inert text).
  assert.equal(argv[argv.indexOf("--start") + 1], evil, "adversarial --start passed literally as one argument");
  assert.ok(argv.includes("clickitco`whoami`"), "adversarial --account value passed literally");
});

test("bridge: configured account and max-results are forwarded as explicit args", async () => {
  const argv = await echoedArgv(
    { accountArg: "clickitco", maxResults: 12 },
    { startDateTime: "2026-09-15T17:00:00Z", endDateTime: "2026-09-16T17:00:00Z" },
  );
  assert.equal(argv[argv.indexOf("--account") + 1], "clickitco");
  assert.equal(argv[argv.indexOf("--max-results") + 1], "12");
  assert.equal(argv[argv.indexOf("--start") + 1], "2026-09-15T17:00:00Z");
});
