import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createApprovalGate } from "../src/governance/approval-gate.js";

function fixture(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "togglelogic-gate-"));
  const statePath = path.join(dir, "state.json");
  const pricing = {
    async resolve(ref) {
      return { ref, priced: true, inputPerM: 3, outputPerM: 15, source: "test-prices" };
    },
    costUsd(price, usage) {
      return ((usage.input || 0) * price.inputPerM + (usage.output || 0) * price.outputPerM) / 1e6;
    },
  };
  const config = {
    localModel: "ollama/gemma4:latest",
    localTiers: ["general_purpose"],
    approvalTiers: ["flagship_reasoning"],
    ttlMinutes: 10,
    statePath,
    ...overrides,
  };
  return { dir, statePath, pricing, config, gate: createApprovalGate({ config, pricing }) };
}

test("ordinary work is routed to the configured local model without approval", async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.dir, { recursive: true, force: true }));
  const result = await f.gate.afterRouting("Summarize these notes", { sessionKey: "s1" }, {
    selectionDetails: { required_tier: "general_purpose" },
  });
  assert.equal(result.action, "local");
  assert.deepEqual(result.override, { providerOverride: "ollama", modelOverride: "gemma4:latest" });
  assert.equal(f.gate.beforeAgentRun({}, { sessionKey: "s1" }).outcome, "pass");
});

test("external flagship work is blocked with an estimate, then resumes once after approval", async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.dir, { recursive: true, force: true }));
  const prompt = "Synthesize multiple reports with conflicting evidence and recommend a strategy.";
  const staged = await f.gate.afterRouting(prompt, { sessionKey: "s2" }, {
    selectedProvider: "anthropic",
    selectedModel: "claude-sonnet-4-6",
    selectionDetails: { required_tier: "flagship_reasoning", reasoning: "conflicting evidence" },
  });
  assert.equal(staged.action, "approval_required");
  const blocked = f.gate.beforeAgentRun({}, { sessionKey: "s2" });
  assert.equal(blocked.outcome, "block");
  assert.match(blocked.message, /Estimated AI cost: \$/);
  assert.match(blocked.message, /ToggleLogic is ready to continue/);
  assert.match(blocked.message, /Once you approve/);
  assert.doesNotMatch(blocked.message, /could not|blocked|cannot/i);

  const approval = f.gate.beforeRouting("Yes, proceed", { sessionKey: "s2" });
  assert.equal(approval.action, "approved");
  assert.deepEqual(approval.override, { providerOverride: "anthropic", modelOverride: "claude-sonnet-4-6" });
  assert.match(f.gate.prepareTurn({}, { sessionKey: "s2" }).appendContext, /ORIGINAL REQUEST/);
  assert.match(f.gate.prepareTurn({}, { sessionKey: "s2" }).appendContext, /Synthesize multiple reports/);
  assert.equal(f.gate.beforeAgentRun({}, { sessionKey: "s2" }).outcome, "pass");
  assert.equal(f.gate.beforeRouting("Yes, proceed", { sessionKey: "s2" }), null, "one-time approval is consumed");
});

test("a pending escalation exposes a deterministic positive approval invitation", async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.dir, { recursive: true, force: true }));
  await f.gate.afterRouting("Hard task", { sessionKey: "friendly" }, {
    selectedProvider: "anthropic",
    selectedModel: "claude-sonnet-4-6",
    selectionDetails: { required_tier: "flagship_reasoning", reasoning: "complex reasoning" },
  });
  const invitation = f.gate.pendingInvitation({ sessionKey: "friendly" });
  assert.match(invitation, /^ToggleLogic is ready to continue with anthropic\/claude-sonnet-4-6\./);
  assert.match(invitation, /Estimated AI cost: \$0\.04\./);
  assert.match(invitation, /send this request and active SAM context to Anthropic for one use/);
  assert.match(invitation, /Reply “Yes, proceed” or “No”\.$/);
  assert.doesNotMatch(invitation, /could not be sent|blocked by/i);
});

test("a missing price stays honest without negative failure wording", async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.dir, { recursive: true, force: true }));
  f.pricing.resolve = async () => ({ priced: false });
  await f.gate.afterRouting("Hard task", { sessionKey: "unpriced-friendly" }, {
    selectedProvider: "anthropic",
    selectedModel: "claude-sonnet-4-6",
    selectionDetails: { required_tier: "flagship_reasoning" },
  });
  const blocked = f.gate.beforeAgentRun({}, { sessionKey: "unpriced-friendly" });
  assert.match(blocked.message, /Estimated AI cost: currently unavailable\./);
  assert.doesNotMatch(blocked.message, /could not|blocked|cannot/i);
});

test("pending approval survives a coordinator restart and state is owner-only", async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.dir, { recursive: true, force: true }));
  await f.gate.afterRouting("Hard private task", { sessionKey: "s3" }, {
    selectedProvider: "anthropic",
    selectedModel: "claude-sonnet-4-6",
    selectionDetails: { required_tier: "flagship_reasoning" },
  });
  assert.equal(fs.statSync(f.statePath).mode & 0o777, 0o600);
  const restarted = createApprovalGate({ config: f.config, pricing: f.pricing });
  const approval = restarted.beforeRouting("Proceed", { sessionKey: "s3" });
  assert.equal(approval.action, "approved");
});

test("denial blocks the run and prevents external submission", async (t) => {
  const f = fixture({ localModel: "" });
  t.after(() => fs.rmSync(f.dir, { recursive: true, force: true }));
  await f.gate.afterRouting("Hard task", { sessionKey: "s4" }, {
    selectedProvider: "anthropic",
    selectedModel: "claude-sonnet-4-6",
    selectionDetails: { required_tier: "flagship_reasoning" },
  });
  assert.equal(f.gate.beforeRouting("No", { sessionKey: "s4" }).action, "denied");
  const denied = f.gate.beforeAgentRun({}, { sessionKey: "s4" });
  assert.equal(denied.outcome, "block");
  assert.match(denied.message, /No external AI model received/);
});

test("execution receipt reports actual runtime model, location, usage, and cost", async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.dir, { recursive: true, force: true }));
  await f.gate.observeOutput({
    runId: "r5",
    sessionId: "opaque",
    provider: "ollama",
    model: "gemma4:latest",
    resolvedRef: "ollama/gemma4:latest",
    usage: { input: 100, output: 25 },
  }, { sessionKey: "s5", runId: "r5" });
  const result = f.gate.appendReceipt({ content: "Done." }, { sessionKey: "s5" });
  assert.match(result.content, /ollama\/gemma4:latest/);
  assert.match(result.content, /LOCAL/);
  assert.match(result.content, /100 in \/ 25 out/);
  assert.match(result.content, /external AI provider cost: \$0\.0000/);
});

test("OpenClaw policy reroute is not mislabeled as a model fallback", async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.dir, { recursive: true, force: true }));
  const result = await f.gate.prepareReplyPayload({
    kind: "final",
    payload: { text: "↪️ Model Fallback: ollama/gemma4:latest", isFallbackNotice: true },
    usageState: {
      requested: "anthropic/claude-haiku-4-5",
      resolvedRef: "ollama/gemma4:latest",
      fallbackUsed: false,
    },
  }, { sessionKey: "s6" });
  assert.deepEqual(result, { cancel: true, reason: "togglelogic_policy_reroute_not_fallback" });
});

test("real and uncertain fallback notices are preserved", async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.dir, { recursive: true, force: true }));
  const payload = { text: "↪️ Model Fallback: backup/model", isFallbackNotice: true };
  const real = await f.gate.prepareReplyPayload({
    kind: "final",
    payload,
    usageState: { requested: "primary/model", resolvedRef: "backup/model", fallbackUsed: true },
  }, { sessionKey: "s7" });
  const uncertain = await f.gate.prepareReplyPayload({ kind: "final", payload }, { sessionKey: "s7" });
  assert.equal(real, undefined);
  assert.equal(uncertain, undefined);
});

test("delivery-time runtime evidence adds one local execution receipt", async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.dir, { recursive: true, force: true }));
  const event = {
    kind: "final",
    sessionKey: "s8",
    payload: { text: "Done.", delivery: { mode: "normal" } },
    usageState: {
      provider: "ollama",
      model: "gemma4:latest",
      resolvedRef: "ollama/gemma4:latest",
      requested: "anthropic/claude-haiku-4-5",
      fallbackUsed: false,
      usage: { input: 123, output: 45 },
    },
  };
  const result = await f.gate.prepareReplyPayload(event, { sessionKey: "s8" });
  assert.equal(result.payload.delivery.mode, "normal");
  assert.match(result.payload.text, /ollama\/gemma4:latest/);
  assert.match(result.payload.text, /selected by ToggleLogic policy; no external AI model/);
  assert.match(result.payload.text, /123 in \/ 45 out/);
  assert.match(result.payload.text, /external AI provider cost: \$0\.0000 \(local-provider-api\)/);

  const duplicate = await f.gate.prepareReplyPayload({
    ...event,
    payload: { text: result.payload.text },
  }, { sessionKey: "s8" });
  assert.equal(duplicate, undefined);
  assert.equal((result.payload.text.match(/ToggleLogic execution receipt:/g) || []).length, 1);
});

test("delivery receipt records one-time approval and runtime external cost", async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.dir, { recursive: true, force: true }));
  await f.gate.afterRouting("Hard task", { sessionKey: "s9" }, {
    selectedProvider: "anthropic",
    selectedModel: "claude-sonnet-4-6",
    selectionDetails: { required_tier: "flagship_reasoning" },
  });
  f.gate.beforeRouting("Yes, proceed", { sessionKey: "s9" });
  f.gate.beforeAgentRun({}, { sessionKey: "s9" });
  const result = await f.gate.prepareReplyPayload({
    kind: "final",
    sessionKey: "s9",
    payload: { text: "External result." },
    usageState: {
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      resolvedRef: "anthropic/claude-sonnet-4-6",
      requested: "anthropic/claude-sonnet-4-6",
      fallbackUsed: false,
      turnUsd: 0.024,
      usage: { input: 2000, output: 1200 },
    },
  }, { sessionKey: "s9" });
  assert.match(result.payload.text, /EXTERNAL AI MODEL/);
  assert.match(result.payload.text, /owner approval: verified once/);
  assert.match(result.payload.text, /runtime-reported AI cost: \$0\.02 \(openclaw-runtime\)/);
  assert.equal(f.gate._pending.has("s9"), false);
});

test("OpenClaw 2026.9.4 dual-hook delivery emits one receipt and drains correlation state", async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.dir, { recursive: true, force: true }));
  const ctx = { sessionKey: "s10", runId: "r10" };
  await f.gate.observeOutput({
    runId: "r10",
    provider: "ollama",
    model: "gemma4:latest",
    resolvedRef: "ollama/gemma4:latest",
    usage: { input: 75, output: 20 },
  }, ctx);
  assert.ok(f.gate._receipts.size > 0);

  const prepared = await f.gate.prepareReplyPayload({
    kind: "final",
    sessionKey: "s10",
    runId: "r10",
    payload: { text: "Done." },
    usageState: {
      provider: "ollama",
      model: "gemma4:latest",
      resolvedRef: "ollama/gemma4:latest",
      requested: "anthropic/claude-haiku-4-5",
      fallbackUsed: false,
      usage: { input: 75, output: 20 },
    },
  }, ctx);
  assert.equal(f.gate._receipts.size, 0);
  assert.equal(f.gate.appendReceipt({ content: prepared.payload.text }, ctx), undefined);
  assert.equal((prepared.payload.text.match(/ToggleLogic execution receipt:/g) || []).length, 1);
});

test("public catalog pricing is labeled as an estimate, never actual provider billing", async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.dir, { recursive: true, force: true }));
  const result = await f.gate.prepareReplyPayload({
    kind: "final",
    sessionKey: "s11",
    payload: { text: "Result." },
    usageState: {
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      resolvedRef: "anthropic/claude-sonnet-4-6",
      fallbackUsed: false,
      usage: { input: 100, output: 200 },
    },
  }, { sessionKey: "s11" });
  assert.match(result.payload.text, /estimated AI cost: \$0\.0033 \(test-prices\)/);
  assert.doesNotMatch(result.payload.text, /actual AI cost/i);
});

test("unavailable external pricing is explicit and never represented as zero", async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.dir, { recursive: true, force: true }));
  const gate = createApprovalGate({
    config: f.config,
    pricing: {
      async resolve() { return { priced: false, source: null }; },
      costUsd() { throw new Error("must not price an unpriced model"); },
    },
  });
  const result = await gate.prepareReplyPayload({
    kind: "final",
    sessionKey: "s12",
    payload: { text: "Result." },
    usageState: {
      provider: "external-provider",
      model: "unpriced-model",
      resolvedRef: "external-provider/unpriced-model",
      fallbackUsed: false,
      usage: { input: 100, output: 200 },
    },
  }, { sessionKey: "s12" });
  assert.match(result.payload.text, /AI cost: unavailable—not \$0/);
  assert.doesNotMatch(result.payload.text, /AI cost: \$0(?:\.0+)?(?:\D|$)/);
});
