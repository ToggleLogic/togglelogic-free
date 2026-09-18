import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createSkillRoutingCoordinator,
  createSkillRoutingRunTool,
  createSkillRoutingTool,
  formatSkillPlan,
  parseMonthlyBudgetUpdate,
  structuredPlannedSkills,
} from "../src/skill-routing/coordinator.js";
import { createSkillResolver } from "../src/skill-routing/resolver.js";
import { createCanaryScope } from "../src/skill-routing/scope.js";
import { normalizeConfig } from "../src/config/normalize.js";

function fixture({ scopeConfig = null, shadow = false } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tl-free-skill-routing-"));
  const recorded = [];
  const plan = {
    schema_version: 1,
    status: "education_required",
    planned_skills: [{ id: "meeting-prep", version: "1.0.0", execution_class: "default" }],
    required_tier: "tool_calling_strong",
    required_surface: null,
    privacy: "cloud_allowed",
    choices: [
      { kind: "lowest_cost", model_lineage: "google/gemini-flash", resolved_child: "google/gemini-3.5-flash", location: "cloud", estimated_cost_usd: 0.002 },
      { kind: "benchmark_best", model_lineage: "anthropic/claude-sonnet", resolved_child: "anthropic/claude-sonnet-4.6", location: "cloud", estimated_cost_usd: 0.024 },
      { kind: "intelligence", model_lineage: "google/gemini-flash", resolved_child: "google/gemini-3.5-flash", location: "cloud", estimated_cost_usd: 0.002 },
    ],
    economic_policy: { monthly_cloud_budget_usd: 400 / 48, monthly_headroom_usd: 400 / 48 },
  };
  const seam = {
    planSkillRoute: async () => plan,
    recordSkillChoice: (input) => recorded.push(input),
  };
  const coordinator = createSkillRoutingCoordinator({
    seam,
    config: {
      pendingStatePath: path.join(directory, "pending.json"),
      pendingTtlMinutes: 15,
      defaultEstimatedTokens: 4000,
      monthlyCloudSpendUsd: 0,
    },
    fallbackLogger: null,
    ...(scopeConfig ? { scope: createCanaryScope(scopeConfig) } : {}),
    shadow,
  });
  return { coordinator, plan, recorded, directory };
}

test("structured host metadata normalizes (an OPTIONAL path the host never populates on routing hooks)", () => {
  assert.deepEqual(
    structuredPlannedSkills({ metadata: { plannedSkills: [{ skill_id: "meeting-prep", skill_version: "1.0" }] } }),
    [{ id: "meeting-prep", version: "1.0", execution_class: "default" }],
  );
  assert.deepEqual(
    structuredPlannedSkills({ metadata: { skillId: "company-deep-dive" } }),
    [{ id: "company-deep-dive", execution_class: "default" }],
  );
  // structuredPlannedSkills is metadata-only BY DESIGN. It returning [] for prompt
  // text is NOT the production skill boundary — the deterministic resolver is.
  assert.deepEqual(structuredPlannedSkills({ prompt: "please use meeting prep" }), []);
});

test("monthly budget control language is deterministic and bounded", () => {
  assert.equal(parseMonthlyBudgetUpdate("Set my ToggleLogic budget to $25 per month."), 25);
  assert.equal(parseMonthlyBudgetUpdate("Sam - Set my ToggleLogic budget to $50 per month."), 50);
  assert.equal(parseMonthlyBudgetUpdate("Sam, please raise my monthly cloud budget to $75."), 75);
  assert.equal(parseMonthlyBudgetUpdate("increase the cloud budget from $25 to $50 monthly"), 50);
  assert.equal(parseMonthlyBudgetUpdate("what should my budget be?"), null);
  assert.equal(parseMonthlyBudgetUpdate("set budget to $1000001"), null);
});

test("authenticated owner can update the durable monthly budget without skill resolution", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tl-free-budget-control-"));
  const updates = [];
  const coordinator = createSkillRoutingCoordinator({
    seam: {
      updateMonthlyCloudBudget: async (value) => {
        updates.push(value);
        return { monthly_cloud_budget_usd: value };
      },
    },
    config: { pendingStatePath: path.join(directory, "pending.json"), pendingTtlMinutes: 15, defaultEstimatedTokens: 4000, monthlyCloudSpendUsd: 0 },
    spendProvider: { current: () => ({ monthToDateCostUsd: 23.34 }) },
    scope: createCanaryScope({ enabled: true, allowGlobal: true, requireOwner: true }),
  });
  const result = await coordinator.handleGate(
    { prompt: "Set my ToggleLogic budget to $50 per month." },
    { sessionKey: "owner-budget", senderIsOwner: true },
  );
  assert.equal(result.reason, "skill_budget_updated");
  assert.deepEqual(updates, [50]);
  assert.match(result.reply.text, /now \$50\.00/);
  assert.match(result.reply.text, /remaining headroom is \$26\.66/);
});

test("the deterministic resolver — NOT host metadata — closes the 2026-09-15 gap from message text", () => {
  const resolver = createSkillResolver({ catalog: [{ id: "meeting-prep", aliases: ["meeting prep"] }] });
  // The exact incident prompt now resolves to the installed skill deterministically.
  const hit = resolver.resolve("Prepare me for my 2 pm meeting using the meeting-prep skill.");
  assert.equal(hit.status, "resolved");
  assert.deepEqual(hit.skills.map((s) => s.id), ["meeting-prep"]);
  // A skill invocation naming an UNINSTALLED skill is flagged, never guessed.
  const unknown = resolver.resolve("do it using the wombat-briefing skill");
  assert.equal(unknown.status, "ambiguous");
  assert.deepEqual(unknown.unknownSkills, ["wombat briefing"]);
  // No skill reference → no resolution (normal turns are untouched).
  assert.equal(resolver.resolve("what's the weather").status, "none");
});

test("skill routing is opt-in and normalizes bounded runtime settings", () => {
  const defaults = normalizeConfig({});
  assert.equal(defaults.features.skillRouting.enabled, false);
  const configured = normalizeConfig({
    features: { skillRouting: { enabled: true } },
    intelligence: { skillProfilesPath: "/profiles.json" },
    skillRouting: { pendingTtlMinutes: 20, defaultEstimatedTokens: 9000, executionTimeoutSeconds: 120, monthlyCloudSpendUsd: 2.5 },
  });
  assert.equal(configured.features.skillRouting.enabled, true);
  assert.equal(configured.intelligence.skillProfilesPath, "/profiles.json");
  assert.equal(configured.skillRouting.pendingTtlMinutes, 20);
  assert.equal(configured.skillRouting.defaultEstimatedTokens, 9000);
  assert.equal(configured.skillRouting.executionTimeoutSeconds, 120);
  assert.equal(configured.skillRouting.monthlyCloudSpendUsd, 2.5);
});

test("educational plan persists restart-safe pending state", async () => {
  const { coordinator, directory } = fixture();
  const result = await coordinator.plan({ prompt: "Prepare me", plannedSkills: ["meeting-prep"] }, { sessionKey: "owner-session", senderIsOwner: true });
  assert.equal(result.status, "education_required");
  const saved = JSON.parse(fs.readFileSync(path.join(directory, "pending.json"), "utf8"));
  assert.equal(Object.keys(saved.pending).length, 1);
});

test("invalid skill identifiers are rejected before state is written", async () => {
  const { coordinator, directory } = fixture();
  await assert.rejects(
    coordinator.plan({ prompt: "Prepare me", plannedSkills: ["../bad skill"] }, { sessionKey: "owner-session", senderIsOwner: true }),
    /at least one planned skill/,
  );
  assert.equal(fs.existsSync(path.join(directory, "pending.json")), false);
});

test("exact owner choice saves profiles and routes the continuation", async () => {
  const { coordinator, recorded } = fixture();
  const context = { sessionKey: "owner-session", senderIsOwner: true, requesterSenderId: "owner-1" };
  const plan = await coordinator.plan({ prompt: "Prepare me", plannedSkills: ["meeting-prep"] }, context);
  assert.equal(await coordinator.consumeChoice("maybe 2", context), null);
  const result = await coordinator.consumeChoice("2", context);
  assert.deepEqual(result.override, { providerOverride: "anthropic", modelOverride: "claude-sonnet-4.6" });
  assert.equal(result.details.model_lineage, "anthropic/claude-sonnet");
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].choice.kind, "benchmark_best");
  assert.equal(await coordinator.consumeChoice(`TL-${plan.choice_token} 2`, context), null);
});

test("a bare choice is bound to the pending plan in the same owner session", async () => {
  const { coordinator, recorded } = fixture();
  const owner = { sessionKey: "bound-owner-session", senderIsOwner: true, requesterSenderId: "owner-1" };
  await coordinator.plan({ prompt: "Prepare me", plannedSkills: ["meeting-prep"] }, owner);
  assert.equal(await coordinator.consumeChoice("1", { ...owner, requesterSenderId: "different-sender" }), null);
  const result = await coordinator.consumeChoice("1", owner);
  assert.equal(result.strategy, "lowest_cost");
  assert.equal(recorded.length, 1);
  assert.equal(await coordinator.consumeChoice("1", owner), null, "a bare reply cannot replay a consumed choice");
});

test("teaching a missing skill preserves already-current skill profiles", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tl-free-skill-mixed-"));
  const recorded = [];
  const seam = {
    planSkillRoute: async () => ({
      ...fixture().plan,
      planned_skills: [{ id: "learned" }, { id: "new-skill" }],
      profile_matches: [
        { skill_id: "learned", status: "current" },
        { skill_id: "new-skill", status: "missing" },
      ],
    }),
    recordSkillChoice: async (input) => recorded.push(input),
  };
  const coordinator = createSkillRoutingCoordinator({
    seam,
    config: { pendingStatePath: path.join(directory, "pending.json"), pendingTtlMinutes: 15, defaultEstimatedTokens: 4000, monthlyCloudSpendUsd: 0 },
  });
  const context = { sessionKey: "mixed", senderIsOwner: true };
  const plan = await coordinator.plan({ prompt: "mixed", plannedSkills: ["learned", "new-skill"] }, context);
  await coordinator.consumeChoice(`TL-${plan.choice_token} 1`, context);
  assert.deepEqual(recorded.map((item) => item.skill.id), ["new-skill"]);
});

test("shadow planning neither stages a choice nor emits a taught override", async () => {
  const { plan, recorded, directory } = fixture();
  const coordinator = createSkillRoutingCoordinator({
    seam: { planSkillRoute: async () => plan, recordSkillChoice: async (input) => recorded.push(input) },
    config: { pendingStatePath: path.join(directory, "shadow.json"), pendingTtlMinutes: 15, defaultEstimatedTokens: 4000, monthlyCloudSpendUsd: 0 },
    shadow: true,
  });
  const context = { sessionKey: "shadow", senderIsOwner: true };
  const result = await coordinator.plan({ prompt: "shadow", plannedSkills: ["meeting-prep"] }, context);
  assert.equal(result.shadow, true);
  assert.equal(result.teaching_authorized, false);
  assert.equal(fs.existsSync(path.join(directory, "shadow.json")), false);
  assert.equal(await coordinator.consumeChoice("TL-abcdef 1", context), null);
  assert.equal(recorded.length, 0);
});

test("owner-facing format names skills, lineages, children, costs, and budget", () => {
  const { plan } = fixture();
  const text = formatSkillPlan({ ...plan, teaching_authorized: true, choice_token: "abc123" });
  assert.match(text, /use these skills: meeting-prep/);
  assert.match(text, /google\/gemini-flash → google\/gemini-3\.5-flash/);
  assert.match(text, /Monthly cloud budget: \$8\.33/);
});

test("owner-facing format makes an over-budget choice and one-time approval explicit", () => {
  const { plan } = fixture();
  const choices = plan.choices.map((item) => ({
    ...item,
    over_monthly_budget: true,
    monthly_overage_after_usd: 14.88,
  }));
  const text = formatSkillPlan({ ...plan, choices, teaching_authorized: true, choice_token: "abc123" });
  assert.match(text, /over monthly allowance by \$14\.88/);
  assert.match(text, /cloud budget is used up/);
  assert.match(text, /Replying with a number approves this one run/);
  assert.match(text, /Set my ToggleLogic budget to \$25 per month/);
});

test("tool gives SAM a structured planning surface", async () => {
  const { coordinator } = fixture();
  const tool = createSkillRoutingTool(coordinator, { sessionKey: "tool-session", senderIsOwner: true });
  const result = await tool.execute("call-1", {
    task_summary: "Prepare me",
    skills: [{ id: "meeting-prep", version: "1.0.0" }],
  });
  assert.equal(result.details.status, "education_required");
  assert.match(result.content[0].text, /Reply 1 or 2/);
});

test("learned skill work executes in a child run pinned to the resolved child", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tl-free-skill-run-"));
  const calls = [];
  const coordinator = createSkillRoutingCoordinator({
    seam: { planSkillRoute: async () => ({
      status: "selected",
      planned_skills: [{ id: "meeting-prep", version: "1.0.0" }],
      strategy: "benchmark_best",
      selected_lineage: "anthropic/claude-sonnet",
      selected_model_ref: "anthropic/claude-sonnet-4.6",
      choices: [{ kind: "benchmark_best", estimated_cost_usd: 0.02 }],
    }) },
    config: { pendingStatePath: path.join(directory, "pending.json"), pendingTtlMinutes: 15, defaultEstimatedTokens: 4000, monthlyCloudSpendUsd: 0 },
  });
  const runtime = { subagent: {
    run: async (input) => { calls.push(input); return { runId: "run-1", sessionKey: input.sessionKey, runtime: { provider: input.provider, model: input.model } }; },
    waitForRun: async () => ({ status: "ok" }),
    getSessionMessages: async () => ({ messages: [{ role: "assistant", content: [{ type: "text", text: "briefing complete; join https://us02web.zoom.us/j/8602082320?pwd=example with passcode ClickIT" }] }] }),
  } };
  const tool = createSkillRoutingRunTool(coordinator, runtime, { executionTimeoutSeconds: 120 }, { sessionKey: "owner-session" });
  const result = await tool.execute("call-1", { task_summary: "Prepare me", skills: [{ id: "meeting-prep" }] });
  assert.match(result.content[0].text, /briefing complete/);
  assert.match(result.content[0].text, /meeting join link redacted/i);
  assert.match(result.content[0].text, /passcode: \[redacted\]/i);
  assert.doesNotMatch(result.content[0].text, /zoom\.us|ClickIT/i);
  assert.equal(result.details.executed, true);
  assert.equal(result.details.resolved_child, "anthropic/claude-sonnet-4.6");
  assert.equal(calls[0].provider, "anthropic");
  assert.equal(calls[0].model, "claude-sonnet-4.6");
  assert.equal(calls[0].deliver, false);
  assert.match(calls[0].extraSystemPrompt, /Do not call togglelogic_skill_plan/);
  assert.equal(result.details.execution_status, "ok");
  assert.equal(result.details.sensitive_output_redactions, 2);
});

test("skill child execution fails loudly on a terminal runtime error", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tl-free-skill-run-error-"));
  const coordinator = createSkillRoutingCoordinator({
    seam: { planSkillRoute: async () => ({
      status: "selected", planned_skills: [{ id: "meeting-prep" }], strategy: "lowest_cost",
      selected_model_ref: "ollama/glm4:9b", choices: [],
    }) },
    config: { pendingStatePath: path.join(directory, "pending.json"), pendingTtlMinutes: 15, defaultEstimatedTokens: 4000, monthlyCloudSpendUsd: 0 },
  });
  const runtime = { subagent: {
    run: async (input) => ({ runId: "run-error", sessionKey: input.sessionKey }),
    waitForRun: async () => ({ status: "error", error: "model unavailable" }),
    getSessionMessages: async () => ({ messages: [] }),
  } };
  const tool = createSkillRoutingRunTool(coordinator, runtime, { executionTimeoutSeconds: 30 }, { sessionKey: "owner-session" });
  await assert.rejects(
    tool.execute("call-error", { task_summary: "Prepare me", skills: [{ id: "meeting-prep" }] }),
    /skill execution error: model unavailable/,
  );
});

test("a ToggleLogic child cannot recursively start another skill child", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tl-free-skill-recursion-"));
  let runs = 0;
  const coordinator = createSkillRoutingCoordinator({
    seam: { planSkillRoute: async () => ({
      status: "selected", planned_skills: [{ id: "nested" }], strategy: "lowest_cost",
      selected_model_ref: "ollama/glm4:9b", choices: [],
    }) },
    config: { pendingStatePath: path.join(directory, "pending.json"), pendingTtlMinutes: 15, defaultEstimatedTokens: 4000, monthlyCloudSpendUsd: 0 },
  });
  const runtime = { subagent: {
    run: async () => { runs += 1; return { runId: "should-not-run" }; },
    waitForRun: async () => ({ status: "ok" }),
    getSessionMessages: async () => ({ messages: [] }),
  } };
  const tool = createSkillRoutingRunTool(coordinator, runtime, { executionTimeoutSeconds: 30 }, {
    sessionKey: "agent:main:parent:togglelogic-skill:child",
  });
  await assert.rejects(
    tool.execute("nested-call", { task_summary: "nested", skills: [{ id: "nested" }] }),
    /nested ToggleLogic skill execution is not allowed/,
  );
  assert.equal(runs, 0);
});

test("non-owner planning cannot stage a learned routing choice", async () => {
  const { coordinator, recorded } = fixture();
  const context = { sessionKey: "shared-session", senderIsOwner: false, requesterSenderId: "guest-1" };
  const plan = await coordinator.plan({ prompt: "Prepare me", plannedSkills: ["meeting-prep"] }, context);
  assert.equal(plan.teaching_authorized, false);
  assert.match(formatSkillPlan(plan), /authenticated owner/);
  assert.equal(await coordinator.consumeChoice("2", context), null);
  assert.equal(recorded.length, 0);
});

test("a different proven sender cannot consume an owner's pending choice", async () => {
  const { coordinator, recorded } = fixture();
  const plan = await coordinator.plan(
    { prompt: "Prepare me", plannedSkills: ["meeting-prep"] },
    { sessionKey: "shared-session", senderIsOwner: true, requesterSenderId: "owner-1" },
  );
  assert.equal(await coordinator.consumeChoice(`TL-${plan.choice_token} 2`, {
    sessionKey: "shared-session", senderId: "other-2",
  }), null);
  assert.equal(recorded.length, 0);
});

test("a sender-bound choice fails closed when the reply sender is unavailable", async () => {
  const { coordinator, recorded } = fixture();
  const plan = await coordinator.plan(
    { prompt: "Prepare me", plannedSkills: ["meeting-prep"] },
    { sessionKey: "shared-session", senderIsOwner: true, requesterSenderId: "owner-1" },
  );
  assert.equal(await coordinator.consumeChoice(`TL-${plan.choice_token} 1`, {
    sessionKey: "shared-session",
  }), null);
  assert.equal(recorded.length, 0);
});

// ——— Owner-auth propagation (1.6.1-rc.5) ————————————————————————————————————
// The before_agent_reply agent context does NOT carry senderIsOwner, so plan()
// must derive owner status from the SAME trusted decision that scope.evaluate()
// uses to admit the turn (scope.isOwner: the bit when present, else the
// configured ownerSenderIds/senderIds allowlist matched to the trusted senderId).
// Deriving it from the raw senderIsOwner bit alone denied a configured trusted
// owner the teaching choice ("An authenticated owner must start this teaching
// choice") on the exact path scope had already admitted as an owner turn.

test("configured ownerSenderIds stages teaching when senderIsOwner is absent (before_agent_reply gap)", async () => {
  const { coordinator, directory } = fixture({
    scopeConfig: { enabled: true, requireOwner: true, channels: ["telegram"], ownerSenderIds: ["7797183919"] },
  });
  // before_agent_reply supplies the trusted senderId but NOT the senderIsOwner bit.
  const context = { sessionKey: "owner-session", senderId: "7797183919" };
  const plan = await coordinator.plan({ prompt: "Prepare me", plannedSkills: ["meeting-prep"] }, context);
  assert.equal(plan.status, "education_required");
  assert.equal(plan.teaching_authorized, true);
  assert.match(plan.choice_token, /^[a-f0-9]{6}$/);
  // The owner-facing render offers the choices, never the authenticated-owner denial.
  assert.doesNotMatch(formatSkillPlan(plan), /authenticated owner must start/);
  assert.match(formatSkillPlan(plan), /Reply 1 or 2/);
  // The choice was staged restart-safe and bound to this trusted sender.
  const saved = JSON.parse(fs.readFileSync(path.join(directory, "pending.json"), "utf8"));
  assert.equal(Object.keys(saved.pending).length, 1);
});

test("the senderIds scope dimension also authorizes teaching when no ownerSenderIds allowlist is set", async () => {
  const { coordinator } = fixture({
    scopeConfig: { enabled: true, requireOwner: true, channels: ["telegram"], senderIds: ["7797183919"] },
  });
  const plan = await coordinator.plan(
    { prompt: "Prepare me", plannedSkills: ["meeting-prep"] },
    { sessionKey: "owner-session-sender-dim", senderId: "7797183919" },
  );
  assert.equal(plan.teaching_authorized, true);
  assert.match(plan.choice_token, /^[a-f0-9]{6}$/);
});

test("an explicit senderIsOwner bit still authorizes teaching (allowlist unmatched)", async () => {
  const { coordinator } = fixture({
    scopeConfig: { enabled: true, requireOwner: true, ownerSenderIds: ["7797183919"] },
  });
  // A sender that is NOT on the allowlist, but the host asserted the owner bit.
  const context = { sessionKey: "owner-session-bit", senderId: "some-other-peer", senderIsOwner: true };
  const plan = await coordinator.plan({ prompt: "Prepare me", plannedSkills: ["meeting-prep"] }, context);
  assert.equal(plan.teaching_authorized, true);
  assert.match(plan.choice_token, /^[a-f0-9]{6}$/);
});

test("non-owner, missing, or mismatched sender cannot stage teaching under scope", async () => {
  const scopeConfig = { enabled: true, requireOwner: true, ownerSenderIds: ["7797183919"] };
  for (const context of [
    { sessionKey: "mismatch", senderId: "9999999999" },                              // wrong peer, no bit
    { sessionKey: "missing" },                                                        // no sender, no bit
    { sessionKey: "explicit-false", senderId: "9999999999", senderIsOwner: false },   // explicit non-owner
  ]) {
    const { coordinator, directory } = fixture({ scopeConfig });
    const plan = await coordinator.plan({ prompt: "Prepare me", plannedSkills: ["meeting-prep"] }, context);
    assert.equal(plan.teaching_authorized, false);
    assert.equal(plan.choice_token, undefined);
    assert.match(formatSkillPlan(plan), /authenticated owner must start/);
    // Nothing was staged, and no token-shaped reply can be consumed.
    assert.equal(fs.existsSync(path.join(directory, "pending.json")), false);
    assert.equal(await coordinator.consumeChoice("TL-abcdef 1", context), null);
  }
});

test("a choice staged via the ownerSenderIds fallback stays bound to the staging sender", async () => {
  const { coordinator, recorded } = fixture({
    scopeConfig: { enabled: true, requireOwner: true, ownerSenderIds: ["7797183919"] },
  });
  const owner = { sessionKey: "shared", senderId: "7797183919" }; // before_agent_reply: no senderIsOwner
  const plan = await coordinator.plan({ prompt: "Prepare me", plannedSkills: ["meeting-prep"] }, owner);
  assert.equal(plan.teaching_authorized, true);
  // A different proven sender in the same session cannot consume the owner's choice.
  assert.equal(await coordinator.consumeChoice(`TL-${plan.choice_token} 2`, {
    sessionKey: "shared", senderId: "intruder-9",
  }), null);
  assert.equal(recorded.length, 0);
  // The staging owner (same trusted senderId) can.
  const result = await coordinator.consumeChoice(`TL-${plan.choice_token} 2`, owner);
  assert.equal(result.choice.kind, "benchmark_best");
  assert.equal(recorded.length, 1);
});
