/*
 * ToggleLogic (Free Tier) — Microsoft Graph /me/calendarView grounding port.
 *
 * The authoritative future-event check: UNIQUE event only; zero, multiple/
 * ambiguous, auth failure, timeout, malformed body, or an unwired transport all
 * FAIL CLOSED (return null) so the meeting-prep contract clarifies rather than
 * fabricates. Zoom is never consulted here.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { createGraphCalendarPort } from "../src/skill-routing/calendar-graph.js";

const TZ = "America/New_York";
const NOW = Date.parse("2026-09-15T17:00:00Z"); // 13:00 EDT
const TWO_PM = 14 * 60; // requested minutesOfDay

function eventAt(iso, id = "e") { return { id, subject: "Sync", start: { dateTime: iso } }; }

test("calendar: a UNIQUE future event at the referenced time is returned", async () => {
  const port = createGraphCalendarPort({ transport: async () => ({ value: [eventAt("2026-09-15T14:00:00-04:00", "evt-1")] }) });
  const hit = await port.findEvent({ minutesOfDay: TWO_PM, nowMs: NOW, timeZone: TZ });
  assert.ok(hit);
  assert.equal(hit.id, "evt-1");
});

test("calendar: zero matching events fails closed (null)", async () => {
  const port = createGraphCalendarPort({ transport: async () => ({ value: [eventAt("2026-09-15T09:00:00-04:00")] }) });
  assert.equal(await port.findEvent({ minutesOfDay: TWO_PM, nowMs: NOW, timeZone: TZ }), null);
});

test("calendar: MULTIPLE events at the referenced time are ambiguous → fail closed", async () => {
  const port = createGraphCalendarPort({ transport: async () => ({ value: [eventAt("2026-09-15T14:00:00-04:00", "a"), eventAt("2026-09-15T14:00:00-04:00", "b")] }) });
  assert.equal(await port.findEvent({ minutesOfDay: TWO_PM, nowMs: NOW, timeZone: TZ }), null);
});

test("calendar: a PAST event (start <= now) does not count", async () => {
  const port = createGraphCalendarPort({ transport: async () => ({ value: [eventAt("2026-09-15T14:00:00-04:00")] }) });
  const nowLate = Date.parse("2026-09-15T20:00:00Z"); // 16:00 EDT; 2 PM already past
  assert.equal(await port.findEvent({ minutesOfDay: TWO_PM, nowMs: nowLate, timeZone: TZ }), null);
});

test("calendar: an auth failure / transport throw fails closed", async () => {
  const port = createGraphCalendarPort({ transport: async () => { throw new Error("401 Unauthorized"); } });
  assert.equal(await port.findEvent({ minutesOfDay: TWO_PM, nowMs: NOW, timeZone: TZ }), null);
});

test("calendar: a malformed response body (no value array) fails closed", async () => {
  const port = createGraphCalendarPort({ transport: async () => ({ error: { code: "InvalidAuthenticationToken" } }) });
  assert.equal(await port.findEvent({ minutesOfDay: TWO_PM, nowMs: NOW, timeZone: TZ }), null);
});

test("calendar: a timeout fails closed", async () => {
  const port = createGraphCalendarPort({ transport: () => new Promise(() => {}), timeoutMs: 25 });
  assert.equal(await port.findEvent({ minutesOfDay: TWO_PM, nowMs: NOW, timeZone: TZ }), null);
});

test("calendar: an unwired transport always fails closed (clarify, never fabricate)", async () => {
  const port = createGraphCalendarPort({});
  assert.equal(port.hasTransport, false);
  assert.equal(await port.findEvent({ minutesOfDay: TWO_PM, nowMs: NOW, timeZone: TZ }), null);
});

test("calendar: a bare local time WITHOUT zone info is not trusted (fail closed)", async () => {
  // No offset/Z and not labeled UTC → unparseable instant → not a confident match.
  const port = createGraphCalendarPort({ transport: async () => ({ value: [{ id: "x", start: { dateTime: "2026-09-15T14:00:00", timeZone: "Eastern Standard Time" } }] }) });
  assert.equal(await port.findEvent({ minutesOfDay: TWO_PM, nowMs: NOW, timeZone: TZ }), null);
});
