# Bounded-Child Limits — what ToggleLogic enforces, and the residual host gap

ToggleLogic routes a resolved skill into a **bounded child session** via
`api.runtime.subagent.run`. This document is the honest, evidence-based statement
of which limits the plugin can enforce on that child on OpenClaw **2026.9.4**, and
exactly what the host would need to add to close the one remaining gap. It is
paired with `src/skill-routing/coordinator.js` (`executeBoundedChild`) and
`src/skill-routing/child-tool-guard.js`.

## What the plugin enforces today (all real, all tested)

| Limit | Mechanism | Evidence |
| --- | --- | --- |
| **Fresh, unique child session** | `sessionKey = <parent>:togglelogic-skill:<hash>` — no fat-main history | `coordinator.js` executeBoundedChild |
| **Minimal prompt** | `SubagentRunParams.promptMode: "minimal"` (real field) | host `SubagentRunParams:promptMode?: "minimal"` |
| **Light context** | `SubagentRunParams.lightContext: true` (real field) | host `SubagentRunParams:lightContext?` |
| **Empty tool surface (per skill)** | `SubagentRunParams.disableTools: true` when the skill's policy declares no tools | host `SubagentRunParams:disableTools?` |
| **Per-skill tool allowlist** | `before_tool_call` guard denies (`{block:true}`) any tool outside the declared allowlist on the child session | host `before_tool_call` → `{block, blockReason}`; `child-tool-guard.js` |
| **Hard tool-call COUNT ceiling** | `before_tool_call` guard denies further tool calls after `maxChildToolCalls` on the child | `child-tool-guard.js` |
| **Fail-closed guard errors** | Non-child sessions are ignored, but after `:togglelogic-skill:` identification any internal guard error blocks the call and emits an immediate hashed audit plus the post-run counter | `child-tool-guard.js`; coordinator usage audit |
| **No nested routing** | guard always denies `togglelogic_skill_plan`/`togglelogic_skill_run` on a child (+ system-prompt instruction + `sessionKey` re-entry check) | `child-tool-guard.js`; coordinator |
| **Exact child-model binding** | coordinator registers the planned provider/model before spawn; child `before_model_resolve` uses that binding without owner reclassification and refuses a missing binding | `child-tool-guard.js`; `interceptor.js` |
| **Observed-model mismatch rejection** | a host-observed provider/model different from the binding marks the audit `model_mismatch` and rejects the result | `coordinator.js` |
| **Wall-clock timeout** | `subagent.waitForRun({ timeoutMs })` bounds the wait; config `agents.defaults.subagents.runTimeoutSeconds` bounds the run host-side | host `SubagentWaitParams:timeoutMs`; `agents.defaults.subagents.runTimeoutSeconds` |
| **Pre-flight estimate gate** | refuse to start when the plan's own token/cost estimate exceeds `maxChildTokens`/`maxChildCostUsd` | `coordinator.js` |
| **Post-run usage audit** | emit actual tool-call count, denied count, wall-clock, stopReason after every child run (success or failure) | `coordinator.js` finally block; `auditUsage` |

For a multi-skill route, component tool-call ceilings form a bounded composite:
each unique non-disabled skill contributes its declared ceiling, contributions
are summed, and the sum is capped by the deployment-wide
`maxChildToolCalls`. An undeclared component contributes the global ceiling, so
composition can never expand authority beyond the hard deployment limit. This
allows Graph+Zoom or Graph+artifact workflows to use both declared budgets while
preventing the old minimum-component rule from prematurely stopping valid work.

A guard denial makes the entire child result incomplete: even if the model later
returns prose claiming success, the coordinator records `tool_guard_denied` and
rejects the result. This is essential for artifact workflows where calls after
the edit perform reopen/render/content verification.

`powerpoint-editor` has a 24-call workflow floor, still capped by the global
ceiling. The allocation covers inspection, edit/write, rendering and visual QA,
reopen/content verification, and bounded recovery. An explicit zero remains
zero. This replaces the RC3 12-call configuration that exhausted before final
verification.

## The residual gap (NOT closable by the plugin on 2026.9.4)

The host exposes **no** way for a plugin to:

1. cap the **model token** spend of a running child, or
2. cap the **number of model passes** (assistant turns) in a child, or
3. **hard-abort** a specific in-flight subagent `run`, or
4. **read the child's actual model token/cost usage** after the run.

Evidence (installed host `dist/`):
- `SubagentRunParams` has no `maxModelTokens` / `maxModelPasses` / `budgetUsd` /
  abort field — `dist/agent-harness-runtime-CZb40n5o.d.ts:23017-23036`.
- `PluginRuntime.subagent` exposes only `run/complete/waitForRun/
  getSessionMessages/deleteSession` — no `kill`/`abort` for a tool-capable `run`
  (`:23129-23138`). Only `subagent.complete` (tool-free inference) takes
  `signal`/`timeoutMs`.
- `model_call_started`/`model_call_ended` are **void** observation hooks — they
  cannot abort a call (`dist/hook-runner-global-DWDBlTB2.d.ts:1447-1448`).
- `SubagentRunResult` / `AgentWaitResult` carry no token/cost usage
  (`:23050-23058`, `:22998-23013`) — so the post-run audit reports what the plugin
  *measured* (tool calls, wall clock), and marks model tokens
  `model_usage_host_observable: false` rather than fabricating a number.

The tool-call COUNT ceiling bounds a runaway **tool loop**, not model-token spend:
a child with no tool calls but many model passes is still only bounded by the
wall-clock timeout, not by tokens.

## Exact minimal host additions to close the gap

The smallest additions to `SubagentRunParams`
(`dist/agent-harness-runtime-CZb40n5o.d.ts:23017`) that would let the plugin
declare a hard runtime ceiling at spawn time:

```ts
type SubagentRunParams = {
  // …existing…
  maxModelTokens?: number;   // abort the run once cumulative model tokens exceed this
  maxModelPasses?: number;   // cap assistant turns; abort on exceed
  budgetUsd?: number;        // optional cost ceiling (priced host-side)
  onLimitExceeded?: "abort" | "finalize"; // default "abort"
};
```

Plus, for observability and defense-in-depth:

```ts
// PluginRuntime.subagent
abort(params: { runId: string; reason?: string }): Promise<void>;
// AgentWaitResult / SubagentRunResult
usage?: { inputTokens: number; outputTokens: number; modelPasses: number; costUsd?: number };
```

With `maxModelTokens` + `onLimitExceeded:"abort"` (or `subagent.abort` + a
`model_call_ended` running total), the plugin could enforce a true hard token/pass
ceiling and reconcile the post-run audit against real usage.

## Does the residual gap block a scoped canary, or only global release?

**It blocks only the unbounded GLOBAL release, not a correctly-scoped owner
canary.** Reasoning:

- A scoped canary (`skillRouting.scope`) is limited to a single trusted owner
  identity (Al's SAM Telegram DM). The only party exposed to an uncapped child is
  the owner, who is present and can stop it; there is no at-scale or third-party
  blast radius.
- Worst case per turn is bounded by the **wall-clock timeout** and the **tool-call
  ceiling** (so no unbounded tool-driven amplification), on a **fresh light-context
  session** (so no 452K-token fat-main replay — the actual 2026-09-15 failure
  mode). What remains uncapped is model tokens *within one bounded-wall-clock,
  tool-limited child* — a materially smaller, owner-observed risk.
- For a **global** release (untrusted senders, unattended/at-scale turns), an
  uncapped per-turn model spend is not acceptable, so global release remains
  **NO-GO** until the host adds the token/pass cap above.

**Conclusion:** the residual gap is a documented GLOBAL-release blocker, not a
scoped-canary blocker. A scoped owner canary is defensible today on the strength of
scope + fresh session + wall-clock + tool-call ceiling + pre-flight estimate; the
plugin does not claim a runtime model-token ceiling it cannot enforce
(`runtime_token_ceiling_enforced: false` in every child audit).
