import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { normalizeConfig } from "../src/config/normalize.js";
import { createInterceptor } from "../src/routing/interceptor.js";
import { createChildToolGuard } from "../src/skill-routing/child-tool-guard.js";
import {
  createSkillRoutingCoordinator,
  formatSkillExecutionReceipt,
} from "../src/skill-routing/coordinator.js";

function interceptorHarness({ guard, seam, audits }) {
  const skillRouting = { routeBindingFor: (sessionKey) => guard.routeBindingFor(sessionKey) };
  return createInterceptor({
    config: normalizeConfig({ mode: "intelligence" }),
    hostConfig: {},
    logger: { write: async () => {} },
    seam,
    version: "1.7.0-test",
    audit: { emit: (event) => audits.push(event) },
    configuredProviders: [],
    skillRouting,
  });
}

test("bounded child resolves the exact planned model without owner reclassification", async () => {
  const guard = createChildToolGuard();
  const sessionKey = "agent:main:owner:togglelogic-skill:bound-model";
  guard.register(sessionKey, {
    skills: ["powerpoint-editor"],
    plannedModelRef: "openai/gpt-5.5",
    maxToolCalls: 24,
  });
  let classifyCalls = 0;
  const audits = [];
  const interceptor = interceptorHarness({
    guard,
    audits,
    seam: {
      status: () => "available",
      classify: async () => {
        classifyCalls += 1;
        return { providerOverride: "google", modelOverride: "gemini-3.5-flash" };
      },
    },
  });

  const result = await interceptor(
    { prompt: "Execute the PowerPoint edit" },
    {
      sessionKey,
      senderIsOwner: false,
      modelProviderId: "google",
      modelId: "gemini-3.5-flash",
    },
  );
  assert.deepEqual(result, { providerOverride: "openai", modelOverride: "gpt-5.5" });
  assert.equal(classifyCalls, 0, "the routed child must not pass through task/default classification");
  const audit = audits.find((event) => event.details?.mode === "skill_child_route_binding");
  assert.equal(audit.details.planned_model_ref, "openai/gpt-5.5");
  assert.equal(audit.details.owner_reclassification_bypassed, true);
});

test("a routed child without its registered model binding fails closed", async () => {
  const guard = createChildToolGuard();
  let classifyCalls = 0;
  const audits = [];
  const interceptor = interceptorHarness({
    guard,
    audits,
    seam: { status: () => "available", classify: async () => { classifyCalls += 1; return null; } },
  });
  await assert.rejects(
    interceptor(
      { prompt: "unbound" },
      { sessionKey: "agent:main:owner:togglelogic-skill:missing", senderIsOwner: false },
    ),
    /no registered model binding; refusing unbound execution/,
  );
  assert.equal(classifyCalls, 0);
  assert.ok(audits.some((event) => event.details?.mode === "skill_child_route_binding_missing" && event.details.blocked === true));
});

test("post-run observed-model mismatch rejects the child result and audits failure", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tl-child-route-mismatch-"));
  const guard = createChildToolGuard();
  const usageAudits = [];
  const runtime = { subagent: {
    run: async (input) => ({ runId: "run-mismatch", sessionKey: input.sessionKey }),
    waitForRun: async () => ({ status: "ok", startedAt: 10, endedAt: 20 }),
    getSessionMessages: async () => ({ messages: [{
      role: "assistant",
      provider: "google",
      model: "gemini-3.5-flash",
      content: [{ type: "text", text: "edited deck" }],
    }] }),
  } };
  const coordinator = createSkillRoutingCoordinator({
    seam: {},
    childToolGuard: guard,
    auditUsage: (event) => usageAudits.push(event),
    config: {
      pendingStatePath: path.join(directory, "pending.json"),
      pendingTtlMinutes: 15,
      defaultEstimatedTokens: 4000,
      monthlyCloudSpendUsd: 0,
      executionTimeoutSeconds: 120,
      maxChildTokens: 200000,
      maxChildCostUsd: 5,
    },
    runtime,
  });

  await assert.rejects(
    coordinator.executeBoundedChild({
      callRef: "mismatch",
      invocation: { sessionKey: "agent:main:owner" },
      task: "Edit the deck",
      skills: [{ id: "powerpoint-editor" }],
      override: { providerOverride: "openai", modelOverride: "gpt-5.5" },
      modelRef: "openai/gpt-5.5",
      estimatedTokens: 4000,
      estimatedCostUsd: 0.5,
      details: { model_lineage: "openai/gpt" },
    }),
    /planned openai\/gpt-5\.5, observed google\/gemini-3\.5-flash; result rejected/,
  );
  assert.equal(usageAudits.length, 1);
  assert.equal(usageAudits[0].execution_status, "model_mismatch");
  assert.equal(usageAudits[0].model_match_verified, false);
  assert.equal(usageAudits[0].planned_model_ref, "openai/gpt-5.5");
  assert.equal(usageAudits[0].observed_model_ref, "google/gemini-3.5-flash");
});

test("mismatch receipt is explicitly failed and never described as successful routing", () => {
  const receipt = formatSkillExecutionReceipt({
    model_lineage: "openai/gpt",
    planned_model_ref: "openai/gpt-5.5",
    observed_model_ref: "google/gemini-3.5-flash",
    estimated_cost_usd: 0.5,
  });
  assert.match(receipt, /EXECUTION MODEL MISMATCH/);
  assert.match(receipt, /result was not accepted as successfully routed execution/);
  assert.doesNotMatch(receipt, /Observed execution model:/);
  assert.doesNotMatch(receipt, /Routed by ToggleLogic to/);
});

test("denied verification calls produce an incomplete receipt, never a completion claim", () => {
  const receipt = formatSkillExecutionReceipt({
    model_lineage: "openai/gpt",
    planned_model_ref: "openai/gpt-5.5",
    observed_model_ref: "openai/gpt-5.5",
    execution_status: "tool_guard_denied",
    denied_tool_calls: 4,
  });
  assert.match(receipt, /EXECUTION INCOMPLETE/);
  assert.match(receipt, /denied 4 tool call/);
  assert.match(receipt, /Verification was incomplete/);
  assert.doesNotMatch(receipt, /Observed execution model:/);
});
