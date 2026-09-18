/*
 * ToggleLogic (Free Tier) — INTENT + SKILL-AWARE meeting/calendar contract tests.
 *
 * 1.6.1-rc.2 bounded correction. The meeting/calendar truth contract used to bind
 * ONLY to the skill id "meeting-prep", which is NOT installed on the reference
 * host. These tests use the ACTUAL installed-skill reality — meeting-prep ABSENT;
 * microsoft-graph (authoritative Outlook/Graph calendar) and zoom-meetings
 * (subordinate, never a calendar) ELIGIBLE — and prove that:
 *
 *   1. A past meeting/calendar request that resolved to microsoft-graph CLARIFIES
 *      BEFORE the route planner or any model runs (zero downstream calls).
 *   2. A future meeting with NO authoritative Outlook event CLARIFIES.
 *   3. A future UNIQUE Outlook event PROCEEDS to the bounded child.
 *   4. Generic Graph EMAIL work (no meeting intent) does NOT trigger the contract.
 *   5. A meeting request resolved to ZOOM ALONE cannot establish an event → CLARIFY.
 *   6. The universal no-skill fail-safe is unchanged.
 *
 * Part A drives createSkillContracts directly (unit); Part B drives the real
 * before_agent_reply gate (coordinator.handleGate) with a stub subagent + a plan
 * counter, so "before planner / zero model calls" is asserted, not assumed.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createSkillRoutingCoordinator, NO_SKILL_FAILSAFE } from "../src/skill-routing/coordinator.js";
import { createCanaryScope } from "../src/skill-routing/scope.js";
import { createSkillResolver } from "../src/skill-routing/resolver.js";
import { createSkillContracts, detectMeetingIntent, detectCalendarInspectionIntent } from "../src/skill-routing/skill-contracts.js";

// 2026-09-15T20:03:00Z == 16:03 America/New_York (EDT): a 2 PM meeting is PAST.
const PAST_NOW = Date.parse("2026-09-15T20:03:00Z");
// 2026-09-15T17:00:00Z == 13:00 EDT: a 2 PM meeting is still UPCOMING.
const FUTURE_NOW = Date.parse("2026-09-15T17:00:00Z");
const TZ = "America/New_York";

// Al's SAM Telegram DM identity (the live host binding).
const OWNER_CTX = Object.freeze({
  channel: "telegram", accountId: "codex", senderId: "7797183919",
  sessionKey: "agent:main:telegram:codex:7797183919", senderIsOwner: true,
  trigger: "user", inputProvenance: { kind: "external_user" },
});

// ————————————————————————————————————————————————————————————————
// Part A: unit tests on the contract module (installed reality, no meeting-prep)
// ————————————————————————————————————————————————————————————————

test("intent: meeting/calendar language is detected; generic Graph email/contact language is NOT", () => {
  assert.equal(detectMeetingIntent("prepare me for my 2 pm meeting"), true);
  assert.equal(detectMeetingIntent("what's on my calendar tomorrow"), true);
  assert.equal(detectMeetingIntent("my 1:1 with Dana"), true);
  assert.equal(detectMeetingIntent("reschedule the standup"), true);
  // Generic Microsoft Graph work must not read as a meeting/calendar turn.
  assert.equal(detectMeetingIntent("send an email to the finance team"), false);
  assert.equal(detectMeetingIntent("look up Dana's contact and phone number"), false);
  assert.equal(detectMeetingIntent("draft a reply to the vendor thread"), false);
});

test("applies to microsoft-graph on a meeting turn; NOT to microsoft-graph email work", () => {
  const c = createSkillContracts({ ownerTimezone: TZ, now: () => PAST_NOW });
  const graph = [{ id: "microsoft-graph" }];
  assert.equal(c.meetingApplicability(graph, "prep my 2 pm meeting").applies, true);
  assert.equal(c.meetingApplicability(graph, "prep my 2 pm meeting").authoritativeAvailable, true);
  // Email/contact work over the same skill is not a calendar turn.
  assert.equal(c.meetingApplicability(graph, "send an email to finance").applies, false);
  // Zoom alone: applies (meeting intent) but has no authoritative calendar.
  const zoom = c.meetingApplicability([{ id: "zoom-meetings" }], "prep my 2 pm meeting");
  assert.equal(zoom.applies, true);
  assert.equal(zoom.authoritativeAvailable, false);
});

test("preflight (microsoft-graph): past clarifies, future-with-event proceeds, future-absent clarifies", async () => {
  const graph = [{ id: "microsoft-graph" }];

  const past = createSkillContracts({ ownerTimezone: TZ, now: () => PAST_NOW });
  assert.equal((await past.preflight(graph, "prep my 2 pm meeting")).action, "clarify");

  const future = createSkillContracts({ ownerTimezone: TZ, now: () => FUTURE_NOW, calendarPort: { findEvent: async () => ({ id: "evt-1" }) } });
  assert.equal((await future.preflight(graph, "prep my 2 pm meeting")).action, "proceed");

  const futureNoEvent = createSkillContracts({ ownerTimezone: TZ, now: () => FUTURE_NOW, calendarPort: { findEvent: async () => null } });
  const clar = await futureNoEvent.preflight(graph, "prep my 2 pm meeting");
  assert.equal(clar.action, "clarify");
  assert.equal(clar.reason, "no_authoritative_calendar_event");
});

// —— 1.6.1-rc.4 EXPLICIT-INSPECTION PRECEDENCE ————————————————————————————
// The canary defect: an explicit "check my Outlook calendar via Microsoft Graph"
// request was wrongly short-circuited as past_meeting_reference just because the
// referenced 2 PM had passed. It must PROCEED through the authoritative skill,
// while an ordinary ambiguous meeting-PREP request at a past time still clarifies.

test("intent: explicit inspect/check/search/query of Outlook/Graph/calendar is detected; ordinary prep is NOT", () => {
  // Prompt B (the canary regression) and natural inspection phrasings → true.
  assert.equal(detectCalendarInspectionIntent("Check my Outlook calendar using Microsoft Graph and tell me whether I had a 2:00 PM meeting today. Do not infer anything from memory."), true);
  assert.equal(detectCalendarInspectionIntent("Search my Outlook calendar for a 2 pm meeting today."), true);
  assert.equal(detectCalendarInspectionIntent("Query Microsoft Graph for today's 2 pm meeting."), true);
  assert.equal(detectCalendarInspectionIntent("Look up my calendar and confirm the 2 pm."), true);
  // Prompt A (the ordinary prep short-circuit) and near-misses → false.
  assert.equal(detectCalendarInspectionIntent("Prepare me for my 2:00 PM meeting today."), false);
  assert.equal(detectCalendarInspectionIntent("Prepare me for my 2 pm meeting on my calendar today."), false); // calendar noun, no inspect verb
  assert.equal(detectCalendarInspectionIntent("Check the finance report before I leave."), false); // inspect verb, no calendar target
});

test("preflight (microsoft-graph): explicit Outlook/Graph INSPECTION of a PAST time PROCEEDS; ordinary prep of the same past time CLARIFIES", async () => {
  const graph = [{ id: "microsoft-graph" }];
  // The reference-host closure wires a calendar port; the 2 PM event existed, which
  // is exactly why the ordinary prep prompt reported reason past_meeting_reference.
  const c = createSkillContracts({ ownerTimezone: TZ, now: () => PAST_NOW, calendarPort: { findEvent: async () => ({ id: "evt-1" }) } });

  // Prompt A — ordinary ambiguous prep, past time → cost-saving short-circuit kept.
  const prep = await c.preflight(graph, "Prepare me for my 2:00 PM meeting today.");
  assert.equal(prep.action, "clarify");
  assert.equal(prep.reason, "past_meeting_reference");

  // Prompt B — explicit inspect/check of Outlook via Graph, same past time → PROCEED.
  const inspect = await c.preflight(graph, "Check my Outlook calendar using Microsoft Graph and tell me whether I had a 2:00 PM meeting today. Do not infer anything from memory.");
  assert.equal(inspect.action, "proceed");
  assert.equal(inspect.reason, "explicit_calendar_inspection");

  // The precedence proceeds even with NO wired calendar port (the child/bridge does
  // the authoritative check) — it is not merely deferring to a port-confirmed event.
  const noPort = createSkillContracts({ ownerTimezone: TZ, now: () => PAST_NOW });
  const inspectNoPort = await noPort.preflight(graph, "Check my Outlook calendar using Microsoft Graph for today's 2 pm meeting.");
  assert.equal(inspectNoPort.action, "proceed");
  assert.equal(inspectNoPort.reason, "explicit_calendar_inspection");
});

test("preflight: explicit inspection does NOT rescue a Zoom-only route — Zoom is never the authoritative calendar", async () => {
  // Precedence only fires past the subordinate-only branch (authoritative Graph in
  // the route). A "check my calendar" request that resolved to Zoom alone still
  // clarifies — there is no authoritative calendar to inspect.
  const c = createSkillContracts({ ownerTimezone: TZ, now: () => PAST_NOW, calendarPort: { findEvent: async () => ({ id: "evt-1" }) } });
  const pf = await c.preflight([{ id: "zoom-meetings" }], "Check my calendar for whether I had a 2 pm meeting today.");
  assert.equal(pf.action, "clarify");
  assert.equal(pf.reason, "subordinate_meeting_skill_not_authoritative");
});

test("preflight (Zoom alone): a meeting request with no Outlook/Graph in the route CLARIFIES — Zoom can't establish an event", async () => {
  // Even with a wired calendar port, a route without the authoritative skill
  // cannot confirm a meeting; Zoom is subordinate context, never the calendar.
  const c = createSkillContracts({ ownerTimezone: TZ, now: () => FUTURE_NOW, calendarPort: { findEvent: async () => ({ id: "evt-1" }) } });
  const pf = await c.preflight([{ id: "zoom-meetings" }], "prep my 2 pm meeting");
  assert.equal(pf.action, "clarify");
  assert.equal(pf.reason, "subordinate_meeting_skill_not_authoritative");
  assert.match(pf.reply, /Zoom isn't a calendar/i);
  assert.match(pf.reply, /Outlook|Microsoft Graph/);
});

test("preflight (generic Graph email): no meeting intent → PROCEED (contract does not apply)", async () => {
  const c = createSkillContracts({ ownerTimezone: TZ, now: () => PAST_NOW });
  const pf = await c.preflight([{ id: "microsoft-graph" }], "send an email to the finance team about Q3");
  assert.equal(pf.action, "proceed");
  assert.equal(pf.reason, "no_calendar_contract");
});

test("contractPrompt is intent+skill-aware: injected for a microsoft-graph meeting turn, omitted for email work", () => {
  const c = createSkillContracts({ ownerTimezone: TZ, now: () => FUTURE_NOW });
  const meetingPrompt = c.contractPrompt([{ id: "microsoft-graph" }], "prep my 2 pm meeting");
  assert.match(meetingPrompt, /Outlook via Microsoft Graph|Microsoft Graph/);
  assert.match(meetingPrompt, /NEVER synthesize/i);
  // Generic Graph email work gets no calendar contract injected.
  assert.equal(c.contractPrompt([{ id: "microsoft-graph" }], "send an email to finance"), null);
});

test("Graph plus Zoom meeting prep requires an actual Zoom search before claiming no history", () => {
  const c = createSkillContracts({ ownerTimezone: TZ, now: () => FUTURE_NOW });
  const prompt = c.contractPrompt(
    [{ id: "microsoft-graph" }, { id: "zoom-meetings" }],
    "Prepare me for my meeting and use Zoom history if relevant",
  );
  assert.match(prompt, /perform an actual Zoom API\/search\/list operation/i);
  assert.match(prompt, /Reading the zoom-meetings skill instructions is preparation, not a Zoom history search/i);
  assert.match(prompt, /no relevant Zoom history was found only after a successful Zoom search/i);
  assert.match(prompt, /Zoom history was not checked/i);
  assert.match(prompt, /owner-local midnight INCLUSIVE.*next owner-local midnight EXCLUSIVE/i);
  assert.match(prompt, /stable Graph event identifiers/i);
  assert.match(prompt, /calendar confirmation and a Zoom-history search are inputs, not the finished briefing/i);
  assert.match(prompt, /objectives; decision points; risks; specific questions\/talking points/i);
  assert.match(prompt, /Never include meeting join URLs, meeting IDs, passcodes, dial-in PINs/i);
});

// ————————————————————————————————————————————————————————————————
// Part B: full before_agent_reply gate, real installed reality (meeting-prep ABSENT)
// ————————————————————————————————————————————————————————————————

// Natural-language meeting requests. Deployment aliases let "Outlook"/"Zoom"
// resolve to the eligible microsoft-graph / zoom-meetings skills, exactly as the
// deployment catalog would after the incident (meeting-prep is NOT installed).
const REALITY_CATALOG = [
  { id: "microsoft-graph", aliases: ["outlook", "microsoft graph"] },
  { id: "zoom-meetings", aliases: ["zoom"] },
  { id: "code-review", aliases: ["code review"] },
];

function selectedPlan(id) {
  return {
    status: "selected", planned_skills: [{ id, version: "1.0.0" }],
    strategy: "lowest_cost", selected_lineage: "google/gemini-flash",
    selected_model_ref: "google/gemini-3.5-flash",
    estimated_tokens: 4000, choices: [{ kind: "lowest_cost", estimated_cost_usd: 0.002 }],
  };
}

function educationPlan(id) {
  return {
    schema_version: 1, status: "education_required",
    planned_skills: [{ id, version: "1.0.0", execution_class: "default" }],
    profile_matches: [{ skill_id: id, status: "missing" }],
    required_tier: "tool_calling_strong", required_surface: null, privacy: "cloud_allowed", estimated_tokens: 4000,
    choices: [
      { kind: "lowest_cost", model_lineage: "google/gemini-flash", resolved_child: "google/gemini-3.5-flash", location: "cloud", estimated_cost_usd: 0.002 },
      { kind: "benchmark_best", model_lineage: "anthropic/claude-sonnet", resolved_child: "anthropic/claude-sonnet-4.6", location: "cloud", estimated_cost_usd: 0.02 },
      { kind: "intelligence", model_lineage: "google/gemini-flash", resolved_child: "google/gemini-3.5-flash", location: "cloud", estimated_cost_usd: 0.002 },
    ],
    economic_policy: { monthly_cloud_budget_usd: 8.33, monthly_headroom_usd: 8.33 },
  };
}

function harness({ planFor, now = PAST_NOW, calendarPort = { findEvent: async () => null } } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tl-contract-intent-"));
  const runCalls = [];
  const planCalls = [];
  const seam = {
    status: () => "available",
    planSkillRoute: async (req) => { planCalls.push(req); return planFor ? planFor(req) : educationPlan(req.plannedSkills[0].id); },
    recordSkillChoice: async () => {},
  };
  const runtime = { subagent: {
    run: async (i) => { runCalls.push(i); return { runId: `r${runCalls.length}`, sessionKey: i.sessionKey, runtime: { provider: i.provider, model: i.model } }; },
    waitForRun: async () => ({ status: "ok" }),
    getSessionMessages: async () => ({ messages: [{ role: "assistant", content: [{ type: "text", text: "BOUNDED CHILD RESULT" }] }] }),
  } };
  const scope = createCanaryScope({ enabled: true, channels: ["telegram"], accountIds: ["codex"], senderIds: ["7797183919"], ownerSenderIds: ["7797183919"] });
  const resolver = createSkillResolver({ catalog: REALITY_CATALOG });
  const contracts = createSkillContracts({ ownerTimezone: TZ, now: () => now, calendarPort });
  const coordinator = createSkillRoutingCoordinator({
    seam,
    config: { pendingStatePath: path.join(dir, "pending.json"), pendingTtlMinutes: 15, defaultEstimatedTokens: 4000, executionTimeoutSeconds: 120, monthlyCloudSpendUsd: 0, maxChildTokens: 200000, maxChildCostUsd: 5 },
    fallbackLogger: null, shadow: false, scope, resolver, contracts, runtime,
  });
  return { coordinator, runCalls, planCalls, dir };
}

function reply(text) { return { prompt: text, cleanedBody: text }; }

test("GATE: past 2 PM meeting on microsoft-graph CLARIFIES before the planner or any model", async () => {
  const h = harness({ now: PAST_NOW, planFor: () => selectedPlan("microsoft-graph") });
  const gate = await h.coordinator.handleGate(reply("Prep me for my 2 pm meeting in Outlook."), OWNER_CTX);
  assert.equal(gate.handled, true);
  assert.equal(gate.reason, "skill_contract_clarify");
  assert.match(gate.reply.text, /past|Outlook|upcoming|debrief/i);
  assert.equal(h.planCalls.length, 0, "clarified BEFORE the route planner ran");
  assert.equal(h.runCalls.length, 0, "no bounded child / model call");
});

test("GATE: future 2 PM meeting with NO Outlook event CLARIFIES (never fabricates)", async () => {
  const h = harness({ now: FUTURE_NOW, calendarPort: { findEvent: async () => null }, planFor: () => selectedPlan("microsoft-graph") });
  const gate = await h.coordinator.handleGate(reply("Prep me for my 2 pm meeting in Outlook."), OWNER_CTX);
  assert.equal(gate.handled, true);
  assert.equal(gate.reason, "skill_contract_clarify");
  assert.match(gate.reply.text, /can't find|Outlook/i);
  assert.equal(h.planCalls.length, 0, "clarified before the planner");
  assert.equal(h.runCalls.length, 0);
});

test("GATE: future 2 PM meeting with a UNIQUE Outlook event PROCEEDS to the bounded child", async () => {
  const h = harness({
    now: FUTURE_NOW,
    calendarPort: { findEvent: async () => ({ id: "evt-1", subject: "Board sync" }) },
    planFor: () => selectedPlan("microsoft-graph"),
  });
  const gate = await h.coordinator.handleGate(reply("Prep me for my 2 pm meeting in Outlook."), OWNER_CTX);
  assert.equal(gate.handled, true);
  assert.equal(gate.reason, "skill_selected_executed");
  assert.match(gate.reply.text, /BOUNDED CHILD RESULT/);
  assert.equal(h.planCalls.length, 1, "the planner ran once the meeting was confirmed");
  assert.equal(h.runCalls.length, 1, "the bounded child ran");
  // The meeting/calendar contract is injected into the microsoft-graph child too.
  assert.match(h.runCalls[0].extraSystemPrompt, /Outlook via Microsoft Graph|Microsoft Graph/);
  assert.match(h.runCalls[0].extraSystemPrompt, /NEVER synthesize/i);
});

test("GATE: generic Graph EMAIL work over microsoft-graph does NOT trigger the meeting contract", async () => {
  // No meeting intent → the calendar preflight does not apply even at 16:03 with
  // no calendar event. The turn proceeds to normal routing (education here).
  const h = harness({ now: PAST_NOW, calendarPort: { findEvent: async () => null } });
  const gate = await h.coordinator.handleGate(reply("Using microsoft-graph, send an email to the finance team about the Q3 report."), OWNER_CTX);
  assert.equal(gate.handled, true);
  assert.notEqual(gate.reason, "skill_contract_clarify", "email work is never gated by the calendar contract");
  assert.equal(gate.reason, "skill_education_required");
  assert.match(gate.reply.text, /use these skills: microsoft-graph/);
  assert.equal(h.planCalls.length, 1, "email work reaches the planner normally");
  assert.equal(h.runCalls.length, 0, "education preflight runs no model");
});

test("GATE: a meeting request resolved to ZOOM ALONE cannot establish an event → CLARIFY", async () => {
  // Even with a wired calendar port returning an event, a route with no
  // authoritative Outlook/Graph skill cannot confirm the meeting from Zoom.
  const h = harness({ now: FUTURE_NOW, calendarPort: { findEvent: async () => ({ id: "evt-1" }) }, planFor: () => selectedPlan("zoom-meetings") });
  const gate = await h.coordinator.handleGate(reply("Using Zoom, prep me for my 2 pm meeting."), OWNER_CTX);
  assert.equal(gate.handled, true);
  assert.equal(gate.reason, "skill_contract_clarify");
  assert.match(gate.reply.text, /Zoom isn't a calendar/i);
  assert.match(gate.reply.text, /Outlook|Microsoft Graph/);
  assert.equal(h.planCalls.length, 0, "clarified before the planner");
  assert.equal(h.runCalls.length, 0);
});

test("GATE: composed microsoft-graph + zoom-meetings — Graph is authoritative, a confirmed event PROCEEDS", async () => {
  const h = harness({
    now: FUTURE_NOW,
    calendarPort: { findEvent: async () => ({ id: "evt-2" }) },
    planFor: (req) => selectedPlan(req.plannedSkills[0].id),
  });
  const gate = await h.coordinator.handleGate(reply("Using microsoft-graph and Zoom, prep me for my 2 pm meeting."), OWNER_CTX);
  assert.equal(gate.handled, true);
  assert.equal(gate.reason, "skill_selected_executed");
  assert.equal(h.runCalls.length, 1);
});

test("GATE: composed microsoft-graph + zoom-meetings — a PAST meeting still clarifies before the planner", async () => {
  const h = harness({ now: PAST_NOW, planFor: (req) => selectedPlan(req.plannedSkills[0].id) });
  const gate = await h.coordinator.handleGate(reply("Using microsoft-graph and Zoom, prep me for my 2 pm meeting."), OWNER_CTX);
  assert.equal(gate.reason, "skill_contract_clarify");
  assert.equal(h.planCalls.length, 0);
  assert.equal(h.runCalls.length, 0);
});

// —— 1.6.1-rc.4 canary two-prompt regression, driven through the real gate ————

test("GATE canary A: ordinary prep of a PAST 2 PM meeting still CLARIFIES before the planner (cost-saving short-circuit preserved)", async () => {
  const h = harness({
    now: PAST_NOW,
    calendarPort: { findEvent: async () => ({ id: "evt-1" }) }, // the 2 PM event existed
    planFor: () => selectedPlan("microsoft-graph"),
  });
  const gate = await h.coordinator.handleGate(reply("Prep me for my 2 pm meeting in Outlook."), OWNER_CTX);
  assert.equal(gate.handled, true);
  assert.equal(gate.reason, "skill_contract_clarify");
  assert.equal(gate.audit.contract_reason, "past_meeting_reference");
  assert.equal(h.planCalls.length, 0, "clarified BEFORE the route planner ran");
  assert.equal(h.runCalls.length, 0, "no bounded child / model call");
});

test("GATE canary B: explicit 'check my Outlook calendar via Microsoft Graph' about a PAST 2 PM PROCEEDS through microsoft-graph to the bounded child", async () => {
  const h = harness({
    now: PAST_NOW,
    calendarPort: { findEvent: async () => ({ id: "evt-1" }) },
    planFor: () => selectedPlan("microsoft-graph"),
  });
  const gate = await h.coordinator.handleGate(
    reply("Check my Outlook calendar using Microsoft Graph and tell me whether I had a 2:00 PM meeting today. Do not infer anything from memory."),
    OWNER_CTX,
  );
  assert.equal(gate.handled, true);
  assert.notEqual(gate.reason, "skill_contract_clarify", "an explicit Outlook/Graph inspection must not be short-circuited by the past-meeting guard");
  assert.equal(gate.reason, "skill_selected_executed");
  assert.match(gate.reply.text, /BOUNDED CHILD RESULT/);
  assert.equal(h.planCalls.length, 1, "the planner ran — the request proceeded to routing");
  assert.equal(h.runCalls.length, 1, "the bounded microsoft-graph child ran");
  // It still executes UNDER the meeting/calendar contract — proceeding is not a
  // licence to fabricate; the child is bound to Outlook-authoritative, never-invent.
  assert.match(h.runCalls[0].extraSystemPrompt, /Outlook via Microsoft Graph|Microsoft Graph/);
  assert.match(h.runCalls[0].extraSystemPrompt, /NEVER synthesize/i);
});

test("GATE: the universal no-skill fail-safe is unchanged (actionable turn, nothing installed relates)", async () => {
  const h = harness();
  const gate = await h.coordinator.handleGate(reply("what's on my plate today?"), OWNER_CTX);
  assert.equal(gate.handled, true);
  assert.equal(gate.reason, "no_skill_failsafe");
  assert.equal(gate.reply.text, NO_SKILL_FAILSAFE);
  assert.equal(h.planCalls.length, 0);
  assert.equal(h.runCalls.length, 0);
});
