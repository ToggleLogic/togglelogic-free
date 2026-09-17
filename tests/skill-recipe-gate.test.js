/*
 * ToggleLogic (Free Tier) — intent-recipe GATE acceptance tests (1.6.1-rc.2).
 *
 * Drives the REAL before_agent_reply gate with a deterministic intent recipe wired
 * alongside the deterministic resolver, a per-skill contract, and a bounded local
 * classifier (injected transport). Proves the owner-critical composition:
 *
 *   "Prepare me for my 2 PM meeting today"  → recipe resolves microsoft-graph +
 *      zoom-meetings DETERMINISTICALLY → the meeting/calendar contract clarifies at
 *      16:03 (2 PM already past) with ZERO planner / model / classifier calls.
 *   "Send an Outlook email ..."             → no recipe → bounded classifier → Graph.
 *   "Write me a poem ..."                   → no skill / recipe / classifier → the
 *      exact universal no-skill fail-safe (unchanged sentence).
 *
 * Plus the fail-safe regressions: an absent required skill and conflicting recipes.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createSkillRoutingCoordinator, NO_SKILL_FAILSAFE } from "../src/skill-routing/coordinator.js";
import { createCanaryScope } from "../src/skill-routing/scope.js";
import { createSkillResolver, createSkillClassifier } from "../src/skill-routing/resolver.js";
import { createSkillContracts } from "../src/skill-routing/skill-contracts.js";
import { createIntentRecipes } from "../src/skill-routing/intent-recipes.js";

// 2026-09-15T20:03:00Z == 16:03 America/New_York (EDT) — 2 PM is already past.
const INCIDENT_NOW = Date.parse("2026-09-15T20:03:00Z");
const OWNER_CTX = Object.freeze({
  channel: "telegram", accountId: "codex", senderId: "7797183919",
  sessionKey: "agent:main:telegram:codex:7797183919", senderIsOwner: true,
  trigger: "user", inputProvenance: { kind: "external_user" },
});
const SLACK_CTX = Object.freeze({
  channel: "slack", accountId: "clickitco", senderId: "7797183919",
  sessionKey: "s", trigger: "user", inputProvenance: { kind: "external_user" },
});

// Verified catalog with real descriptions (as the snapshot would supply). No
// aliases that could exact-match the meeting prompt — it must reach the recipe.
const CATALOG = [
  { id: "microsoft-graph", version: "3.2.0", fingerprint: "fp-graph-a837", execution_class: "tool", description: "Email, calendar, and contacts via Microsoft Graph (authoritative Outlook calendar)" },
  { id: "zoom-meetings", version: "2.4.1", fingerprint: "fp-zoom-19bc", execution_class: "tool", description: "Zoom meeting recordings and transcripts" },
  { id: "code-review", version: "1.8.0", fingerprint: "fp-review-442a", execution_class: "artifact", description: "Review a diff for correctness" },
];
const MEETING_RECIPE = {
  id: "meeting-prep-compose",
  anyTerms: ["meeting", "calendar", "appointment", "agenda"],
  skillIds: ["microsoft-graph", "zoom-meetings"],
};

function educationPlan(id) {
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
  };
}

function harness({ recipes = [MEETING_RECIPE], now = INCIDENT_NOW, planFor, catalog = CATALOG } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tl-recipe-gate-"));
  const runCalls = [];
  const recorded = [];
  const planCalls = [];
  const invokeCalls = [];
  const seam = {
    status: () => "available",
    classify: async () => null,
    planSkillRoute: async (req) => { planCalls.push(req); return planFor ? planFor(req) : educationPlan(req.plannedSkills[0].id); },
    recordSkillChoice: async (i) => { recorded.push(i); },
  };
  const runtime = { subagent: {
    run: async (i) => { runCalls.push(i); return { runId: `r${runCalls.length}`, sessionKey: i.sessionKey, runtime: { provider: i.provider, model: i.model } }; },
    waitForRun: async () => ({ status: "ok" }),
    getSessionMessages: async () => ({ messages: [{ role: "assistant", content: [{ type: "text", text: "BOUNDED CHILD RESULT" }] }] }),
  } };
  const scope = createCanaryScope({ enabled: true, channels: ["telegram"], accountIds: ["codex"], senderIds: ["7797183919"], ownerSenderIds: ["7797183919"] });
  const resolver = createSkillResolver({ catalog });
  const contracts = createSkillContracts({ ownerTimezone: "America/New_York", now: () => now, calendarPort: { findEvent: async () => null } });
  const intentRecipes = createIntentRecipes(recipes);
  const classifier = createSkillClassifier(
    { enabled: true, model: "gemma-test", confidenceThreshold: 0.6, numCtx: 8192 },
    { invoke: async (req) => {
      invokeCalls.push(req);
      // Bounded router — only ever returns a listed id + confidence, never a task.
      if (/email/i.test(req.prompt)) return JSON.stringify({ skill_id: "microsoft-graph", confidence: 0.9 });
      return JSON.stringify({ skill_id: null, confidence: 0.0 });
    } },
  );
  const coordinator = createSkillRoutingCoordinator({
    seam,
    config: { pendingStatePath: path.join(dir, "pending.json"), pendingTtlMinutes: 15, defaultEstimatedTokens: 4000, executionTimeoutSeconds: 120, monthlyCloudSpendUsd: 0, maxChildTokens: 200000, maxChildCostUsd: 5, clarifyOnMultiSkill: false },
    fallbackLogger: null, shadow: false, scope, resolver, contracts, runtime, intentRecipes, classifier,
  });
  return { coordinator, runCalls, recorded, planCalls, invokeCalls, dir };
}

function reply(cleanedBody) { return { prompt: cleanedBody, cleanedBody }; }

test("RECIPE 1: 'prepare me for my 2 PM meeting today' composes microsoft-graph + zoom-meetings, then the contract clarifies — ZERO model/planner/classifier calls", async () => {
  const h = harness();
  const gate = await h.coordinator.handleGate(reply("Prepare me for my 2 PM meeting today"), OWNER_CTX);
  assert.equal(gate.handled, true);
  assert.equal(gate.reason, "skill_contract_clarify");
  assert.match(gate.reply.text, /past|Outlook|upcoming|debrief/i);
  assert.doesNotMatch(gate.reply.text, /Reply TL-/, "no routing choice staged for a past meeting");
  // The recipe deterministically resolved BOTH installed skills.
  assert.deepEqual(gate.audit.planned_skills.map((s) => s.id).sort(), ["microsoft-graph", "zoom-meetings"]);
  // The whole point: the model, planner, and classifier were never consulted.
  assert.equal(h.planCalls.length, 0, "clarified before the planner ran");
  assert.equal(h.runCalls.length, 0, "no bounded child ran");
  assert.equal(h.invokeCalls.length, 0, "classifier never consulted — recipe resolved deterministically");
});

test("RECIPE 1b: an explicit Microsoft Graph reference does not suppress the Graph+Zoom meeting composition", async () => {
  const h = harness();
  const gate = await h.coordinator.handleGate(reply(
    "Sam, prepare me for my next real meeting tomorrow. Check my Outlook calendar through Microsoft Graph first, and use Zoom only if a prior transcript is relevant. If there is no unique meeting, ask me to clarify rather than guessing.",
  ), OWNER_CTX);
  assert.equal(gate.handled, true);
  assert.equal(gate.reason, "skill_education_required");
  assert.deepEqual(h.planCalls[0].plannedSkills.map((skill) => skill.id).sort(), ["microsoft-graph", "zoom-meetings"]);
  assert.equal(h.planCalls.length, 1, "the complete composed workflow reaches route planning");
  assert.equal(h.runCalls.length, 0, "no bounded child runs before a unique calendar event exists");
  assert.equal(h.invokeCalls.length, 0, "the deterministic recipe resolves the composition without a classifier");
});

test("RECIPE: incidental canvas, Gamma, and image mentions do not conflict with the existing-PowerPoint workflow", async () => {
  const catalog = [
    { id: "powerpoint-editor", version: "1.7.0", fingerprint: "fp-ppt", execution_class: "artifact", description: "Edit existing PowerPoint decks" },
    { id: "canvas", version: "1.0.0", fingerprint: "fp-canvas", execution_class: "tool", description: "Canvas panels" },
    { id: "gamma", version: "1.0.0", fingerprint: "fp-gamma", execution_class: "tool", description: "Generate new Gamma presentations" },
    { id: "image", version: "1.0.0", fingerprint: "fp-image", execution_class: "artifact", description: "Create images" },
  ];
  const h = harness({
    catalog,
    recipes: [{ id: "existing-powerpoint-edit", allTerms: ["powerpoint"], anyTerms: ["rewrite", "script", "slides"], skillIds: ["powerpoint-editor"] }],
  });
  const gate = await h.coordinator.handleGate(reply(
    "Rewrite my script so it follows the current PowerPoint slides and keeps the same images. Use your pitch-deck judgment; I mentioned Gamma and canvas as context.",
  ), OWNER_CTX);
  assert.equal(gate.reason, "skill_education_required");
  assert.deepEqual(h.planCalls[0].plannedSkills.map((skill) => skill.id), ["powerpoint-editor"]);
  assert.equal(h.invokeCalls.length, 0);
});

test("RECIPE 2: a generic Outlook email (no recipe match) routes through the bounded classifier to microsoft-graph", async () => {
  const h = harness();
  const gate = await h.coordinator.handleGate(reply("Send an Outlook email to the finance team about the invoice"), OWNER_CTX);
  assert.equal(gate.handled, true);
  assert.equal(gate.reason, "skill_education_required", "generic Graph email is NOT gated by the meeting contract");
  assert.equal(h.invokeCalls.length, 1, "the classifier resolved the un-named email request");
  assert.match(h.invokeCalls[0].system, /microsoft-graph: Email, calendar/, "classifier was given id + description");
  assert.equal(h.planCalls.length, 1, "routed to the planner");
  assert.deepEqual(h.planCalls[0].plannedSkills[0], {
    id: "microsoft-graph", version: "3.2.0", fingerprint: "fp-graph-a837", execution_class: "tool",
  });
});

test("RECIPE identity: owner learning persists the verified version/fingerprint even when the planner echo is lossy", async () => {
  const catalog = [{
    id: "powerpoint-editor", version: "1.7.0", fingerprint: "fp-a837", execution_class: "artifact",
    description: "Inspect, edit, render, and verify PowerPoint decks",
  }];
  const h = harness({
    catalog,
    recipes: [{ id: "slides", anyTerms: ["presentation"], skillIds: ["powerpoint-editor"] }],
    planFor: (req) => ({ ...educationPlan("powerpoint-editor"), planned_skills: [{ id: "powerpoint-editor" }] }),
  });
  const first = await h.coordinator.handleGate(reply("Update this presentation"), OWNER_CTX);
  assert.equal(first.reason, "skill_education_required");
  assert.deepEqual(h.planCalls[0].plannedSkills[0], {
    id: "powerpoint-editor", version: "1.7.0", fingerprint: "fp-a837", execution_class: "artifact",
  });
  await h.coordinator.handleGate(reply("1"), OWNER_CTX);
  assert.deepEqual(h.recorded[0].skill, {
    id: "powerpoint-editor", version: "1.7.0", fingerprint: "fp-a837", execution_class: "artifact",
  });
  assert.notEqual(h.recorded[0].skill.version, "*");
});

test("RECIPE identity: fingerprint change reaches Intelligence and requires re-teaching instead of reusing the old profile", async () => {
  const learnedFingerprint = "fp-a837";
  const planner = (req) => {
    const skill = req.plannedSkills[0];
    if (skill.fingerprint === learnedFingerprint) {
      return {
        status: "selected", planned_skills: req.plannedSkills, strategy: "lowest_cost",
        selected_lineage: "google/gemini-flash", selected_model_ref: "google/gemini-3.5-flash",
        estimated_tokens: 4000, choices: [{ kind: "lowest_cost", estimated_cost_usd: 0.002 }],
      };
    }
    return { ...educationPlan(skill.id), planned_skills: req.plannedSkills, profile_matches: [{ skill_id: skill.id, status: "fingerprint_changed" }] };
  };
  const common = { recipes: [{ id: "slides", anyTerms: ["presentation"], skillIds: ["powerpoint-editor"] }], planFor: planner };
  const current = harness({ ...common, catalog: [{ id: "powerpoint-editor", version: "1.7.0", fingerprint: learnedFingerprint, execution_class: "artifact" }] });
  const selected = await current.coordinator.handleGate(reply("Update this presentation"), OWNER_CTX);
  assert.equal(selected.reason, "skill_selected_artifact_delivery_incomplete", "the learned route is selected; this fixture intentionally returns no artifact manifest");

  const changed = harness({ ...common, catalog: [{ id: "powerpoint-editor", version: "1.7.1", fingerprint: "fp-b991", execution_class: "artifact" }] });
  const reteach = await changed.coordinator.handleGate(reply("Update this presentation"), OWNER_CTX);
  assert.equal(reteach.reason, "skill_education_required");
  assert.equal(changed.planCalls[0].plannedSkills[0].fingerprint, "fp-b991");
});

test("RECIPE identity: missing verified identity fails closed before planning", async () => {
  const h = harness({
    catalog: [{ id: "powerpoint-editor", description: "Edit PowerPoint decks" }],
    recipes: [{ id: "slides", anyTerms: ["presentation"], skillIds: ["powerpoint-editor"] }],
  });
  const gate = await h.coordinator.handleGate(reply("Update this presentation"), OWNER_CTX);
  assert.equal(gate.reason, "skill_identity_unavailable");
  assert.match(gate.reply.text, /no wildcard routing profile/i);
  assert.equal(h.planCalls.length, 0);
  assert.equal(h.recorded.length, 0);
});

test("CLASSIFIER identity: missing verified identity fails closed before planning", async () => {
  const h = harness({ catalog: [{ id: "microsoft-graph", description: "Email via Microsoft Graph" }] });
  const gate = await h.coordinator.handleGate(reply("Send an Outlook email to finance"), OWNER_CTX);
  assert.equal(gate.reason, "skill_identity_unavailable");
  assert.equal(gate.audit.source, "bounded_classifier");
  assert.equal(h.planCalls.length, 0);
});

test("RECIPE 3: an unrelated poem reaches the exact no-skill fail-safe (universal sentence unchanged)", async () => {
  const h = harness();
  const gate = await h.coordinator.handleGate(reply("Write me a poem about the sea"), OWNER_CTX);
  assert.equal(gate.handled, true);
  assert.equal(gate.reason, "no_skill_failsafe");
  assert.equal(gate.reply.text, NO_SKILL_FAILSAFE);
  assert.equal(h.invokeCalls.length, 1, "classifier consulted and returned no skill");
  assert.equal(h.planCalls.length, 0);
  assert.equal(h.runCalls.length, 0);
});

test("CHIEF OF STAFF: a draft-only WhatsApp post passes through as tool-free writing", async () => {
  const h = harness();
  const gate = await h.coordinator.handleGate(reply(
    "Can you write me something I could post in WhatsApp that is nice, straightforward, and encouraging?",
  ), OWNER_CTX);
  assert.equal(gate.handled, false);
  assert.equal(gate.audit.mode, "tool_free_work");
  assert.equal(gate.audit.category, "tool_free_writing");
  assert.equal(h.invokeCalls.length, 0);
  assert.equal(h.planCalls.length, 0);
});

test("CHIEF OF STAFF: an instruction to publish the post does not bypass the skill gate", async () => {
  const h = harness();
  const gate = await h.coordinator.handleGate(reply("Write and post a message in WhatsApp announcing the event."), OWNER_CTX);
  assert.equal(gate.handled, true);
  assert.equal(gate.reason, "no_skill_failsafe");
});

test("CHIEF OF STAFF: external delivery phrasing never uses the tool-free writing exemption", async () => {
  for (const prompt of [
    "Polish this reply and email it to al@example.test",
    "Draft a message and email it to the finance team",
    "Rewrite the caption and DM it to the client",
    "Draft a note and text the client",
  ]) {
    const h = harness();
    const gate = await h.coordinator.handleGate(reply(prompt), OWNER_CTX);
    assert.equal(gate.handled, true, prompt);
    assert.notEqual(gate.audit?.mode, "tool_free_work", prompt);
  }
});

test("CHIEF OF STAFF: source-dependent drafting falls through to governed resolution", async () => {
  const h = harness();
  const gate = await h.coordinator.handleGate(reply("Draft a note summarizing the latest QuickBooks P&L."), OWNER_CTX);
  assert.equal(gate.handled, true);
  assert.equal(gate.reason, "no_skill_failsafe");
});

test("CHIEF OF STAFF: drafting an email without sending remains tool-free writing", async () => {
  const h = harness();
  const gate = await h.coordinator.handleGate(reply("Draft an email message to the finance team about the quarterly update."), OWNER_CTX);
  assert.equal(gate.handled, false);
  assert.equal(gate.audit.mode, "tool_free_work");
});

test("RECIPE 4: a recipe whose required skill is NOT installed fails safe to the no-skill fail-safe", async () => {
  const h = harness({ recipes: [{ id: "payroll", anyTerms: ["payroll"], skillIds: ["workday"] }] });
  const gate = await h.coordinator.handleGate(reply("run payroll for this cycle"), OWNER_CTX);
  assert.equal(gate.handled, true);
  assert.equal(gate.reason, "no_skill_failsafe");
  assert.equal(gate.audit.recipe, "recipe_skills_absent", "the matched recipe was inert because workday is not installed");
  assert.equal(gate.reply.text, NO_SKILL_FAILSAFE);
  assert.equal(h.planCalls.length, 0);
  assert.equal(h.runCalls.length, 0);
});

test("RECIPE 5: conflicting recipes (different skill sets) fail closed with one clarification, BEFORE the classifier", async () => {
  const h = harness({ recipes: [
    { id: "r-graph", anyTerms: ["report"], skillIds: ["microsoft-graph"] },
    { id: "r-review", anyTerms: ["report"], skillIds: ["code-review"] },
  ] });
  const gate = await h.coordinator.handleGate(reply("generate the report now"), OWNER_CTX);
  assert.equal(gate.handled, true);
  assert.equal(gate.reason, "skill_recipe_ambiguous");
  assert.match(gate.reply.text, /more than one configured intent recipe/i);
  assert.deepEqual(gate.audit.rule_ids.sort(), ["r-graph", "r-review"]);
  assert.equal(h.invokeCalls.length, 0, "conflicting recipes fail closed before the classifier");
  assert.equal(h.planCalls.length, 0);
  assert.equal(h.runCalls.length, 0);
});

test("RECIPE 6: out-of-scope turns preserve passthrough — recipes never evaluate off-canary", async () => {
  const h = harness();
  const gate = await h.coordinator.handleGate(reply("Prepare me for my 2 PM meeting today"), SLACK_CTX);
  assert.equal(gate, null, "out-of-scope no-skill turn falls through to prior safe behavior");
  assert.equal(h.invokeCalls.length, 0);
  assert.equal(h.planCalls.length, 0);
  assert.equal(h.runCalls.length, 0);
});
