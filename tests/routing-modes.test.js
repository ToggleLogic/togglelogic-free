import { test } from "node:test";
import assert from "node:assert/strict";
import { dispatchByMode, pickConfiguredRoute, resolveEffectiveMode } from "../src/routing/modes.js";

const unavailableSeam = { status: () => "unavailable", classify: async () => null };

test("configured routes honor a structured host task label before default", () => {
  const route = pickConfiguredRoute(
    { invoice: "google/gemini-flash", default: "anthropic/claude-haiku" },
    { prompt: "This text must not be used for routing", metadata: { taskType: "ignored" } },
    { taskType: "invoice" },
  );
  assert.deepEqual(route, { key: "invoice", modelId: "google/gemini-flash" });
});

test("configured routes use default only after a structured-label miss", () => {
  const route = pickConfiguredRoute(
    { default: "anthropic/claude-haiku" },
    { task: "quote" },
  );
  assert.deepEqual(route, { key: "default", modelId: "anthropic/claude-haiku", requestedKey: "quote" });
});

test("configured routes never infer a key from prompt text", () => {
  const route = pickConfiguredRoute(
    { invoice: "google/gemini-flash" },
    { prompt: "Please create an invoice" },
  );
  assert.equal(route, null);
});

test("explicit Intelligence mode remains visibly unavailable", async () => {
  assert.equal(resolveEffectiveMode("intelligence", "unavailable", { cheapHeuristic: { default: "cheap/model" } }), "intelligence_unavailable");
  const result = await dispatchByMode({
    mode: "intelligence_unavailable",
    event: {}, hookContext: {}, config: {}, seam: unavailableSeam,
  });
  assert.deepEqual(result.override, {});
  assert.equal(result.selectionReason, "passthrough");
  assert.equal(result.selectionDetails.reason, "explicit Intelligence mode unavailable");
});

test("auto keeps its documented cheap fallback when Intelligence is unavailable", () => {
  assert.equal(resolveEffectiveMode("auto", "unavailable", { cheapHeuristic: { default: "cheap/model" } }), "cheap");
});
