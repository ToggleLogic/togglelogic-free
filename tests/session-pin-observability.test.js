// 2.1.3: the legacy sessions.json pin store is inert on SQLite OpenClaw. The
// plugin surfaces that once (session_pin_store_absent) instead of silently, and
// a user's model selection is still honored via request_selection.
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeConfig } from "../src/config/normalize.js";
import { createInterceptor } from "../src/routing/interceptor.js";

// session.store points at a path that cannot exist, so readSessionSelection
// deterministically returns status "read_error" on any machine (mirrors the
// SQLite reality where sessions.json is absent).
const hostConfig = {
  session: { store: "/nonexistent-tl-test/{agentId}/sessions.json" },
  agents: { defaults: { model: { primary: "anthropic/claude-haiku-4-5", fallbacks: ["anthropic/claude-sonnet-4-6"] } } },
};
function harness() {
  const decisions = [];
  const events = [];
  const interceptor = createInterceptor({
    config: normalizeConfig({ mode: "cheap", cheapHeuristic: { default: "anthropic/claude-haiku-4-5" }, features: { routing: { enabled: true } } }),
    hostConfig,
    logger: { write: async (d) => { decisions.push(d); } },
    audit: { emit: (e) => events.push(e) },
    seam: { status: () => "unavailable", classify: async () => null },
    version: "test", configuredProviders: [], governedEscalation: null,
  });
  return { interceptor, decisions, events };
}
const absentEvents = (events) => events.filter((e) => e.event === "session_pin_store_absent");

test("session_pin_store_absent is emitted once per interceptor when the legacy store is unreadable", async () => {
  const { interceptor, events } = harness();
  await interceptor({ prompt: "SENTINEL_XYZZY_ALPHA" }, { sessionKey: "agent:main:a", agentId: "main", modelProviderId: "anthropic", modelId: "claude-haiku-4-5" });
  await interceptor({ prompt: "SENTINEL_XYZZY_BETA" }, { sessionKey: "agent:main:b", agentId: "main", modelProviderId: "anthropic", modelId: "claude-haiku-4-5" });
  const absent = absentEvents(events);
  assert.equal(absent.length, 1, "fires exactly once across turns, not every turn");
  assert.equal(absent[0].outcome, "noop");
  assert.match(String(absent[0].details?.storePath || ""), /nonexistent-tl-test/);
  assert.ok(absent[0].details?.reason, "records the read error reason");
  assert.doesNotMatch(JSON.stringify(absent[0]), /SENTINEL_XYZZY/, "carries no conversation content");
});

test("a user's model selection is still honored via request_selection despite the absent legacy store", async () => {
  const { interceptor, decisions, events } = harness();
  const out = await interceptor(
    { prompt: "Reply OK" },
    { sessionKey: "agent:main:c", agentId: "main", modelProviderId: "anthropic", modelId: "claude-sonnet-4-6" },
  );
  assert.deepEqual(out, {}, "passthrough keeps the host-resolved (pinned/selected) model");
  assert.equal(decisions.at(-1).selectionReason, "request_selection");
  assert.equal(decisions.at(-1).selectedModel, "anthropic/claude-sonnet-4-6");
  // and the inert legacy store was surfaced, not silently ignored
  assert.equal(absentEvents(events).length, 1);
});
