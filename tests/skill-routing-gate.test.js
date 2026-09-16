/*
 * ToggleLogic (Free Tier) — skill-routing GATE acceptance tests.
 *
 * These are the tests the 2026-09-15 canary was missing. They drive the REAL
 * before_agent_reply hook payload ({ cleanedBody }) + a REAL PluginHookAgentContext
 * (channel/accountId/senderId/sessionKey/trigger/inputProvenance, NO skill fields)
 * through the coordinator gate — never structured skills fed by hand, never a
 * planner called directly. A stub subagent records whether ANY model/tool work
 * happened downstream, so "zero downstream calls" is asserted, not assumed.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createSkillRoutingCoordinator, NO_SKILL_FAILSAFE } from "../src/skill-routing/coordinator.js";
import { createCanaryScope } from "../src/skill-routing/scope.js";
import { createSkillResolver } from "../src/skill-routing/resolver.js";
import { createSkillContracts } from "../src/skill-routing/skill-contracts.js";
import { createNonActionMatcher } from "../src/skill-routing/intent-categories.js";

const INCIDENT_PROMPT = "Prepare me for my 2 pm meeting using the meeting-prep skill.";
// 2026-09-15T20:03:00Z == 16:03 America/New_York (EDT) — 2 PM is already past.
const INCIDENT_NOW = Date.parse("2026-09-15T20:03:00Z");
// Al's SAM Telegram DM identity (from the live host binding).
const OWNER_CTX = Object.freeze({
  channel: "telegram", accountId: "codex", senderId: "7797183919",
  sessionKey: "agent:main:telegram:codex:7797183919", senderIsOwner: true,
  trigger: "user", inputProvenance: { kind: "external_user" },
});

function educationPlan(id, overrides = {}) {
  return {
    schema_version: 1, status: "education_required",
    planned_skills: [{ id, version: "1.0.0", execution_class: "default" }],
    profile_matches: [{ skill_id: id, status: "missing" }],
    required_tier: "tool_calling_strong", required_surface: null, privacy: "cloud_allowed",
    estimated_tokens: 4000,
    choices: [
      { kind: "lowest_cost", model_lineage: "google/gemini-flash", resolved_child: "google/gemini-3.5-flash", location: "cloud", estimated_cost_usd: 0.002 },
      { kind: "benchmark_best", model_lineage: "anthropic/claude-sonnet", resolved_child: "anthropic/claude-sonnet-4.6", location: "cloud", estimated_cost_usd: 0.02 },
      { kind: "intelligence", model_lineage: "google/gemini-flash", resolved_child: "google/gemini-3.5-flash", location: "cloud", estimated_cost_usd: 0.002 },
    ],
    economic_policy: { monthly_cloud_budget_usd: 8.33, monthly_headroom_usd: 8.33 },
    ...overrides,
  };
}

function harness({ planFor, shadow = false, scopeConfig, now = INCIDENT_NOW, calendarPort = { findEvent: async () => null }, catalog, nonActionCategories, classifier = null, clarifyOnMultiSkill = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tl-gate-acc-"));
  const runCalls = [];
  const recorded = [];
  const classifyCalls = [];
  const planCalls = [];
  const seam = {
    status: () => "available",
    classify: async (r) => { classifyCalls.push(r); return null; },
    planSkillRoute: async (req) => { planCalls.push(req); return planFor ? planFor(req) : educationPlan(req.plannedSkills[0].id); },
    recordSkillChoice: async (i) => { recorded.push(i); },
  };
  const runtime = { subagent: {
    run: async (i) => { runCalls.push(i); return { runId: `r${runCalls.length}`, sessionKey: i.sessionKey, runtime: { provider: i.provider, model: i.model } }; },
    waitForRun: async () => ({ status: "ok" }),
    getSessionMessages: async () => ({ messages: [{ role: "assistant", content: [{ type: "text", text: "BOUNDED CHILD RESULT" }] }] }),
  } };
  const scope = createCanaryScope(scopeConfig ?? {
    enabled: true, channels: ["telegram"], accountIds: ["codex"], senderIds: ["7797183919"], ownerSenderIds: ["7797183919"],
  });
  const resolver = createSkillResolver({ catalog: catalog ?? [{ id: "meeting-prep", aliases: ["meeting prep"] }, { id: "code-review", aliases: ["code review"] }] });
  const contracts = createSkillContracts({ ownerTimezone: "America/New_York", now: () => now, calendarPort });
  const nonAction = nonActionCategories ? createNonActionMatcher(nonActionCategories) : null;
  const coordinator = createSkillRoutingCoordinator({
    seam, config: { pendingStatePath: path.join(dir, "pending.json"), pendingTtlMinutes: 15, defaultEstimatedTokens: 4000, executionTimeoutSeconds: 120, monthlyCloudSpendUsd: 0, maxChildTokens: 200000, maxChildCostUsd: 5, clarifyOnMultiSkill },
    fallbackLogger: null, shadow, scope, resolver, contracts, runtime, nonAction, classifier,
  });
  return { coordinator, runCalls, recorded, classifyCalls, planCalls, dir };
}

// before_agent_reply delivers { cleanedBody }; the plugin maps it to prompt.
function reply(cleanedBody) { return { prompt: cleanedBody, cleanedBody }; }

test("ACCEPTANCE 1: exact incident prompt (past 2 PM) CLARIFIES before any route/education, ZERO downstream calls", async () => {
  // The deterministic safety preflight now fires the moment the skill resolves —
  // BEFORE route/model education. INCIDENT_PROMPT references a 2 PM meeting at
  // 16:03 owner-local (already past), so it is clarified immediately rather than
  // staging a three-choice education preflight for a meeting that can't run.
  const h = harness();
  const gate = await h.coordinator.handleGate(reply(INCIDENT_PROMPT), OWNER_CTX);
  assert.equal(gate.handled, true);
  assert.equal(gate.reason, "skill_contract_clarify");
  assert.match(gate.reply.text, /past|Outlook|upcoming|debrief/i);
  assert.doesNotMatch(gate.reply.text, /Reply TL-/, "no routing choice is staged for a past meeting");
  // The whole point: nothing executed, and the planner/model was never consulted.
  assert.equal(h.planCalls.length, 0, "clarified BEFORE the route planner ran");
  assert.equal(h.runCalls.length, 0, "no bounded child ran");
  assert.equal(h.recorded.length, 0, "no profile written");
});

test("ACCEPTANCE 2: past 2 PM with no Outlook event CLARIFIES rather than fabricating (execution path)", async () => {
  // Profile already learned → selected → contract preflight gates execution.
  const h = harness({ planFor: () => ({
    status: "selected", planned_skills: [{ id: "meeting-prep", version: "1.0.0" }],
    strategy: "lowest_cost", selected_lineage: "google/gemini-flash", selected_model_ref: "google/gemini-3.5-flash",
    estimated_tokens: 4000, choices: [{ kind: "lowest_cost", estimated_cost_usd: 0.002 }],
  }) });
  const gate = await h.coordinator.handleGate(reply(INCIDENT_PROMPT), OWNER_CTX);
  assert.equal(gate.handled, true);
  assert.equal(gate.reason, "skill_contract_clarify");
  assert.match(gate.reply.text, /Outlook|past|clarify|upcoming|debrief/i);
  assert.doesNotMatch(gate.reply.text, /BOUNDED CHILD RESULT/);
  assert.equal(h.runCalls.length, 0, "never executed a briefing for a past/unverified meeting");
});

test("ACCEPTANCE 2b: a confirmed upcoming meeting PROCEEDS to the bounded child", async () => {
  const h = harness({
    now: Date.parse("2026-09-15T17:00:00Z"), // 13:00 EDT; 2 PM is still upcoming
    calendarPort: { findEvent: async () => ({ id: "evt-1", start: "2026-09-15T14:00:00-04:00" }) },
    planFor: () => ({
      status: "selected", planned_skills: [{ id: "meeting-prep", version: "1.0.0" }],
      strategy: "lowest_cost", selected_lineage: "google/gemini-flash", selected_model_ref: "google/gemini-3.5-flash",
      estimated_tokens: 4000, choices: [{ kind: "lowest_cost", estimated_cost_usd: 0.002 }],
    }),
  });
  const gate = await h.coordinator.handleGate(reply(INCIDENT_PROMPT), OWNER_CTX);
  assert.equal(gate.handled, true);
  assert.equal(gate.reason, "skill_selected_executed");
  assert.match(gate.reply.text, /BOUNDED CHILD RESULT/);
  assert.equal(h.runCalls.length, 1);
});

test("ACCEPTANCE 3: wrong / replayed token is BLOCKED (never executes inline)", async () => {
  const h = harness();
  // Stage a real pending choice with a SAFE (non-meeting) skill so an education
  // choice is actually staged — a past-meeting prompt would clarify instead.
  const first = await h.coordinator.handleGate(reply("run the code-review skill on this diff"), OWNER_CTX);
  assert.match(first.reply.text, /Reply 1, 2, or 3/);
  // wrong token
  const wrong = await h.coordinator.handleGate(reply("TL-000000 1"), OWNER_CTX);
  assert.equal(wrong.handled, true);
  assert.equal(wrong.reason, "skill_choice_rejected");
  assert.equal(h.runCalls.length, 0);
  // right token → consumes; replay of the same token must then be rejected
  const good = await h.coordinator.handleGate(reply("1"), OWNER_CTX);
  assert.equal(good.handled, true);
  const replay = await h.coordinator.handleGate(reply("1"), OWNER_CTX);
  assert.equal(replay.reason, "no_skill_failsafe", "a consumed bare choice cannot replay a pending plan");
});

test("ACCEPTANCE 4: selected route executes in a bounded child (not the main session)", async () => {
  const h = harness();
  const first = await h.coordinator.handleGate(reply("run the code-review skill on this diff"), OWNER_CTX);
  const exec = await h.coordinator.handleGate(reply("1"), OWNER_CTX);
  assert.equal(exec.handled, true);
  assert.equal(exec.reason, "skill_choice_executed");
  assert.equal(h.runCalls.length, 1);
  const run = h.runCalls[0];
  assert.ok(run.sessionKey.includes(":togglelogic-skill:"), "ran in a bounded child session");
  assert.equal(run.provider, "google");
  assert.equal(run.deliver, false);
  // Supported bounded-context controls (openclaw 2026.9.4 SubagentRunParams).
  assert.equal(run.promptMode, "minimal", "bounded child uses the minimal subagent prompt");
  assert.equal(run.lightContext, true, "bounded child runs with light context");
  assert.equal(run.contextTokenBudget, undefined, "the unsupported contextTokenBudget field is not sent");
  assert.match(exec.reply.text, /BOUNDED CHILD RESULT/);
  assert.match(exec.reply.text, /bounded child session/);
});

test("ACCEPTANCE 5: a repeated skill reuses the learned profile deterministically", async () => {
  let planCalls = 0;
  const h = harness({ planFor: (req) => {
    planCalls += 1;
    return {
      status: "selected", planned_skills: [{ id: req.plannedSkills[0].id, version: "1.0.0" }],
      strategy: "benchmark_best", selected_lineage: "anthropic/claude-sonnet", selected_model_ref: "anthropic/claude-sonnet-4.6",
      estimated_tokens: 4000, choices: [{ kind: "benchmark_best", estimated_cost_usd: 0.02 }],
    };
  } });
  const a = await h.coordinator.handleGate(reply("run the code-review skill again"), OWNER_CTX);
  const b = await h.coordinator.handleGate(reply("run the code-review skill once more"), OWNER_CTX);
  assert.equal(a.reason, "skill_selected_executed");
  assert.equal(b.reason, "skill_selected_executed");
  assert.equal(h.runCalls.length, 2);
  assert.equal(h.runCalls[0].model, "claude-sonnet-4.6");
  assert.equal(h.runCalls[1].model, "claude-sonnet-4.6", "same learned child both times");
});

test("ACCEPTANCE 6: scope EXCLUDES Slack, other Telegram senders, cron, and CLI", async () => {
  const cases = [
    ["slack", { channel: "slack", accountId: "clickitco", senderId: "7797183919", sessionKey: "s", trigger: "user", inputProvenance: { kind: "external_user" } }],
    ["other-telegram-sender", { channel: "telegram", accountId: "codex", senderId: "999", sessionKey: "s", trigger: "user", inputProvenance: { kind: "external_user" } }],
    ["other-telegram-account", { channel: "telegram", accountId: "default", senderId: "7797183919", sessionKey: "s", trigger: "user", inputProvenance: { kind: "external_user" } }],
    ["cron", { ...OWNER_CTX, trigger: "cron" }],
    ["heartbeat", { ...OWNER_CTX, trigger: "heartbeat" }],
    ["cli-no-channel", { sessionKey: "cli-1", trigger: "user", senderId: "local" }],
    ["inter-session", { ...OWNER_CTX, inputProvenance: { kind: "inter_session" } }],
  ];
  for (const [label, ctx] of cases) {
    const h = harness();
    const gate = await h.coordinator.handleGate(reply(INCIDENT_PROMPT), ctx);
    assert.equal(gate.handled, false, `${label}: out-of-scope must not gate`);
    assert.equal(gate.audit.mode, "skill_routing_shadow", `${label}: recorded as shadow/passthrough`);
    assert.equal(h.runCalls.length, 0, `${label}: nothing executed`);
    assert.equal(h.recorded.length, 0, `${label}: no education/profile write`);
  }
});

test("ACCEPTANCE 6b: shadow mode never actively gates in-scope turns", async () => {
  const h = harness({ shadow: true });
  const gate = await h.coordinator.handleGate(reply(INCIDENT_PROMPT), OWNER_CTX);
  assert.equal(gate.handled, false);
  assert.equal(gate.audit.mode, "skill_routing_shadow");
  assert.equal(h.runCalls.length, 0);
});

test("ACCEPTANCE 7: naming a specifically UNAVAILABLE skill returns the no-skill fail-safe (never guesses)", async () => {
  // Owner rule: "A specifically named unavailable skill must produce the same
  // no-skill fail-safe." quarterly-magic is not an installed active skill.
  const h = harness();
  const gate = await h.coordinator.handleGate(reply("do it using the quarterly-magic skill"), OWNER_CTX);
  assert.equal(gate.handled, true);
  assert.equal(gate.reason, "skill_named_unavailable");
  assert.equal(gate.reply.text, NO_SKILL_FAILSAFE);
  assert.equal(h.runCalls.length, 0);
});

test("ACCEPTANCE 8: bounded-child token ceiling FAILS CLOSED (handled), never amplifies or throws into the hook", async () => {
  const h = harness({ planFor: () => ({
    status: "selected", planned_skills: [{ id: "code-review", version: "1.0.0" }],
    strategy: "lowest_cost", selected_lineage: "google/gemini-flash", selected_model_ref: "google/gemini-3.5-flash",
    estimated_tokens: 452391, // the incident's inline load — must be refused as a bounded child
    choices: [{ kind: "lowest_cost", estimated_cost_usd: 0.002 }],
  }) });
  // The gate now fails CLOSED (handled error), not by throwing into the hook.
  const gate = await h.coordinator.handleGate(reply("run the code-review skill"), OWNER_CTX);
  assert.equal(gate.handled, true);
  assert.equal(gate.reason, "skill_routing_gate_error");
  assert.match(gate.reply.text, /exceeds the bounded-child ceiling|held this turn/);
  assert.equal(h.runCalls.length, 0);
});

test("ACCEPTANCE 9: an actionable governed turn with NO related installed skill returns the fail-safe (never silent passthrough)", async () => {
  // Owner rule: do not silently pass an actionable request to a general model.
  const h = harness();
  const gate = await h.coordinator.handleGate(reply("what's on my plate today?"), OWNER_CTX);
  assert.equal(gate.handled, true, "governed no-skill request is handled, not passed through");
  assert.equal(gate.reason, "no_skill_failsafe");
  assert.equal(gate.reply.text, NO_SKILL_FAILSAFE);
  assert.equal(h.runCalls.length, 0);
});

test("ACCEPTANCE 9b: an explicit deployment-owned non-action category bypasses the skill gate", async () => {
  const h = harness({ nonActionCategories: [
    { id: "greeting", phrases: ["hi", "hello", "thanks"], patterns: ["^\\s*(?:hi|hey|hello|good\\s+(?:morning|afternoon|evening))(?:[,.!\\s]+sam)?[.!?]*\\s*$"] },
    { id: "acknowledgement", phrases: ["perfect", "great", "sounds good", "got it"] },
  ] });
  const gate = await h.coordinator.handleGate(reply("hello"), OWNER_CTX);
  assert.equal(gate.handled, false, "declared non-action message returns to normal handling");
  assert.equal(gate.audit.mode, "non_action_category");
  assert.equal(gate.audit.category, "greeting");
  assert.equal(h.runCalls.length, 0);
  const namedGreeting = await h.coordinator.handleGate(reply("Good morning, Sam."), OWNER_CTX);
  assert.equal(namedGreeting.handled, false, "a pure greeting addressed to SAM remains conversational");
  const acknowledgement = await h.coordinator.handleGate(reply("Perfect!"), OWNER_CTX);
  assert.equal(acknowledgement.handled, false, "a pure acknowledgement remains conversational");
  assert.equal(acknowledgement.audit.category, "acknowledgement");
  // But an actionable message still hits the fail-safe.
  const actionable = await h.coordinator.handleGate(reply("reconcile the quarterly ledger"), OWNER_CTX);
  assert.equal(actionable.reason, "no_skill_failsafe");
  const greetingPlusTask = await h.coordinator.handleGate(reply("Good morning, Sam. Reconcile the quarterly ledger."), OWNER_CTX);
  assert.equal(greetingPlusTask.reason, "no_skill_failsafe", "a greeting prefix never exempts an actionable request");
  const acknowledgementPlusTask = await h.coordinator.handleGate(reply("Perfect! Reconcile the quarterly ledger."), OWNER_CTX);
  assert.equal(acknowledgementPlusTask.reason, "no_skill_failsafe", "an acknowledgement prefix never exempts an actionable request");
});

test("ACCEPTANCE 9bb: bounded local conversation classification preserves Chief-of-Staff conversation", async () => {
  const h = harness({ classifier: { enabled: true, classify: async () => ({ status: "conversation", confidence: 0.96 }) } });
  const gate = await h.coordinator.handleGate(reply("I think we made real progress today."), OWNER_CTX);
  assert.equal(gate.handled, false);
  assert.equal(gate.audit.mode, "conversation");
  assert.equal(h.runCalls.length, 0, "conversation classification never executes a skill child");
});

test("ACCEPTANCE 9c: out-of-scope no-skill turns stay passthrough (not falsely governed)", async () => {
  const h = harness();
  const slack = { channel: "slack", accountId: "clickitco", senderId: "7797183919", sessionKey: "s", trigger: "user", inputProvenance: { kind: "external_user" } };
  const gate = await h.coordinator.handleGate(reply("what's on my plate today?"), slack);
  assert.equal(gate, null, "out-of-scope no-skill turn falls through to prior safe behavior");
});

test("ACCEPTANCE 9d: multi-skill ambiguity asks ONE bounded clarification when clarifyOnMultiSkill is on", async () => {
  const h = harness({ clarifyOnMultiSkill: true });
  const gate = await h.coordinator.handleGate(reply("run the code-review skill and the meeting-prep skill"), OWNER_CTX);
  assert.equal(gate.handled, true);
  assert.equal(gate.reason, "skill_ambiguous_multi");
  assert.match(gate.reply.text, /more than one installed skill/i);
  assert.equal(h.runCalls.length, 0, "executes nothing while ambiguous");
});

test("ACCEPTANCE 10: a resolved skill whose route can't be planned FAILS LOUD, never runs inline", async () => {
  // A SAFE skill (no meeting contract to gate it) so the turn reaches the planner
  // and exercises the plan-failure path.
  const h = harness({ planFor: () => { throw new Error("intelligence unavailable"); } });
  const gate = await h.coordinator.handleGate(reply("run the code-review skill on this diff"), OWNER_CTX);
  assert.equal(gate.handled, true, "held the turn rather than falling through to inline execution");
  assert.equal(gate.reason, "skill_routing_plan_unavailable");
  assert.match(gate.reply.text, /held this turn|try again/i);
  assert.equal(h.runCalls.length, 0);
});
