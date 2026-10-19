# ToggleLogic Free — Engineering Roadmap

Status: **approved by the owner** (2026-10-13). Milestone 2 part 1 shipped in
Free 2.1.5; the rest is planned. Version numbers below are **ToggleLogic Free**
versions unless stated otherwise. Baseline: **Free 2.1.5** (`v2.1.5`, `8e2070c`, released 2026-10-13).

ToggleLogic is the **policy decision-and-evidence block** that sits beside the
AI gateway a company already runs. It decides which model may handle which
work under which policy, records an audit-grade account of each decision, and
reports cost in dollars per department or client. It is not a gateway.

This file covers the Free side only. Work that belongs to the separately
licensed product is planned privately and is referenced here only by its
interface with Free.

Detailed designs:

- [M1 — Host adapters and the decision API](design/M1-HOST-ADAPTERS-AND-DECISION-API.md)
- [M2 — Tamper-evident audit log](design/M2-AUDIT-LOG.md)

## Terminology — three kinds of "number"

| Term | Meaning | Rule |
|---|---|---|
| **Release version** | The semver of a ToggleLogic product release, e.g. ToggleLogic Free 2.2.0 or ToggleLogic Intelligence 2.1.0. | Required on every release, tag, CHANGELOG entry and plan. Always name the product. |
| **Model family / lineage** | The durable routing target, e.g. a provider-qualified lineage. A concrete model release is only the current execution child of a lineage. | Routing, docs and policy name families. Never a permanent pin to a numbered model release. |
| **Patent application numbers and filing dates** | Identifiers of the provisional filings. | Never in this repository or any public material. Public wording: "nine provisional patents pending". |

## Ground rules (apply to every milestone)

- Every change ships as a semver release with tests, a CHANGELOG entry and a
  `vX.Y.Z` tag, proven on the canary host before any fleet rollout. No
  hot-patches. Hosts stay pinned to a proven tag.
- Routing targets model **lineages/families**, never version pins.
- Cost governance stays in Free: loud failure, unpriced usage visible, dollars
  not tokens.
- Free never inspects prompt text. It routes on owner overrides, host-supplied
  structured labels, deployment-declared defaults, or the licensed seam.
- A milestone is not done without artifacts: test output, logs, and canary-host
  records.

## Release plan at a glance

| Free version | Milestone | Content | Compatibility |
|---|---|---|---|
| **2.1.5** (released) | M2 (part 1) | Loud audit-write failures. CI matrix on supported Node versions plus Linux/macOS/Windows jobs. | Patch. No config or format change. |
| **2.2.0** | M1 (part 1) | Host-neutral decision core; versioned Decision API v1 (schema published here); OpenClaw adapter with no behavior change; decision matrix and replay command. Known-defect fixes (interpreter path, unwired executor, missing headers, audit outcome of unchanged-model decisions). | Minor. OpenClaw routing unchanged; the audit outcome of unchanged-model decisions is corrected. |
| **2.3.0** | M1 (part 2) | Decision sidecar (HTTP); LiteLLM adapter; Envoy `ext_authz` adapter; seam ABI 2 (ABI 1 still accepted); optional per-request tenant attribution in cost rows (billing classification from owner config). | Minor. New surfaces are additive. |
| **2.4.0** | M2 (part 2) | Audit schema v2: hash chain, verification command, time-based retention (default ≥ 183 days), sealed segments, export (JSON/CSV/SIEM JSONL) with field allowlists, write-time `subject`/`details` allowlists, optional fail-closed audit policy. | Minor if the owner rules the on-disk rotation layout is not a public contract; otherwise **3.0.0** (see M2 risk R1). |
| **2.5.0** | M5 (Free part) | Trusted data-class labels end to end; local-only enforcement on every selection path; data-boundary document. | Minor. Enforcement applies only when a host supplies a data-class label. |

M3 (enterprise identity) and M4 (hosted service, design only) are licensed and
planned privately. They consume the M1 API and the M2 log format defined here.

**Compatibility constraint.** The licensed layer currently in the field accepts
Free versions `>=2.0.0 <3.0.0`. Any Free 3.0.0 must wait for a licensed-layer
release that widens that interval, or the licensed layer will be reported
absent on every host that upgrades. The plan above therefore avoids a Free
major bump unless the owner rules otherwise.

---

## M1. Host-adapter layer and gateway-neutral decision API

**Goal.** The decision engine runs without OpenClaw. OpenClaw becomes one
adapter among several.

### Scope (Free)

- Split `src/` into a host-neutral **core** (`src/core/`) and **adapters**
  (`src/adapters/<host>/`). The core never imports a host SDK, never reads host
  config files, never assumes `~/.openclaw`.
- **Decision API v1** (`togglelogic.decision/v1`): request = work label, tenant,
  candidates, requested selection and its provenance, policy context, host
  signals; response = decision, reason, rationale, policy digest, dollar cost
  estimate, correlation id. JSON Schemas published in `schema/decision-api/v1/`.
- **OpenClaw adapter**: everything that is OpenClaw-specific today
  (`definePluginEntry`, `api.on` hooks, `api.config` shape, state paths,
  session-store reader, duplicate-hook dedupe, preflight cache) moves here.
  Decisions are identical to 2.1.4.
- **Decision sidecar** (`bin/togglelogic-decide`): a zero-dependency local HTTP
  server exposing `POST /v1/decide`, `POST /v1/usage`, `GET /v1/health`. All
  non-OpenClaw adapters use it.
- **LiteLLM adapter**: a small Python `CustomLogger` hook that calls the sidecar
  before each call (rewrites `model`) and after each call (reports usage).
- **Envoy `ext_authz` adapter** (HTTP mode): the sidecar answers Envoy's
  authorization check, sets the routing headers, and denies when policy says
  block. Chosen over a Kong plugin because one standard protocol covers Envoy,
  Istio and Envoy-based AI gateways without a per-gateway plugin runtime; Kong
  remains reachable later through the same sidecar.
- **Seam ABI 2**: the licensed layer receives the Decision API request (plus
  catalog context) instead of an OpenClaw-shaped runtime config. ABI 1 is still
  accepted so current licensed releases keep working.

### Proposed versions

Two releases (owner ruling 2026-10-19, to ship the core sooner):
- Free 2.2.0 — core split, Decision API v1, OpenClaw adapter, decision matrix
  and replay (design §7 steps 1–5 and 8), proven on the canary host as
  2.2.0-rc.N first.
- Free 2.3.0 — decision sidecar, LiteLLM and Envoy adapters, seam ABI 2
  (design §7 steps 6–7).

### Interfaces and schemas

See the M1 design: `DecisionRequest`, `DecisionResponse`, `HostAdapter`,
`UsageObservation`, `StateStore`, `CatalogSource`; sidecar endpoints; seam ABI 2.

### Test and proof plan

- **Recorded decision matrix**: one set of policy + request fixtures run through
  (a) the core directly, (b) the OpenClaw adapter with simulated host events,
  (c) the sidecar over HTTP, (d) the LiteLLM hook against the sidecar, (e) the
  Envoy `ext_authz` handler. CI fails if any row differs across adapters. The
  matrix report is a release artifact.
- **No-behavior-change proof for OpenClaw**: every existing test passes
  unchanged against the adapter; a replay test runs recorded 2.1.4 decisions
  through 2.2.0 and requires identical `selectionReason`/`selectedModel`.
- **Optional live gateway jobs** (CI, containerized): LiteLLM proxy and Envoy
  with the adapter, one routed request each.

### Canary-host acceptance evidence

- Install 2.2.0 through the normal release path; at least one routed turn per
  selection path in use (configured, user selection, owner override, failover).
- Routing log and audit records before and after, with identical decisions.
- `togglelogic-decide replay` output over the canary host's recent routing log:
  zero differences.

### Risks

- Refactor regressions in the subtle OpenClaw ordering (owner override → user
  pin → request selection → failover → mode). Mitigated by the replay test.
- Envoy header-based routing vs. body `model` rewrite: confirm in a spike which
  Envoy-based AI gateways route on a header without a body rewrite.
- Sidecar exposure: binds to loopback by default; any non-loopback bind requires
  explicit config and is logged as a warning.

---

## M2. Tamper-evident audit log

### Scope (Free)

1. **Loud audit-write failures (2.1.5, first).** Today the audit writer warns
   once and silently suppresses later failures. After 2.1.5 every failure is
   counted and reported: an error-level log, a not-ready `audit` capability
   gate, an `audit_write_failed` event on the usage-events stream (an
   independent sink), and an `audit.write.recovered` record in the audit stream
   itself when writes resume, carrying the failure count and window. Same
   pattern as 2.1.2.
2. **Hash chain + verification (2.4.0).** Each record carries a sequence number
   and the hash of its predecessor. `togglelogic-audit verify` detects edits,
   deletions, reorders and truncation (truncation against a recorded head or an
   external anchor).
3. **Time-based retention (2.4.0).** Configurable; default 183 days (at least
   six months). Rotation seals segments and never deletes a record inside the
   retention window, even under size pressure; pressure is reported loudly.
4. **Export (2.4.0).** `togglelogic-audit export` to JSON, CSV and a SIEM-friendly
   JSONL stream, with field-allowlist profiles. `subject` and `details` are
   filtered by per-event allowlists at write time.
5. **Optional fail-closed policy (2.4.0).** `audit.failurePolicy: "block"` makes
   routing return a block decision while the audit log cannot be written.
   Default stays `"continue"`.

**Placement (owner to confirm at design review).** Recommended: loud failure,
retention, export, and the hash-chain format and verifier in Free; managed
signing keys, signed checkpoints and hosted verification licensed.

### Proposed versions

Free 2.1.5 (loud failures + CI), Free 2.4.0 (everything else).

### Test and proof plan

- Tamper tests: edit a field, delete a record, swap two records, truncate the
  tail, delete a whole sealed segment — each must fail `verify` with a precise
  error. An untouched log must pass.
- Induced write failure (read-only directory, full disk simulation): every
  failure counted, error logged, gate not ready, recovery record written.
- Retention tests with an injected clock: nothing inside the window is deleted
  under any size setting; expired segments are pruned and the prune is itself
  audited.
- Export tests: allowlist profiles drop non-listed fields; CSV and JSONL
  fixtures are byte-stable.

### Canary-host acceptance evidence

- 2.1.5: an induced failure on the canary host (audit path pointed at a
  read-only directory in a scratch profile) showing the error log, gate and
  events; then restoration and the recovery record.
- 2.4.0: `togglelogic-audit verify` passing on the live canary log after
  several days; one rotation and one prune observed; an export file handed to
  the owner.

### Risks

- **R1** Changing the rotated-file layout may break external tailers. Keep the
  active file at the configured path; sealed segments move to a sibling
  directory. If the owner treats the old `.1`–`.5` layout as a contract, this is
  Free 3.0.0 and depends on the licensed-layer compatibility release.
- **R2** More than one writer per gateway (plugins loaded in several contexts)
  would fork a single chain. Design uses one chain per writer stream; a spike
  confirms the host's behavior first.
- **R3** An unsigned hash chain proves integrity only against an anchor kept
  out of the attacker's reach. The design says so plainly; signed checkpoints
  are the licensed answer.
- Retention increases disk use; size pressure is loud, never silent deletion.

---

## M5. Confidential-data handling (Free part)

### Scope (Free)

- **Trusted data-class labels.** A host-supplied label (`local_only`,
  `local_preferred`, `cloud_allowed`) enters through the adapter's structured
  context only. Prompt content can never set or lower it. The label is carried
  through the decision, every fallback, and the audit record.
- **Local-only enforcement on every path**: configured routes, the declared
  default, fallback lineages, provider-refusal reroutes, owner overrides,
  user/session selections (`request_selection`, `user_selection`), and
  recommendations from the licensed seam. A local-only label meeting a
  non-local candidate produces a **block** decision and an audit record — never
  passthrough. Today a route miss can pass through or fall to the default.
- "Local" means the provider endpoint is on the deployment's own hardware or
  network as declared by the operator, not that the execution runtime is local.
- **Data-boundary document**: what ToggleLogic guarantees (selection, audit) and
  what the host must still enforce (tool calls, logs, network egress).

### Proposed versions

Free 2.5.0.

### Test and proof plan

A matrix that attempts every override and fallback path against a local-only
label; all are blocked and audited. A downgrade attempt through prompt content
or an unstructured field has no effect.

### Canary-host acceptance evidence

A labeled turn on the canary host routed to a local model, and a forced
non-local attempt blocked, with both audit records.

### Risks

- Block decisions surface to end users as refusals; the host must render them
  clearly. Hosts that cannot pass labels get no enforcement — documented, and
  visible in the capability gates.

---

## Known defects folded into the plan

| Defect | Release |
|---|---|
| Audit writer suppresses failures after the first | Fixed in 2.1.5 |
| CI declares Node 22; the supported host needs Node `>=24.16 <25 \|\| >=26.1`; Linux/Windows never run end to end | Fixed in 2.1.5: CI on Node 24/26, Linux and macOS required, real OpenClaw host packages. |
| Windows: first CI run (2.1.5) fails 8 of 200 tests (path, file-lock and line-ending assumptions) | 2.2.0; Windows becomes a required job once green |
| Owner-override notification helper hardcodes `/usr/bin/python3` | 2.2.0 (configurable interpreter; default resolved from `PATH`) |
| `src/enforcement/bounded-executor.js` is exported but not wired in | 2.2.0 (marked deprecated, excluded from the package); removed at the next major |
| Nine source files lacked the published license header | Fixed in 2.1.5, with a test that fails on a missing header |
