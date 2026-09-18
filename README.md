# ToggleLogic Free — policy-based model routing for OpenClaw

> **PATENT PENDING.** Source-available under the **ToggleLogic Free Startup
> Commercial Use License 2.0** (see [LICENSE](./LICENSE)). It is not open source.
> © 2026 Motherboard, Inc. · https://togglelogic.ai/

## Routing you configure. Overrides that stick. A record of both.

ToggleLogic Free is the source-available routing layer for OpenClaw. It applies
your configured model choices, keeps an owner's explicit choice in force until
it is changed, and writes what happened to local records you can inspect.

It does not read prompts to guess intent. Your policy and provider credentials
remain under your control. Its routing audit and cost ledger stay on your machine
and are not transmitted to Motherboard. Model traffic still goes to the providers
you configure in OpenClaw.

## What it does

- **Configured routes.** Point a host-supplied task label at an exact model.
  Routing is deterministic and entirely under your control.
- **Deployment-declared cheapest default.** Name the inexpensive model you want
  used when nothing higher-priority applies. ToggleLogic Free does not classify
  the request or calculate the cheapest capable model.
- **Owner overrides that persist.** Set a model in the moment and it stays set
  until you change it. No silent re-routing on the next turn.
- **A local audit record.** See which task, which model, and on what basis in a
  structured routing log. ToggleLogic does not transmit that record to Motherboard.
- **Local cost visibility.** Estimate cost per model from public pricing data,
  computed on your machine. Unpriced models remain visibly unpriced, never a
  false `$0.00`.
- **Optional model-family aliases.** Name a family for a configured route and
  resolve it only within providers you have approved. Resolution safely passes
  through when freshness, provider, or price requirements are not satisfied.
- **Skill-aware routing (1.7.1).** A guaranteed pre-execution gate
  (`before_agent_reply`, host-enforced user turns only) resolves the skills a
  message references DETERMINISTICALLY from the deployment's installed-skill
  catalog, then — for an in-scope owner turn — presents distinct Economy,
  Recommended, and Premium lineages with skill-specific strengths, trade-offs,
  workflow cost ranges, and a reasoned Intelligence recommendation BEFORE any
  model runs. If only one lineage is eligible, it is shown once rather than
  repeated under multiple policy labels. The learned
  strategy or model lineage is reused deterministically and executed in a bounded
  child. Active routing/education is scoped to configured trusted identities
  (e.g. one owner channel); every out-of-scope turn stays passthrough. Numbered
  model children remain execution-time resolutions, not durable pins.

## What it does not do

No prompt inspection or intent inference. No benchmark-driven selection. No
Toggle Registry, private classifiers, proprietary benchmark data, or bundled
provider credentials.

Those belong to **ToggleLogic Intelligence**, a separately licensed source-available package.
Its public engine can be inspected and contributed to; eligible startups register before commercial production use. The maintained production registry, benchmark intelligence, private evidence, signed packs, and services remain separately delivered. Free is the mechanism. Intelligence is the judgment.

## OpenClaw compatibility

> **Requires OpenClaw 2026.9.4 or later; validated on OpenClaw 2026.9.4.**

The minimum gateway version is `>=2026.9.4`; the plugin API floor remains
`>=2026.5.2`. The newer gateway floor reflects the owner-scoped pre-execution
and bounded-child integration used by skill routing. OpenClaw versions newer
than the stated validation point should be verified before production
promotion.

## Governed model escalation

The opt-in `features.governedEscalation` capability keeps configured general
work on a local model and places configured high-capability Intelligence tiers
behind an owner decision. Before an external model receives the task, the gate
shows the proposed model, estimated AI cost, and what crosses the external-data
boundary. The deployment supplies its accepted approval/denial phrases, data
boundary wording, and optional provider/model display names. ToggleLogic applies
those normalized decisions, repeats the decision in a plain yes/no confirmation,
and only that final confirmation authorizes one execution. The result includes a
concise receipt naming the model, location, token usage, and cost. Exact provider
references, pricing sources, and approval evidence remain in machine-readable
audit data. Pending decisions are stored locally with owner-only permissions and
expire on the configured TTL. ToggleLogic's defaults are intentionally strict and
deployment-neutral: exact `Yes` / `No`, generic context wording, and raw model
references.
Approved execution is bound to its confirmation turn; interruption cannot carry
that approval onto a later unrelated message.
When governed escalation is enabled, `governedEscalation.localModel` is required
and must be a `provider/model` reference so unapproved work always has a declared
local quarantine target.

On OpenClaw 2026.9.4, the receipt uses the host's delivery-time runtime evidence.
ToggleLogic suppresses a fallback banner only when that evidence explicitly says
no fallback occurred and the model difference came from policy routing; real or
uncertain fallback notices remain visible.

Governed escalation is opt-in and disabled by default. ToggleLogic Free 1.5.0
was promoted after private canary validation; installing the release does not
activate routing, external escalation, or conversation access by itself.

See [Who Guarantees What](./docs/INTEGRATION-RESPONSIBILITY-CONTRACT.md) for the
host/router/deployment responsibility contract, business examples, failure modes,
conformance tests, and the rule that a router cannot manufacture a capability or
execution receipt.

See [Model-Family Routing](./docs/MODEL-FAMILY-ROUTING-ARCHITECTURE.md) for the
portable lineage → resolver → concrete-child architecture. It explains why a
durable policy should not be pinned to a numbered model release and why every
verification receipt should record both the selected family and executed child.

## Install (from ClawHub)

```
openclaw plugins install clawhub:togglelogic
```

Enable routing (opt-in) in `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "togglelogic": {
        "enabled": true,
        "hooks": { "allowConversationAccess": true },
        "config": {
          "mode": "cheap",
          "cheapHeuristic": { "default": "anthropic/claude-haiku-4-5" },
          "features": { "routing": { "enabled": true } }
        }
      }
    }
  }
}
```

Bring your own provider credentials. Set your routing policy. The evidence stays
local.

### Skill-aware routing (1.7.1)

This capability is opt-in and requires a compatible ToggleLogic Intelligence
1.7 marketplace planner.

**How it intercepts.** The 1.6.0 design gated on structured planned-skill
metadata that the OpenClaw host never supplies on the routing hooks, so it could
not intercept a skill invocation (see the 2026-09-15 postmortem). The 1.6.1-rc
line replaces that with a real boundary:

- A **guaranteed pre-execution gate** on `before_agent_reply` (registered with
  host-enforced `eligibleTriggers: ["user"]`). Returning `handled:true` plus a
  reply short-circuits the turn **before any model is resolved or called** — it
  does not rely on the model choosing to call a tool.
- A **deterministic skill resolver** over the **live installed-skill inventory**:
  membership comes from the host's own `skill_manifest.json` (enabled skills),
  fingerprinted/versioned with startup drift detection — not a hand-maintained
  catalog and not a temporary plugin cache. Only an exact installed skill id or a
  declared alias (word-boundary match) resolves a skill. `skillRouting.skillCatalog`
  now only supplements aliases; a configured id that is not installed is reported
  and never resolves.
- **Universal fail-closed rule** (owner-directed): on a governed turn, EVERY
  actionable request must resolve to an active installed skill or receive the
  verbatim fail-safe *“I don't have a skill that relates to what you're asking me
  to do.”* — never a silent fall-through to a general model. A specifically named
  unavailable skill returns the same fail-safe. Non-action conversation/control
  messages bypass the gate ONLY via explicit `skillRouting.nonActionCategories`
  (default empty). Ambiguity among installed skills asks one bounded clarification
  and executes nothing (`clarifyOnMultiSkill`).
- **Resolution after exact match returns none** runs two owner-configured stages,
  in order, both fail-closed: (1) **deterministic intent recipes**
  (`skillRouting.intentRecipes`, default empty) — declarative normalized-token rules
  (`{ id, allTerms, anyTerms, skillIds }`, no code/regex) that compose a request to
  one-or-more INSTALLED skills, resolving only when every target skill is in the
  fresh verified inventory (conflicting rules fail closed); then (2) the **bounded
  local classifier** (`skillRouting.classifier`, off unless a model is pinned) given
  the verified catalog as **id + bounded description** (not opaque ids) with a
  configurable, hard-bounded `numCtx` (default 8192), schema-validated,
  confidence-thresholded, eligible-id-checked, and prohibited from performing the
  task. Snapshot descriptions are sanitized, size-bounded, and bound into the
  inventory fingerprint (tamper fails closed). See
  `docs/RESOLVER-HARDENING-1.6.1-rc.2.md`.
- **Canary scope**: active routing/education runs only for turns whose trusted
  hook identity (channel / accountId / senderId / chatId / sessionKey) matches
  `skillRouting.scope`. Out-of-scope turns (other channels/senders, cron,
  heartbeat, CLI, inter-session) stay shadow/passthrough and are never
  represented as governed. An unconstrained scope is inert unless `allowGlobal`
  is set.
- **Bounded child execution**: a resolved route (including the owner's token
  reply) executes in a fresh child session with `promptMode: "minimal"` +
  `lightContext: true` so routed work never re-runs inline against the fat main
  session. `maxChildTokens` / `maxChildCostUsd` are a PRE-FLIGHT estimate guard
  (a plan estimated above them is refused). Note: openclaw 2026.9.4
  `SubagentRunParams` exposes no **in-flight per-call** model-pass/token/cost
  abort, so a single routed child's live token spend cannot be hard-capped from
  the plugin — see the remediation report for the minimal host change this
  requires. This is separate from the monthly cloud-budget ceiling below.
- **Live monthly cloud-spend ceiling** (`skillRouting.spend`, 1.6.1-rc.4): the
  plugin consumes a DEPLOYMENT-OWNED, versioned + fingerprinted, current-policy-
  month cloud-spend snapshot — written at refresh time by
  `scripts/generate-spend-snapshot.mjs` from `openclaw gateway usage-cost
  --all-agents --expect-final --json` — as the AUTHORITATIVE month-to-date cloud
  spend for routing. No caller hand-enters a number. It re-verifies source /
  plugin pair / policy month / freshness / fingerprint and **fails closed on any
  unpriced CLOUD row** (unpriced LOCAL/Ollama rows are expected $0). When spend
  meets the finite amortized cloud budget, Intelligence withholds cloud routes
  and local-capable routes remain; when the snapshot is missing/stale/invalid and
  a finite cloud budget is declared (`spend.finiteCloudBudgetApplies`), cloud is
  withheld the same way. The universal no-skill fail-safe runs BEFORE any of this.
  See `docs/ECONOMIC-PROFILE.md`.
- **Fail-closed on error**: an internal gate error on a governed turn (or a token
  reply) returns a handled error and holds the turn; it never falls through to
  inline routing.
- A **fail-loud startup self-check**: if the host cannot provide the affordances
  the gate needs, or the canary scope is unconfigured, active gating is refused
  (forced shadow) with a loud audit line instead of shipping a dead preflight.

`togglelogic_skill_run` and `togglelogic_skill_plan` remain as optional explicit
surfaces for the same bounded execution. The execution path runs only in an
OpenClaw gateway request context, keeps the child model's skill tools available,
blocks nested ToggleLogic child dispatch structurally, fails loudly on child
timeout/error, and records the actual child provider/model. Host-configured model
refs are passed to Intelligence as authoritative accepted routing candidates.

Time-sensitive skills carry a permanent execution contract. `meeting-prep`:
checks the current time first, treats Microsoft Outlook via Microsoft Graph as
the only authoritative calendar, clarifies (never fabricates) a past/nonexistent
meeting, uses Zoom history only after confirming an Outlook event, and never
synthesizes an event from conversation history. When `skillRouting.calendar` is
enabled the contract calls a deterministic Microsoft Graph `/me/calendarView`
grounding port that returns a UNIQUE future event only; zero/multiple/ambiguous/
auth/timeout/unwired all fail CLOSED (clarify). The transport is an explicitly
configured **subprocess bridge** (`skillRouting.calendar.bridge.command` → the
vault-backed `microsoft-graph/scripts/calendar_bridge.py`), launched with an
explicit argv array (no shell; injection-safe), a wall-clock timeout, and strict
JSON validation. The plugin holds no Graph credentials; no model instruction
substitutes for the call. See `docs/CAPABILITY-CONSENT.md`.

Note: `meeting-prep` is **not currently an installed active skill** on SAM-HQ (it
existed only in a temporary plugin cache). Under the fail-closed rule the exact
2026-09-15 incident prompt therefore returns the no-skill fail-safe until a
durable, reviewed `meeting-prep` skill is actually installed; the contract and
grounding port above apply once it is.

```json
{
  "plugins": { "entries": { "togglelogic": {
    "enabled": true,
    "hooks": { "allowConversationAccess": true },
    "config": {
      "mode": "intelligence",
      "features": {
        "routing": { "enabled": true },
        "skillRouting": { "enabled": true }
      },
      "intelligence": {
        "enabled": true,
        "skillProfilesPath": "/absolute/path/to/skill-routing-profiles.json"
      },
      "skillRouting": {
        "useSnapshotInventory": true,
        "inventorySnapshotPath": "~/.openclaw/togglelogic/skill-inventory.snapshot.json",
        "inventoryMarkerPath": "~/.openclaw/togglelogic/skill-inventory-accepted.json",
        "skillCatalog": [
          { "id": "microsoft-graph", "aliases": ["outlook", "graph"] }
        ],
        "nonActionCategories": [
          { "id": "greeting", "phrases": ["hi", "hello", "thanks"] },
          { "id": "control", "patterns": ["^\\s*/(stop|status|help)\\b"] }
        ],
        "calendar": {
          "enabled": true,
          "timeoutMs": 8000,
          "bridge": {
            "command": "python3",
            "args": ["~/.openclaw/workspace/skills/microsoft-graph/scripts/calendar_bridge.py"],
            "maxResults": 25
          }
        },
        "maxChildTokens": 200000,
        "maxChildCostUsd": 5,
        "maxChildToolCalls": 32,
        "skillRequirements": {
          "default": { "requiredTier": "tool_calling_strong", "requiresTools": true },
          "skills": {
            "microsoft-graph": { "requiredTier": "tool_calling_strong", "requiresTools": true },
            "zoom-meetings": { "requiredTier": "tool_calling_strong", "requiresTools": true },
            "powerpoint-editor": { "requiredTier": "tool_calling_strong", "requiresTools": true }
          }
        },
        "skillTools": {
          "microsoft-graph": { "maxToolCalls": 12 },
          "zoom-meetings": { "maxToolCalls": 8 },
          "powerpoint-editor": { "maxToolCalls": 24 }
        },
        "scope": {
          "enabled": true,
          "channels": ["telegram"],
          "accountIds": ["default"],
          "senderIds": ["<owner-telegram-peer-id>"],
          "ownerSenderIds": ["<owner-telegram-peer-id>"]
        }
      }
    }
  } } }
}
```

`skillRequirements` are DEPLOYMENT-OWNED capability constraints (not learned model
choices), keyed by verified installed skill id: the capability floor a skill needs
to run. A skill with no explicit entry inherits the conservative default
(`tool_calling_strong` + `requiresTools`), so first-use education for a tool-using
skill such as `microsoft-graph` or `zoom-meetings` never offers an unverified
general-purpose-only local model; opt a **proven tool-free** skill down to
`{ "requiredTier": "general_purpose", "requiresTools": false }` to let a local
lowest-cost model win. Invalid values fail closed to the conservative fallback. The
requirements are aggregated (strictest tier/privacy/benchmark, min cost caps) across
a turn's resolved skills and combined in Intelligence with the task classifier and
any learned profile.

The `scope` above binds the canary to the owner's own SAM-HQ Telegram DM — the
`default` account (session-key form
`agent:main:telegram:default:direct:<owner-peer-id>`), the account SAM itself runs
on, NOT the separate Codex Development bot account. Replace
`<owner-telegram-peer-id>` with the owner's own Telegram peer id; no owner id is
hardcoded in this package.

Educational choices are bound to the authenticated owner, session, sender when
available, short-lived plan, and one-time `TL-xxxxxx` token. The displayed
token plus `1`, `2`, or `3` teaches the profile. A local run is reported at its true
**zero marginal per-run cost** (`$0.00` for one more run on already-owned,
already-powered hardware — never collapsed to "unknown" so a paid cloud model can
beat it), while hardware **ownership** is tracked SEPARATELY as an amortized monthly
cost (capital ÷ useful-life + operating) that defines the comparable monthly cloud
budget on the receipt. Installation and production activation remain separate
actions.

## License, in brief

ToggleLogic Free is source-available, not open source. Personal use and internal
business use are free. You may also build, host, and charge for a bona fide product
containing ToggleLogic Free without contacting Motherboard first while your
consolidated startup group remains below both:

- **USD $1,000,000 in cumulative outside funding actually received**; and
- **USD $1,000,000 in actual gross revenue during a trailing 12-month period**.

Announced but unreceived financing, ARR, valuation, projected sales, and pipeline
do not count. Rights in a release lawfully received are not revocable absent a
material breach. Curable breaches receive a 30-day cure under the controlling
license.

Crossing either threshold starts a 30-day notice window and an automatic 180-day
transition license. If no commercial agreement or extension is effective when
that period ends, you must stop accepting new customers, making new deployments,
or materially expanding external commercial use. Existing customers may continue
running lawfully delivered copies, and you may provide defined security,
compatibility, defect-correction, and migration updates to previously deployed or
contractually committed customers for another 12 months.

This permission covers **ToggleLogic Free only**. It grants no access or rights to
ToggleLogic Intelligence, the Toggle Registry, proprietary benchmark selection,
private evidence, or other excluded components. Early contact is optional; contact
Motherboard whenever an Intelligence evaluation, architecture discussion, support,
or partnership would help: https://togglelogic.ai/contact/.

Read [LICENSE](./LICENSE) for the controlling terms or see the plain-language
summary at https://togglelogic.ai/licensing/.

## Modes

| Mode | Behavior |
|---|---|
| `auto` | Compatible Intelligence layer if present → else the cheap default if configured → else passthrough |
| `passthrough` | Defer every selection to OpenClaw's default (log only) |
| `configured` | Apply `configuredRoutes` from a host-supplied task label, then optional `default` |
| `cheap` | Apply the deployment-declared cheapest default (dumb, static) |
| `intelligence` | Defer to the separately licensed Intelligence package (not included in Free); report unavailable rather than silently downgrading |

Owner overrides apply **above** the mode in all cases.

### Optional configured-route family aliases

Family resolution is explicit and off by default. A route must use the
`family:<alias>` form, and the alias must name allowed providers. Those
providers must also exist in OpenClaw's `models.providers` configuration.

```json
{
  "mode": "configured",
  "configuredRoutes": { "research": "family:grok" },
  "familyResolution": {
    "enabled": true,
    "maxAgeHours": 48,
    "aliases": {
      "grok": {
        "family": "grok",
        "providers": ["xai"],
        "strategy": "lowest_cost",
        "maxInputPerM": 5,
        "maxOutputPerM": 20
      }
    }
  }
}
```

`newest` is also available, but still obeys provider, freshness, complete-price,
and optional price-ceiling gates. Failure produces passthrough, never a bare
family name.

### Ordered fallback families

Version 1.5.1 extends the durable-family rule to the host's ordered model chain.
A deployment may add `acceptedModels` to each alias and declare
`familyResolution.hostPlan` with one primary alias plus ordered fallback
aliases. ToggleLogic resolves the complete plan and audits whether it matches
OpenClaw's concrete `agents.defaults.model` chain. It never writes that host
configuration or silently promotes a merely discovered child.

See [Model-family fallback architecture](./docs/MODEL-FAMILY-FALLBACK-ARCHITECTURE.md)
for the diagram, configuration example, and responsibility boundary. This
architecture may be protected by our patent pending.

**Optional expiry.** An override may include `expires_at_ms` (a numeric epoch-ms deadline).
After it passes, the override stops applying and routing returns to automatic — no file rewrite
needed. Writers SHOULD set `expires_at_ms` so a forgotten override cannot hold forever; omit it
only for a deliberately indefinite override. A present-but-non-numeric `expires_at_ms` is
rejected (fail-closed) and logged to the audit stream.

## Cost visibility (dollars)

Opt-in `features.costVisibility` observes each model call (the `llm_output` hook,
**observe-only**) and reports **per-model and per-day dollar cost** to its own log
(`~/.openclaw/logs/togglelogic-cost.jsonl`). Prices are **dynamic and public** — fetched
live from [Models.dev](https://models.dev) (MIT), cached locally and refreshed daily
(never per call, and **never from any ToggleLogic/Motherboard endpoint**), with a
**bundled LiteLLM snapshot** (MIT) as an offline fallback. It is **curated** to the major
providers' standard lineups (Anthropic, OpenAI, Google, xAI, Meta); anything else is
reported **loudly as unpriced** — model + token count — and never as a false $0.00. It
**never blocks, halts, or downgrades** a call. Enforcement and all-model /
guaranteed-current pricing are the paid tier.

### Fleet attribution

Version 1.1 adds privacy-safe, local fleet attribution to every cost-log call and
summary. Configure a stable deployment slug and an optional cost-center slug; the
plugin writes them to the local JSONL ledger using schema
`togglelogic.fleet-usage.v1`. It does not transmit usage, identifiers, prompts, or
customer information to Motherboard or any ToggleLogic service. If `deploymentId`
is omitted, the local hostname is used.

Dollar values in this ledger are explicitly marked `public-rate-estimate` and
`invoiceEligible: false`. A fleet operator must reconcile deployment totals
against authoritative provider billing before creating an invoice.

Enable it (also requires `hooks.allowConversationAccess`, since `llm_output` is a
conversation hook):

```json
{
  "plugins": { "entries": { "togglelogic": {
    "enabled": true,
    "hooks": { "allowConversationAccess": true },
    "config": {
      "features": { "costVisibility": { "enabled": true } },
      "costVisibility": {
        "attribution": {
          "deploymentId": "acme-assistant",
          "costCenter": "customer-success"
        }
      }
    }
  } } }
}
```

## Config reference

See `openclaw.plugin.json` `configSchema` for every field: `mode`, `logging`,
`configuredRoutes`, `cheapHeuristic`, `familyResolution`, `intelligence`, `ownerOverride`, `features`,
`audit`, `costVisibility`.

## License

Use of this Software is governed by the **ToggleLogic Free Startup Commercial Use
License 2.0** ([LICENSE](./LICENSE)). It permits personal and internal use and
defined commercial use by qualifying startups. Rights in a lawfully received
release are stable and may be terminated only under the license's breach-and-cure
terms. It is **not** an open-source license. See [NOTICE.md](./NOTICE.md) and
[TRADEMARKS.md](./TRADEMARKS.md).
