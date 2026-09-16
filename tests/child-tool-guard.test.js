import test from "node:test";
import assert from "node:assert/strict";

import { createChildToolGuard } from "../src/skill-routing/child-tool-guard.js";

test("guard abstains from non-child sessions even when an event would throw", () => {
  const guard = createChildToolGuard();
  const event = {};
  Object.defineProperty(event, "toolName", { get() { throw new Error("must not be read"); } });
  assert.equal(guard.beforeToolCall(event, { sessionKey: "agent:main:ordinary" }), undefined);
});

test("guard fails closed after a routed child is identified and records the internal error", () => {
  const logs = [];
  const audits = [];
  const guard = createChildToolGuard({
    logger: { warn: (line) => logs.push(line) },
    auditInternalError: (event) => audits.push(event),
  });
  const sessionKey = "agent:main:owner:togglelogic-skill:abcdef";
  guard.register(sessionKey, { skills: ["microsoft-graph"], maxToolCalls: 8 });
  const event = {};
  Object.defineProperty(event, "toolName", { get() { throw new Error("TOPSECRET synthetic guard fault"); } });

  const decision = guard.beforeToolCall(event, { sessionKey });
  assert.deepEqual(decision, {
    block: true,
    blockReason: "ToggleLogic blocked this routed child tool call because its safety guard encountered an internal error.",
  });
  assert.equal(logs.length, 1);
  assert.match(logs[0], /BLOCKED governed child tool call/);
  assert.doesNotMatch(logs[0], /TOPSECRET/);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].mode, "skill_child_guard_internal_error");
  assert.equal(audits[0].blocked, true);
  assert.match(audits[0].child_session_key_hash, /^[a-f0-9]{64}$/);
  assert.equal(Object.hasOwn(audits[0], "sessionKey"), false);
  assert.doesNotMatch(JSON.stringify(audits[0]), /TOPSECRET/);
  assert.deepEqual(guard.release(sessionKey), {
    toolCalls: 0,
    deniedToolCalls: 1,
    internalGuardErrors: 1,
    ceiling: 8,
    allowlisted: false,
    deniedTools: ["<guard-internal-error>"],
  });
});

test("normal routed-child limits still enforce re-entrancy, allowlists, and count ceiling", () => {
  const guard = createChildToolGuard();
  const sessionKey = "agent:main:owner:togglelogic-skill:limits";
  guard.register(sessionKey, { allowedTools: ["graph_call"], maxToolCalls: 1 });
  assert.equal(guard.beforeToolCall({ toolName: "graph_call" }, { sessionKey }), undefined);
  assert.match(guard.beforeToolCall({ toolName: "graph_call" }, { sessionKey }).blockReason, /ceiling/);
  assert.match(guard.beforeToolCall({ toolName: "shell" }, { sessionKey }).blockReason, /allowed tool surface/);
  assert.match(guard.beforeToolCall({ toolName: "togglelogic_skill_run" }, { sessionKey }).blockReason, /no nested routing/);
});
