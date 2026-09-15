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
  structuredPlannedSkills,
} from "../src/skill-routing/coordinator.js";
import { normalizeConfig } from "../src/config/normalize.js";

function fixture() {
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
  });
  return { coordinator, plan, recorded, directory };
}

test("structured skill metadata is normalized without inspecting prompt text", () => {
  assert.deepEqual(
    structuredPlannedSkills({ metadata: { plannedSkills: [{ skill_id: "meeting-prep", skill_version: "1.0" }] } }),
    [{ id: "meeting-prep", version: "1.0", execution_class: "default" }],
  );
  assert.deepEqual(
    structuredPlannedSkills({ metadata: { skillId: "company-deep-dive" } }),
    [{ id: "company-deep-dive", execution_class: "default" }],
  );
  assert.deepEqual(structuredPlannedSkills({ prompt: "please use meeting prep" }), []);
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
  const result = await coordinator.consumeChoice(`TL-${plan.choice_token} 2`, context);
  assert.deepEqual(result.override, { providerOverride: "anthropic", modelOverride: "claude-sonnet-4.6" });
  assert.equal(result.details.model_lineage, "anthropic/claude-sonnet");
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].choice.kind, "benchmark_best");
  assert.equal(await coordinator.consumeChoice(`TL-${plan.choice_token} 2`, context), null);
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
  assert.match(text, /planned skills: meeting-prep/);
  assert.match(text, /google\/gemini-flash → google\/gemini-3\.5-flash/);
  assert.match(text, /Monthly cloud budget: \$8\.33/);
});

test("tool gives SAM a structured planning surface", async () => {
  const { coordinator } = fixture();
  const tool = createSkillRoutingTool(coordinator, { sessionKey: "tool-session", senderIsOwner: true });
  const result = await tool.execute("call-1", {
    task_summary: "Prepare me",
    skills: [{ id: "meeting-prep", version: "1.0.0" }],
  });
  assert.equal(result.details.status, "education_required");
  assert.match(result.content[0].text, /Reply TL-[a-f0-9]{6} 1/);
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
    getSessionMessages: async () => ({ messages: [{ role: "assistant", content: [{ type: "text", text: "briefing complete" }] }] }),
  } };
  const tool = createSkillRoutingRunTool(coordinator, runtime, { executionTimeoutSeconds: 120 }, { sessionKey: "owner-session" });
  const result = await tool.execute("call-1", { task_summary: "Prepare me", skills: [{ id: "meeting-prep" }] });
  assert.equal(result.content[0].text, "briefing complete");
  assert.equal(result.details.executed, true);
  assert.equal(result.details.resolved_child, "anthropic/claude-sonnet-4.6");
  assert.equal(calls[0].provider, "anthropic");
  assert.equal(calls[0].model, "claude-sonnet-4.6");
  assert.equal(calls[0].deliver, false);
  assert.match(calls[0].extraSystemPrompt, /Do not call togglelogic_skill_plan/);
  assert.equal(result.details.execution_status, "ok");
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
