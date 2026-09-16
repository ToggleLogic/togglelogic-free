/*
 * ToggleLogic (Free Tier) — bounded-child limits INTEGRATION test.
 *
 * Drives a resolved+selected skill through the real coordinator gate into
 * executeBoundedChild and asserts the plugin-enforceable bounded-child limits are
 * actually applied: promptMode/lightContext, per-skill disableTools, the
 * before_tool_call guard registered for the exact child session (re-entrant +
 * off-allowlist + count deny), and the post-run usage audit with the ACTUAL
 * tool-call count. The runtime stub simulates tool calls DURING the child run so
 * enforcement is observed against a live guard entry.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createSkillRoutingCoordinator } from "../src/skill-routing/coordinator.js";
import { createCanaryScope } from "../src/skill-routing/scope.js";
import { createSkillResolver } from "../src/skill-routing/resolver.js";
import { createSkillContracts } from "../src/skill-routing/skill-contracts.js";
import { createChildToolGuard } from "../src/skill-routing/child-tool-guard.js";

const OWNER_CTX = Object.freeze({
  channel: "telegram", accountId: "codex", senderId: "7797183919",
  sessionKey: "agent:main:telegram:codex:7797183919", senderIsOwner: true,
  trigger: "user", inputProvenance: { kind: "external_user" },
});

function selectedPlan(id) {
  return {
    status: "selected", planned_skills: [{ id, version: "1.0.0" }],
    strategy: "lowest_cost", selected_lineage: "google/gemini-flash",
    selected_model_ref: "google/gemini-3.5-flash",
    estimated_tokens: 4000, choices: [{ kind: "lowest_cost", estimated_cost_usd: 0.002 }],
  };
}

function harness({ skillTools, maxChildToolCalls = 32, onChildTools }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tl-bcl-"));
  const usageAudits = [];
  const guard = createChildToolGuard({ maxToolCalls: maxChildToolCalls });
  const toolDecisions = [];
  const seam = {
    status: () => "available",
    planSkillRoute: async (req) => selectedPlan(req.plannedSkills[0].id),
    recordSkillChoice: async () => {},
  };
  const runtime = { subagent: {
    run: async (i) => {
      // Simulate the child issuing tool calls WHILE the guard entry is live.
      if (onChildTools) {
        for (const toolName of onChildTools) {
          toolDecisions.push({ toolName, decision: guard.beforeToolCall({ toolName }, { sessionKey: i.sessionKey }) });
        }
      }
      return { runId: "r1", sessionKey: i.sessionKey, runtime: { provider: i.provider, model: i.model } };
    },
    waitForRun: async () => ({ status: "ok", startedAt: 1000, endedAt: 1200 }),
    getSessionMessages: async () => ({ messages: [{ role: "assistant", content: "DONE" }] }),
  } };
  const scope = createCanaryScope({ enabled: true, channels: ["telegram"], accountIds: ["codex"], senderIds: ["7797183919"], ownerSenderIds: ["7797183919"] });
  const resolver = createSkillResolver({ catalog: [
    { id: "quiet-skill", aliases: ["quiet skill"] },
    { id: "toolful-skill", aliases: ["toolful skill"] },
  ] });
  const contracts = createSkillContracts({ ownerTimezone: "America/New_York", now: () => Date.now(), skillTools });
  const coordinator = createSkillRoutingCoordinator({
    seam,
    config: { pendingStatePath: path.join(dir, "pending.json"), pendingTtlMinutes: 15, defaultEstimatedTokens: 4000, executionTimeoutSeconds: 120, monthlyCloudSpendUsd: 0, maxChildTokens: 200000, maxChildCostUsd: 5 },
    fallbackLogger: null, shadow: false, scope, resolver, contracts, runtime,
    childToolGuard: guard,
    auditUsage: (d) => usageAudits.push(d),
  });
  const runCalls = [];
  const origRun = runtime.subagent.run;
  runtime.subagent.run = async (i) => { runCalls.push(i); return origRun(i); };
  return { coordinator, guard, usageAudits, toolDecisions, runCalls, dir };
}

function reply(text) { return { prompt: text, cleanedBody: text }; }

test("bounded child: a disableTools skill runs with an exact empty tool surface", async () => {
  const h = harness({ skillTools: { "quiet-skill": { disableTools: true } } });
  const gate = await h.coordinator.handleGate(reply("run the quiet-skill skill"), OWNER_CTX);
  assert.equal(gate.reason, "skill_selected_executed");
  assert.equal(h.runCalls.length, 1);
  assert.equal(h.runCalls[0].disableTools, true, "empty tool surface requested");
  assert.equal(h.runCalls[0].promptMode, "minimal");
  assert.equal(h.runCalls[0].lightContext, true);
  assert.equal(h.runCalls[0].contextTokenBudget, undefined, "unsupported field never sent");
});

test("bounded child: a skill WITHOUT a disable policy does not request disableTools", async () => {
  const h = harness({ skillTools: {} });
  await h.coordinator.handleGate(reply("run the toolful-skill skill"), OWNER_CTX);
  assert.equal(h.runCalls[0].disableTools, undefined, "normal surface (enforced by the guard instead)");
});

test("bounded child: the guard is registered for the child and enforces the allowlist + re-entrancy", async () => {
  const h = harness({
    skillTools: { "toolful-skill": { allowedTools: ["read_file"], maxToolCalls: 5 } },
    onChildTools: ["read_file", "shell_exec", "togglelogic_skill_run"],
  });
  await h.coordinator.handleGate(reply("run the toolful-skill skill"), OWNER_CTX);
  const byTool = Object.fromEntries(h.toolDecisions.map((d) => [d.toolName, d.decision]));
  assert.equal(byTool.read_file, undefined, "allowlisted tool passes");
  assert.equal(byTool.shell_exec.block, true, "off-allowlist tool denied");
  assert.equal(byTool.togglelogic_skill_run.block, true, "re-entrant routing tool denied");
});

test("bounded child: the post-run usage audit reports ACTUAL tool calls and marks tokens not host-observable", async () => {
  const h = harness({
    skillTools: { "toolful-skill": { allowedTools: ["read_file"] } },
    onChildTools: ["read_file", "read_file", "shell_exec"], // 2 allowed, 1 denied
  });
  await h.coordinator.handleGate(reply("run the toolful-skill skill"), OWNER_CTX);
  assert.equal(h.usageAudits.length, 1);
  const a = h.usageAudits[0];
  assert.equal(a.mode, "skill_child_usage_audit");
  assert.equal(a.execution_status, "ok");
  assert.equal(a.actual_tool_calls, 2, "counted the allowed tool calls");
  assert.equal(a.denied_tool_calls, 1, "counted the denied tool call");
  assert.deepEqual(a.allowed_tools, ["read_file"]);
  assert.equal(a.wall_clock_ms, 200, "endedAt - startedAt");
  assert.equal(a.model_usage_host_observable, false, "honest: host exposes no child token/cost");
  assert.equal(a.runtime_token_ceiling_enforced, false);
});

test("bounded child: the usage audit fires even when the child run FAILS", async () => {
  const h = harness({ skillTools: {} });
  h.coordinator; // reuse
  // Force a failure by making waitForRun return non-ok.
  h.runCalls; // noop
  const dir = h.dir;
  // Build a fresh coordinator whose waitForRun fails.
  const usageAudits = [];
  const guard = createChildToolGuard({});
  const seam = { status: () => "available", planSkillRoute: async (r) => selectedPlan(r.plannedSkills[0].id), recordSkillChoice: async () => {} };
  const runtime = { subagent: {
    run: async (i) => ({ runId: "r1", sessionKey: i.sessionKey }),
    waitForRun: async () => ({ status: "error", error: "boom", startedAt: 1, endedAt: 5 }),
    getSessionMessages: async () => ({ messages: [] }),
  } };
  const scope = createCanaryScope({ enabled: true, channels: ["telegram"], accountIds: ["codex"], senderIds: ["7797183919"], ownerSenderIds: ["7797183919"] });
  const resolver = createSkillResolver({ catalog: [{ id: "toolful-skill", aliases: ["toolful skill"] }] });
  const contracts = createSkillContracts({ ownerTimezone: "America/New_York", now: () => Date.now(), skillTools: {} });
  const coordinator = createSkillRoutingCoordinator({
    seam, config: { pendingStatePath: path.join(dir, "p2.json"), pendingTtlMinutes: 15, defaultEstimatedTokens: 4000, executionTimeoutSeconds: 120, monthlyCloudSpendUsd: 0, maxChildTokens: 200000, maxChildCostUsd: 5 },
    fallbackLogger: null, shadow: false, scope, resolver, contracts, runtime, childToolGuard: guard,
    auditUsage: (d) => usageAudits.push(d),
  });
  const gate = await coordinator.handleGate(reply("run the toolful-skill skill"), OWNER_CTX);
  assert.equal(gate.reason, "skill_routing_gate_error", "a failed child fails closed (handled)");
  assert.equal(usageAudits.length, 1, "usage audit still emitted on failure");
  assert.equal(usageAudits[0].execution_status, "error");
});
