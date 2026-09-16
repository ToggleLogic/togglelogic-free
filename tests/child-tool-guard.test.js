/*
 * ToggleLogic (Free Tier) — bounded-child tool guard tests (before_tool_call).
 *
 * Proves the plugin-enforceable half of the child ceiling: re-entrant routing
 * tools are always denied on a routed child, a per-skill allowlist is enforced,
 * a per-run tool-call COUNT ceiling denies further calls, non-child sessions are
 * never touched, and the guard never throws into the host hook.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { createChildToolGuard, isChildSkillSession } from "../src/skill-routing/child-tool-guard.js";

const CHILD = "agent:main:telegram:codex:7797183919:togglelogic-skill:abc123";
const MAIN = "agent:main:telegram:codex:7797183919";

test("guard: abstains (allows) for non-child sessions", () => {
  const g = createChildToolGuard({});
  assert.equal(g.beforeToolCall({ toolName: "anything" }, { sessionKey: MAIN }), undefined);
  assert.equal(g.beforeToolCall({ toolName: "togglelogic_skill_run" }, { sessionKey: MAIN }), undefined);
  assert.equal(isChildSkillSession(MAIN), false);
  assert.equal(isChildSkillSession(CHILD), true);
});

test("guard: ALWAYS denies re-entrant ToggleLogic routing tools on a child", () => {
  const g = createChildToolGuard({});
  for (const tool of ["togglelogic_skill_plan", "togglelogic_skill_run"]) {
    const d = g.beforeToolCall({ toolName: tool }, { sessionKey: CHILD });
    assert.equal(d.block, true);
    assert.match(d.blockReason, /nested routing/i);
  }
});

test("guard: enforces a per-skill allowlist", () => {
  const g = createChildToolGuard({});
  g.register(CHILD, { skills: [{ id: "meeting-prep" }], allowedTools: ["graph_read", "zoom_read"], maxToolCalls: 10 });
  assert.equal(g.beforeToolCall({ toolName: "graph_read" }, { sessionKey: CHILD }), undefined, "allowed tool passes");
  const denied = g.beforeToolCall({ toolName: "shell_exec" }, { sessionKey: CHILD });
  assert.equal(denied.block, true);
  assert.match(denied.blockReason, /not in the allowed tool surface/i);
});

test("guard: enforces the per-run tool-call COUNT ceiling", () => {
  const g = createChildToolGuard({ maxToolCalls: 3 });
  g.register(CHILD, { skills: [{ id: "code-review" }] }); // no allowlist → count-only
  for (let i = 0; i < 3; i += 1) {
    assert.equal(g.beforeToolCall({ toolName: "read_file" }, { sessionKey: CHILD }), undefined, `call ${i + 1} allowed`);
  }
  const over = g.beforeToolCall({ toolName: "read_file" }, { sessionKey: CHILD });
  assert.equal(over.block, true);
  assert.match(over.blockReason, /tool-call ceiling \(3\)/);
  const snap = g.snapshot(CHILD);
  assert.equal(snap.toolCalls, 3);
  assert.equal(snap.deniedToolCalls, 1);
});

test("guard: register overrides lazy default; release returns final counters", () => {
  const g = createChildToolGuard({ maxToolCalls: 32 });
  g.register(CHILD, { skills: [{ id: "code-review" }], maxToolCalls: 2 });
  g.beforeToolCall({ toolName: "a" }, { sessionKey: CHILD });
  g.beforeToolCall({ toolName: "b" }, { sessionKey: CHILD });
  g.beforeToolCall({ toolName: "c" }, { sessionKey: CHILD }); // denied (over ceiling 2)
  const released = g.release(CHILD);
  assert.equal(released.toolCalls, 2);
  assert.equal(released.deniedToolCalls, 1);
  assert.equal(released.ceiling, 2);
  assert.equal(g.snapshot(CHILD), null, "entry removed after release");
});

test("guard: lazily bounds an UNREGISTERED child session (defense-in-depth)", () => {
  const g = createChildToolGuard({ maxToolCalls: 1 });
  // No register() call — a child session the guard sees for the first time.
  assert.equal(g.beforeToolCall({ toolName: "x" }, { sessionKey: CHILD }), undefined);
  const over = g.beforeToolCall({ toolName: "y" }, { sessionKey: CHILD });
  assert.equal(over.block, true, "count cap still applies without register()");
});

test("guard: is total — never throws on malformed input", () => {
  const g = createChildToolGuard({});
  assert.doesNotThrow(() => g.beforeToolCall(undefined, undefined));
  assert.doesNotThrow(() => g.beforeToolCall({}, {}));
  assert.doesNotThrow(() => g.beforeToolCall(null, { sessionKey: CHILD }));
});
