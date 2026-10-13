# M1 design — Host adapters and the gateway-neutral Decision API

Status: **design for owner review** (2026-10-13). Target: **ToggleLogic Free 2.2.0**.
Baseline: Free 2.1.4 (`121ed11`). No code has changed.

## 1. Problem

The decision logic in 2.1.4 is correct but welded to OpenClaw. To serve as a
policy decision block beside Kong, LiteLLM, Envoy-based gateways, Azure APIM or
OpenClaw, the decision must be computable from a host-neutral request and
returned as a host-neutral response.

## 2. Coupling inventory (from source, `v2.1.4`)

| # | Coupling | Where | Moves to |
|---|---|---|---|
| C1 | `definePluginEntry` from `openclaw/plugin-sdk` | `src/index.js` | OpenClaw adapter |
| C2 | Hook registration via `api.on`: `session_start`, `before_model_resolve`, `before_agent_reply`, `before_agent_run`, `agent_turn_prepare`, `llm_output`, `message_sending`, `reply_payload_sending` | `src/capabilities.js` | OpenClaw adapter |
| C3 | Host config shape: `agents.defaults.model`, `agents.list[].model`, `agents.defaults.models` (allowlist), `models.providers[*]` (`agentRuntime`, `baseUrl`, `models[]`), `model.fallbacks`, `session.store` | `interceptor.js`, `lineage-resolver.js`, `provider-refusal.js`, `events.js`, `capabilities.js`, `session-store.js` | Adapter translates to `candidates`, `defaultRef`, `fallbacks`, `providers[].local` |
| C4 | Hook context fields: `modelProviderId`, `modelId`, `modelOverrideSource`, `sessionKey`, `sessionId`, `agentId`, `channelId`, `taskType`/`task`/`capability`, `metadata.taskType` | `interceptor.js`, `decision.js`, `modes.js` | Adapter translates to `requested` and `work` |
| C5 | Session-pin provenance: `api.runtime.agent.session.getSessionEntry`, legacy `sessions.json`, `modelOverrideSource`, fallback-origin fields | `session-store.js` | OpenClaw adapter → `requested.source` |
| C6 | State paths default to `~/.openclaw/...` and honor `OPENCLAW_STATE_DIR` | `path-utils.js`, `normalize.js`, `session-store.js` | `StateStore` / `paths` supplied by adapter |
| C7 | Host quirks: duplicate `before_model_resolve` dedupe (60 s fingerprint), `before_agent_reply` preflight cache | `interceptor.js` | OpenClaw adapter (core is idempotent per request id) |
| C8 | `llm_output` event shape (`provider`, `model`, `usage`, `resolvedRef`, assistant message) | `cost-observer.js`, `provider-refusal.js`, `approval-gate.js` | Adapter → `UsageObservation` |
| C9 | Host override return shape `{ providerOverride, modelOverride }` | `interceptor.js`, `modes.js` | Adapter maps `DecisionResponse.decision` |
| C10 | Conversation-access permission check | `hooks/conversation-access.js` | OpenClaw adapter readiness |
| C11 | Seam passes an OpenClaw-shaped `runtimeConfig` (`byProvider`, `byModel`, `acceptedModelRefs`) | `capabilities.js` → `seam.js` | Seam ABI 2 receives `DecisionRequest` |
| C12 | Bounded executor depends on `runtime.subagent.*`; not wired in | `enforcement/bounded-executor.js` | Deprecated; not ported |
| C13 | Notification helper spawns `/usr/bin/python3` | `capture/owner-override-ask.js` | OpenClaw adapter; interpreter configurable |

Nothing outside this table reads host state. Pricing, lineage resolution,
budgets, balances, cost tally, audit and the routing log are already
host-neutral apart from their default paths (C6).

## 3. Architecture

```
            ┌──────────────── host ─────────────────┐
 OpenClaw ──┤ src/adapters/openclaw  (in process)    │
 LiteLLM  ──┤ adapters/litellm (Python hook) ─┐      │
 Envoy    ──┤ ext_authz (HTTP)  ──────────────┼─► bin/togglelogic-decide (sidecar, loopback)
            └─────────────────────────────────┼──────┘
                                              ▼
                     src/core  decide(request) ─► DecisionResponse
                       ├─ policy (config)          ├─ audit (M2)
                       ├─ lineage resolver          ├─ routing log
                       ├─ pricing / availability    └─ usage events
                       └─ seam (licensed layer, optional)
```

- `src/core/` — pure decision engine. Inputs: `DecisionRequest`, a frozen
  `Policy` (normalized config), and injected services. Output:
  `DecisionResponse`. No host imports, no `process.env` reads, no default home
  paths.
- `src/adapters/openclaw/` — owns C1–C13. `src/index.js` becomes a thin entry
  that builds the OpenClaw adapter, so the published plugin entry and config
  schema do not change.
- `bin/togglelogic-decide` — sidecar process hosting the same core for
  out-of-process adapters.
- `adapters/litellm/` and `adapters/envoy/` — integration kits (hook file,
  example config, compose file for the CI job). Not loaded by the plugin.

## 4. Decision API v1

Schemas: `docs/design/schemas/decision-request.v1.schema.json` and
`decision-response.v1.schema.json` (drafts; they move to
`schema/decision-api/v1/` when implemented). Identifier:
`togglelogic.decision/v1`. Additive changes keep `v1`; removing or retyping a
field requires `v2`.

### 4.1 Request

| Field | Meaning |
|---|---|
| `apiVersion` | `"togglelogic.decision/v1"` |
| `requestId` | Caller id; echoed as the correlation id. Generated if absent. |
| `tenant` | `{ id, costCenter? }` — department or client; drives attribution and (M3) policy selection. |
| `work` | `{ label?, labelSource, capabilityNeeds[] }`. `label` is a structured task label from the host, never derived from prompt text. |
| `dataClass` | Reserved for M5: `{ label, source: "host" }`. Accepted and audited in 2.2.0; enforced in 2.4.0. |
| `requested` | `{ ref?, source }` with `source` ∈ `user`, `request`, `auto`, `default`, `none`. This is the host's statement of who chose the current model. |
| `defaultRef` | The host's declared default for this agent or route. |
| `candidates` | `[{ ref, lineage?, local?, surfaces?, releaseDate? }]` — the models this host is allowed to run. Authoritative allowlist. |
| `fallbacks` | Host-declared fallback refs, in order. |
| `hostSignals` | `{ unavailableProviders[] }` — providers the host currently knows are refusing. |
| `usageEstimate` | Optional `{ inputTokens, outputTokens }` used only to compute the dollar estimate. |
| `content` | Optional, opaque. Forwarded only to a licensed decision provider through the seam when the host opts in. Never read by the core, never logged, never audited. |

### 4.2 Response

| Field | Meaning |
|---|---|
| `apiVersion`, `correlationId` | |
| `decision` | `{ action, ref?, provider?, model? }`, `action` ∈ `route` (use `ref`), `passthrough` (keep the host's choice), `block` (refuse; M5 and fail-closed audit). |
| `reason` | Existing `selectionReason` vocabulary: `owner_override`, `user_selection`, `request_selection`, `configured`, `cheap_default`, `intelligence`, `pin`, `intelligence_shadow`, `provider_unavailable`, `fallback_unresolved`, `passthrough`, `fallback`; plus `blocked` (new). |
| `rationale` | `{ matchedRule?, details }` — allowlisted keys only (see M2 field allowlists). |
| `policyDigest` | `sha256` of the canonical JSON of the normalized policy that produced the decision. Lets an auditor prove which policy was in force. |
| `costEstimate` | `{ priced, usd, basis, unpricedReason? }`. Dollars only. If the model cannot be priced, `priced:false`, `usd:null` and a reason — never `0`. |
| `engine` | `{ product: "togglelogic-free", version, seamState }` |
| `audit` | `{ recordId }` once M2 is in place. |

### 4.3 Decision order (unchanged from 2.1.4)

1. Governed escalation pre-check (if enabled).
2. Owner override.
3. Protected user selection (`requested.source == "user"`).
4. Request selection (`requested.ref` differs from `defaultRef` and `source` is not `auto`).
5. Early failover if the pending provider is unavailable.
6. Mode dispatch: `passthrough`, `configured`, `cheap`, `intelligence`, `intelligence_unavailable`.
7. Governed escalation post-check.
8. Failover of the selected ref; `fallback_unresolved` if nothing resolves.

The OpenClaw adapter's only job at steps 3–4 is to turn session-store
provenance (C5) and hook context (C4) into `requested`. That is exactly what
2.1.4 computes inline today, so decisions are identical.

## 5. Interfaces

```js
// Core
createDecisionCore({ policy, services }) -> {
  decide(request: DecisionRequest): Promise<DecisionResponse>,
  observeUsage(obs: UsageObservation): Promise<void>,
  health(): { ready, gates[] }
}

services = {
  audit,            // M2 writer (stream-aware)
  routingLog,
  usageEvents,
  pricing,          // existing createPricing
  availability,     // existing provider availability
  seam,             // licensed-layer seam (ABI 1 or 2)
  stateStore,       // StateStore below
  clock,            // () => Date (injected for tests)
  logger,
}

// Adapters
HostAdapter {
  id: "openclaw" | "sidecar" | ...,
  paths: { stateDir },                      // replaces ~/.openclaw defaults
  toDecisionRequest(hostEvent, hostCtx) -> DecisionRequest,
  applyDecision(response, hostCtx) -> hostReturn,
  toUsageObservation(hostEvent, hostCtx) -> UsageObservation | null,
  readiness() -> gates[]                    // e.g. conversation access
}

UsageObservation {
  correlationId?, ref, tenant?, usage: { inputTokens, outputTokens,
  cacheReadTokens?, cacheWriteTokens? }, refusal?: { provider, kind }
}

StateStore {        // owner-override state, chain head (M2), budgets
  read(key) -> object | null,
  write(key, object) -> void  // atomic rename
}
```

### Seam ABI 2

- Free 2.2.0 advertises `INTELLIGENCE_SEAM_ABI = [1, 2]`. The detector loads a
  licensed layer whose manifest says `seam_abi: 1` or `2`.
- ABI 2 call: `decide({ request, catalog })` where `request` is the
  `DecisionRequest` (with `content` only when the host opted in) and `catalog`
  is the adapter's candidate list with surfaces and locality. Return value is
  the same recommendation shape as today.
- ABI 1 call: unchanged (`classify(prompt, runtimeConfig)`), with
  `runtimeConfig` built from the request by the adapter, so old licensed
  releases keep working.

## 6. Adapters

### 6.1 OpenClaw (in process)

Same plugin id, config schema and hooks as 2.1.4. Handles dedupe and preflight
caching (C7), conversation-access readiness (C10), session-store provenance
(C5), and the override return shape (C9).

### 6.2 Decision sidecar

`togglelogic-decide serve --config <file> [--listen 127.0.0.1:7781]`.
Endpoints: `POST /v1/decide`, `POST /v1/usage`, `GET /v1/health`, `POST
/v1/ext-authz/*` (Envoy). `node:http` only; no new dependencies. Loopback bind
by default; a non-loopback bind requires `--allow-remote` and logs a warning.
Request bodies are size-capped. A sidecar that cannot write audit answers
according to `audit.failurePolicy` (M2).

`togglelogic-decide replay --log <routing.log> --config <file>` re-runs recorded
decisions and prints differences (used for the no-behavior-change proof).

### 6.3 LiteLLM

A Python `CustomLogger` (`adapters/litellm/togglelogic_hook.py`):
`async_pre_call_hook` posts a `DecisionRequest` built from the request
metadata (`tenant` from the key/team metadata, `work.label` from a
`togglelogic_label` metadata field, `candidates` from the proxy model list) and
sets `data["model"]` when the action is `route`; raises an HTTP 403 when
`block`. `async_log_success_event` posts a `UsageObservation`. Standard
library only. The hook fails open to the requested model on a sidecar timeout,
except when the policy is fail-closed, and records the timeout.

### 6.4 Envoy `ext_authz` (HTTP mode)

Why Envoy over Kong: `ext_authz` is a stable, documented protocol that Envoy,
Istio and several Envoy-based AI gateways share; it needs no plugin runtime
inside the gateway and maps directly to allow/deny. Kong would need a
Kong-specific plugin (Lua or a plugin-server language) and covers only Kong.
Kong can be served later from the same sidecar.

Mapping: Envoy sends request headers (and, if configured, the body) to the
sidecar. The sidecar answers `200` with `x-togglelogic-model`,
`x-togglelogic-decision`, `x-togglelogic-correlation-id` headers for `route`
/`passthrough`, or `403` with a JSON reason for `block`. Route selection uses
the model header. Usage is reported from the gateway's access log or a small
`ext_proc`/Lua filter in the example config (documented, optional).

Spike before implementation: confirm which Envoy-based AI gateways can select
the upstream model from a header without a body rewrite, and whether a body
rewrite filter is needed in the example config.

## 7. Migration steps (each step keeps all tests green)

1. Add the license-header test; fix the nine files (ships in 2.1.5).
2. Introduce `StateStore`, `paths` and `clock` injection; no behavior change.
3. Extract `decide()` from `interceptor.js` into `src/core/decide.js`; the
   interceptor becomes `toDecisionRequest` → `decide` → `applyDecision`.
4. Move C1–C13 into `src/adapters/openclaw/`; `src/index.js` re-exports.
5. Add the decision matrix, replay command and its test.
6. Add the sidecar, then the LiteLLM and Envoy kits and their CI jobs.
7. Seam ABI 2 alongside ABI 1.
8. Mark `bounded-executor.js` deprecated and remove it from `files`; make the
   notification interpreter configurable (`ownerOverride.askInterpreter`,
   default `python3` resolved from `PATH`).

## 8. Test and proof plan

- Unit tests per module; existing 192 tests unchanged.
- `tests/decision-matrix.test.js`: fixtures in `tests/fixtures/decision-matrix/`
  (policy + request + expected response). Runs through core, OpenClaw adapter
  (simulated `api`), sidecar (HTTP on an ephemeral port), LiteLLM hook (Python
  subprocess against the sidecar, skipped with a visible notice if Python is
  absent), Envoy handler (HTTP). Writes `decision-matrix.report.json`.
- Rows cover every `reason` in §4.2, unpriced models, unavailable providers,
  fallback-unresolved, intelligence shadow, and `content` never appearing in
  any log or audit output.
- Replay test with a recorded 2.1.4 routing log fixture.
- CI jobs: Node 24 and 26 on Linux, macOS, Windows; optional containerized
  LiteLLM and Envoy end-to-end jobs.

## 9. Canary-host acceptance

Install 2.2.0 through the release path. Evidence bundle: routing log and audit
for a turn on each selection path in use, the replay report over recent routing
history (zero differences), the matrix report from the release commit, and the
`plugin.register` audit showing the adapter id and gates.

## 10. Risks

- Ordering regression in the extraction — mitigated by replay and matrix.
- Sidecar becomes a new attack surface — loopback default, size caps, no
  `content` logging, explicit flag for remote binds.
- Two code paths for seam ABI 1 and 2 until the licensed layer moves — keep ABI
  1 for at least one minor cycle after the licensed release that supports ABI 2.
- Python and Envoy kits add maintenance outside Node — kept small, standard
  library only, and exercised in CI.
