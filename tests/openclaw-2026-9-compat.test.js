import test from "node:test";
import assert from "node:assert/strict";

import { dispatchByMode, resolveEffectiveMode } from "../src/routing/modes.js";
import { createIntelligenceSeam } from "../src/intelligence/seam.js";

test("explicit intelligence waits through cold detection", () => {
  assert.equal(resolveEffectiveMode("intelligence", "detecting", {}), "intelligence");
});

test("explicit intelligence remains visibly unavailable after absence", () => {
  assert.equal(
    resolveEffectiveMode("intelligence", "absent", {}),
    "intelligence_unavailable",
  );
});

test("cheap mode splits provider/model refs for the OpenClaw override contract", async () => {
  const result = await dispatchByMode({
    mode: "cheap",
    config: { cheapHeuristic: { default: "anthropic/claude-haiku-4-5" } },
  });
  assert.deepEqual(result.override, {
    modelOverride: "claude-haiku-4-5",
    providerOverride: "anthropic",
  });
  assert.equal(result.selectedModel, "anthropic/claude-haiku-4-5");
  assert.equal(result.selectedProvider, "anthropic");
});

test("configured mode splits provider/model refs for the OpenClaw override contract", async () => {
  const result = await dispatchByMode({
    mode: "configured",
    event: {},
    hookContext: {},
    config: { configuredRoutes: { default: "openai/gpt-5.4" } },
  });
  assert.deepEqual(result.override, {
    modelOverride: "gpt-5.4",
    providerOverride: "openai",
  });
  assert.equal(result.selectedModel, "openai/gpt-5.4");
  assert.equal(result.selectedProvider, "openai");
});

test("disabled Intelligence detection remains awaitable during hook registration", async () => {
  const seam = createIntelligenceSeam({ enabled: false });
  await assert.doesNotReject(() => seam.detect());
  assert.equal(seam.status(), "disabled");
});
