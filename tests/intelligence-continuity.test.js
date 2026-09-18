import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createAdapter } from "../src/intelligence/adapter.js";

test("affirmative confirmation inherits the preceding decision once within the same session", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tl-continuity-"));
  try {
    await fs.mkdir(path.join(root, "src"));
    await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ type: "module" }));
    await fs.writeFile(path.join(root, "src", "classifier.js"), `
      export function classify(prompt) {
        if (/outlook draft/i.test(prompt)) return {
          recommended_model_ref: "xai/grok-4.3",
          required_tier: "tool_calling_strong",
          required_surface: "local_exec",
          confidence: 0.95,
          matched_rule: "agentic_integration_action",
          reasoning: "tool action"
        };
        return { recommended_model_ref: null, required_tier: null, confidence: 0, matched_rule: "no_decision" };
      }
    `);
    const adapter = await createAdapter({ intelligencePath: root, version: "test", shadow: false });
    const initial = await adapter.classify(
      { prompt: "Create two Outlook drafts for the customer", hookContext: { sessionKey: "sam-hq" } },
      {},
    );
    const confirmed = await adapter.classify(
      { prompt: "Yes, that is exactly what I need you to do.", hookContext: { sessionKey: "sam-hq" } },
      {},
    );
    const stale = await adapter.classify(
      { prompt: "Yes", hookContext: { sessionKey: "sam-hq" } },
      {},
    );
    const otherSession = await adapter.classify(
      { prompt: "Yes", hookContext: { sessionKey: "someone-else" } },
      {},
    );

    assert.equal(initial.providerOverride, "xai");
    assert.equal(confirmed.providerOverride, "xai");
    assert.equal(confirmed.details.required_surface, "local_exec");
    assert.match(confirmed.details.matched_rule, /^confirmation_inherit:/);
    assert.equal(stale, null, "continuity must be consumed after one confirmation");
    assert.equal(otherSession, null, "continuity must never cross sessions");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
