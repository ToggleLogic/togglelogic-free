// 2.0.3: an explicit per-request or per-session model choice is honored.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeConfig } from "../src/config/normalize.js";
import { createInterceptor, hostDefaultModelRef, isRequestSelection } from "../src/routing/interceptor.js";

const hostConfig = { agents: { defaults: { model: { primary: "anthropic/claude-haiku-4-5", fallbacks: ["anthropic/claude-sonnet-4-6"] } } } };
function harness(config, extras = {}) {
  const decisions = [];
  const interceptor = createInterceptor({
    config, hostConfig: extras.hostConfig ?? hostConfig, logger: { write: async (d) => { decisions.push(d); } }, audit: { emit() {} },
    seam: { status: () => "unavailable", classify: async () => null }, version: "test", configuredProviders: [], governedEscalation: null,
  });
  return { interceptor, decisions };
}
const cheap = () => normalizeConfig({ mode: "cheap", cheapHeuristic: { default: "anthropic/claude-haiku-4-5" }, features: { routing: { enabled: true } } });

test("host default is read from the agent entry, then agent defaults", () => {
  assert.equal(hostDefaultModelRef(hostConfig, "main"), "anthropic/claude-haiku-4-5");
  assert.equal(hostDefaultModelRef({ agents: { defaults: { model: "xai/grok-4" }, list: [{ id: "ops", model: { primary: "google/gemini-3.5-flash" } }] } }, "ops"), "google/gemini-3.5-flash");
  assert.equal(hostDefaultModelRef({}, "main"), null);
});

test("a model different from the host default is an explicit selection; the default is not", () => {
  assert.equal(isRequestSelection({ provider: "anthropic", model: "claude-sonnet-4-6" }, "anthropic/claude-haiku-4-5"), true);
  assert.equal(isRequestSelection({ provider: "anthropic", model: "claude-haiku-4-5" }, "anthropic/claude-haiku-4-5"), false);
  assert.equal(isRequestSelection({ provider: null, model: "claude-haiku-4-5" }, "anthropic/claude-haiku-4-5"), false);
  assert.equal(isRequestSelection({ provider: "anthropic", model: "claude-sonnet-4-6" }, null), false, "unknown host default never guesses");
});

test("SAM-Andy regression: --model sonnet is honored instead of replaced by the cheap default", async () => {
  const { interceptor, decisions } = harness(cheap());
  const out = await interceptor({ prompt: "Reply with OK" }, { sessionKey: "agent:main:t1", agentId: "main", modelProviderId: "anthropic", modelId: "claude-sonnet-4-6" });
  assert.deepEqual(out, {}, "passthrough keeps the requested model");
  assert.equal(decisions.at(-1).selectionReason, "request_selection");
  assert.equal(decisions.at(-1).selectedModel, "anthropic/claude-sonnet-4-6");
});

test("ordinary turns on the host default still route to the configured cheap default", async () => {
  const cfg = normalizeConfig({ mode: "cheap", cheapHeuristic: { default: "anthropic/claude-haiku-4-5" }, features: { routing: { enabled: true } } });
  const { interceptor, decisions } = harness(cfg, { hostConfig: { agents: { defaults: { model: { primary: "anthropic/claude-sonnet-4-6" } } } } });
  const out = await interceptor({ prompt: "hello" }, { sessionKey: "agent:main:t2", agentId: "main", modelProviderId: "anthropic", modelId: "claude-sonnet-4-6" });
  assert.equal(decisions.at(-1).selectionReason !== "request_selection", true);
  assert.equal(out.modelOverride, "claude-haiku-4-5");
});

test("owner override still outranks a per-request selection", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tl-req-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const statePath = path.join(dir, "o.json"); fs.writeFileSync(statePath, JSON.stringify({ active: true, model_ref: "google/gemini-3.5-flash" }));
  const cfg = normalizeConfig({ mode: "cheap", cheapHeuristic: { default: "anthropic/claude-haiku-4-5" }, ownerOverride: { enabled: true, statePath }, features: { routing: { enabled: true } } });
  const { interceptor, decisions } = harness(cfg);
  const out = await interceptor({ prompt: "x" }, { sessionKey: "agent:main:t3", agentId: "main", modelProviderId: "anthropic", modelId: "claude-sonnet-4-6" });
  assert.equal(decisions.at(-1).selectionReason, "owner_override"); assert.equal(out.modelOverride, "gemini-3.5-flash");
});
