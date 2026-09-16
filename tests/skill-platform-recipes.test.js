/*
 * ToggleLogic (Free Tier) — deterministic PLATFORM intent-recipe acceptance tests
 * (1.6.1-rc.3, Blocker 6).
 *
 * The real local Gemma classifier misrouted explicit-platform prompts over the
 * verified 57-skill catalog — e.g. "Find the latest email from Chris in Outlook."
 * came back AMBIGUOUS between microsoft-graph and gog @0.95. Rather than trust a
 * probabilistic model for an explicit platform name, the DEPLOYMENT declares
 * high-precision, inventory-bound recipes that resolve BEFORE the classifier:
 *
 *   explicit Outlook + email/mail/inbox  -> microsoft-graph
 *   explicit Zoom    + transcript/record -> zoom-meetings
 *
 * These resolve ONLY when the target skill is installed (else inert -> universal
 * no-skill fail-safe), and NEVER fire on generic Google/Gmail or generic meeting
 * text. The existing meeting-prep Graph+Zoom recipe is preserved. This file pins
 * both the recipe-engine PRECISION and the GATE behavior (incl. classifier call
 * counts: the recipe must short-circuit before the model).
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

// The Outlook/Zoom/meeting subset of the recipes shipped in
// docs/examples/sam-hq-owner-policy.openclaw.json — the set this file pins for
// outlook-mail / zoom-recording PRECISION (esp. that a generic Gmail email is NOT
// captured by outlook-mail). The shipped example ALSO carries a `gmail-mail` recipe
// (explicit `gmail` + an email term -> `gog`); that recipe and its precision +
// per-skill mailbox identity are covered in tests/skill-mailbox-identity.test.js.
export const PLATFORM_RECIPES = [
  { id: "high-precision-meeting-prep", allTerms: ["meeting"], anyTerms: ["prepare", "prep", "brief", "briefing", "get ready", "ready for", "prep me"], skillIds: ["microsoft-graph", "zoom-meetings"] },
  { id: "outlook-mail", allTerms: ["outlook"], anyTerms: ["email", "emails", "mail", "inbox", "message", "messages"], skillIds: ["microsoft-graph"] },
  { id: "zoom-recording", allTerms: ["zoom"], anyTerms: ["transcript", "transcripts", "recording", "recordings", "recorded"], skillIds: ["zoom-meetings"] },
];
const INSTALLED = ["microsoft-graph", "zoom-meetings", "gmail", "gog", "code-review"];

// ---- recipe-engine PRECISION (deterministic, no model) ----

test("outlook-mail resolves microsoft-graph for an explicit Outlook email prompt", () => {
  const r = createIntentRecipes(PLATFORM_RECIPES).resolve("Find the latest email from Chris in Outlook.", { installedIds: INSTALLED });
  assert.equal(r.status, "resolved");
  assert.equal(r.ruleId, "outlook-mail");
  assert.deepEqual(r.skills, ["microsoft-graph"]);
});

test("outlook-mail does NOT capture generic Gmail/Google email (no 'outlook' token)", () => {
  const recipes = createIntentRecipes(PLATFORM_RECIPES);
  for (const prompt of [
    "Find the latest email in Gmail from Chris.",
    "Check my Google inbox for the invoice.",
    "Read my most recent email.",
  ]) {
    assert.equal(recipes.resolve(prompt, { installedIds: INSTALLED }).status, "none", prompt);
  }
});

test("zoom-recording resolves zoom-meetings for an explicit Zoom recording/transcript prompt", () => {
  const recipes = createIntentRecipes(PLATFORM_RECIPES);
  for (const prompt of [
    "Summarize the Zoom recording transcript for the Q3 launch.",
    "Pull the Zoom recording from the launch review.",
  ]) {
    const r = recipes.resolve(prompt, { installedIds: INSTALLED });
    assert.equal(r.status, "resolved", prompt);
    assert.equal(r.ruleId, "zoom-recording");
    assert.deepEqual(r.skills, ["zoom-meetings"]);
  }
});

test("zoom-recording does NOT capture generic meeting text (no 'zoom' token)", () => {
  const recipes = createIntentRecipes(PLATFORM_RECIPES);
  for (const prompt of [
    "What is on the agenda for the standup?",
    "Do I have any meetings this afternoon?",
    "Get the transcript of the all-hands.",
  ]) {
    // These may match meeting-prep (if a prep verb is present) but MUST NOT match
    // zoom-recording, and must never resolve zoom-meetings alone from generic text.
    const r = recipes.resolve(prompt, { installedIds: INSTALLED });
    if (r.status === "resolved") assert.notEqual(r.ruleId, "zoom-recording", prompt);
  }
});

test("meeting-prep is preserved as a Graph+Zoom composition", () => {
  const r = createIntentRecipes(PLATFORM_RECIPES).resolve("Prepare me for my 2 PM meeting today", { installedIds: INSTALLED });
  assert.equal(r.status, "resolved");
  assert.equal(r.ruleId, "high-precision-meeting-prep");
  assert.deepEqual(r.skills.sort(), ["microsoft-graph", "zoom-meetings"]);
});

test("a platform recipe is INERT when its target skill is not installed (falls to fail-safe upstream)", () => {
  const r = createIntentRecipes(PLATFORM_RECIPES).resolve("Get the Zoom recording transcript for the launch.", { installedIds: ["microsoft-graph", "code-review"] });
  assert.equal(r.status, "none");
  assert.equal(r.reason, "recipe_skills_absent");
});

// ---- GATE behavior (recipe must short-circuit BEFORE the classifier) ----

const NOW = Date.parse("2026-09-15T20:03:00Z");
const OWNER_CTX = Object.freeze({
  channel: "telegram", accountId: "codex", senderId: "7797183919",
  sessionKey: "agent:main:telegram:codex:7797183919", senderIsOwner: true,
  trigger: "user", inputProvenance: { kind: "external_user" },
});
const CATALOG = [
  { id: "microsoft-graph", description: "Email, calendar, and contacts via Microsoft Graph (authoritative Outlook calendar)" },
  { id: "zoom-meetings", description: "Zoom meeting recordings and transcripts" },
  { id: "gog", description: "Google organizational graph directory lookups" },
  { id: "code-review", description: "Review a diff for correctness" },
];

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

function harness({ recipes = PLATFORM_RECIPES, catalog = CATALOG, classifierReply } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tl-plat-recipe-"));
  const planCalls = [];
  const invokeCalls = [];
  const seam = {
    status: () => "available",
    planSkillRoute: async (req) => { planCalls.push(req); return educationPlan(req.plannedSkills[0].id); },
    recordSkillChoice: async () => {},
  };
  const runtime = { subagent: {
    run: async () => ({ runId: "r1", sessionKey: "s", runtime: {} }),
    waitForRun: async () => ({ status: "ok" }),
    getSessionMessages: async () => ({ messages: [{ role: "assistant", content: [{ type: "text", text: "R" }] }] }),
  } };
  const scope = createCanaryScope({ enabled: true, channels: ["telegram"], accountIds: ["codex"], senderIds: ["7797183919"], ownerSenderIds: ["7797183919"] });
  const resolver = createSkillResolver({ catalog });
  const contracts = createSkillContracts({ ownerTimezone: "America/New_York", now: () => NOW, calendarPort: { findEvent: async () => null } });
  const intentRecipes = createIntentRecipes(recipes);
  const classifier = createSkillClassifier(
    { enabled: true, model: "gemma-test", confidenceThreshold: 0.6, numCtx: 8192 },
    { invoke: async (req) => {
      invokeCalls.push(req);
      if (classifierReply) return classifierReply(req);
      if (/email|inbox|mail/i.test(req.prompt)) return JSON.stringify({ skill_id: "microsoft-graph", confidence: 0.9 });
      return JSON.stringify({ skill_id: null, confidence: 0.0 });
    } },
  );
  const coordinator = createSkillRoutingCoordinator({
    seam,
    config: { pendingStatePath: path.join(dir, "pending.json"), pendingTtlMinutes: 15, defaultEstimatedTokens: 4000, executionTimeoutSeconds: 120, monthlyCloudSpendUsd: 0, maxChildTokens: 200000, maxChildCostUsd: 5, clarifyOnMultiSkill: false },
    fallbackLogger: null, shadow: false, scope, resolver, contracts, runtime, intentRecipes, classifier,
  });
  return { coordinator, planCalls, invokeCalls };
}
const reply = (cleanedBody) => ({ prompt: cleanedBody, cleanedBody });

test("GATE: explicit Outlook email resolves microsoft-graph via recipe — classifier NEVER consulted", async () => {
  const h = harness();
  const gate = await h.coordinator.handleGate(reply("Find the latest email from Chris in Outlook."), OWNER_CTX);
  assert.equal(gate.handled, true);
  assert.equal(gate.reason, "skill_education_required");
  assert.equal(h.planCalls.length, 1);
  assert.equal(h.planCalls[0].plannedSkills[0].id, "microsoft-graph");
  assert.equal(h.invokeCalls.length, 0, "recipe resolved deterministically; classifier not consulted");
});

test("GATE: explicit Zoom recording resolves zoom-meetings via recipe — classifier NEVER consulted", async () => {
  const h = harness();
  const gate = await h.coordinator.handleGate(reply("Summarize the Zoom recording transcript for the Q3 launch."), OWNER_CTX);
  assert.equal(gate.handled, true);
  assert.equal(gate.reason, "skill_education_required");
  assert.equal(h.planCalls.length, 1);
  assert.equal(h.planCalls[0].plannedSkills[0].id, "zoom-meetings");
  assert.equal(h.invokeCalls.length, 0, "recipe resolved deterministically; classifier not consulted");
});

test("GATE: a generic Gmail email is NOT captured by outlook-mail — it reaches the classifier", async () => {
  const h = harness();
  const gate = await h.coordinator.handleGate(reply("Find the latest email in Gmail from Chris."), OWNER_CTX);
  assert.equal(gate.handled, true);
  assert.equal(h.invokeCalls.length, 1, "no platform recipe matched; the classifier was consulted");
});

test("GATE: an absent target skill makes the recipe inert -> exact universal no-skill fail-safe", async () => {
  // zoom-meetings not installed; the classifier also returns nothing.
  const h = harness({ catalog: [{ id: "microsoft-graph", description: "Graph" }, { id: "code-review", description: "review" }], classifierReply: () => JSON.stringify({ skill_id: null, confidence: 0.0 }) });
  const gate = await h.coordinator.handleGate(reply("Pull the Zoom recording transcript for the launch."), OWNER_CTX);
  assert.equal(gate.handled, true);
  assert.equal(gate.reason, "no_skill_failsafe");
  assert.equal(gate.reply.text, NO_SKILL_FAILSAFE);
  assert.equal(gate.audit.recipe, "recipe_skills_absent");
  assert.equal(h.planCalls.length, 0);
});

test("GATE: an unrelated poem reaches the exact universal no-skill fail-safe", async () => {
  const h = harness();
  const gate = await h.coordinator.handleGate(reply("Write me a poem about the sea"), OWNER_CTX);
  assert.equal(gate.handled, true);
  assert.equal(gate.reason, "no_skill_failsafe");
  assert.equal(gate.reply.text, NO_SKILL_FAILSAFE);
  assert.equal(h.invokeCalls.length, 1, "classifier consulted and returned no skill");
  assert.equal(h.planCalls.length, 0);
});
