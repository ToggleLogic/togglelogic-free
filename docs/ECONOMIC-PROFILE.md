# Economic profile — hardware-equivalent monthly cloud budget (1.6.1-rc.3)

The owner policy treats **installed local inference as $0 marginal** and compares
cloud model spend against the **amortized monthly cost of the local hardware** that
would otherwise do the work. This document is the candidate, distributable profile
for that policy and how the plugin now enforces it with a LIVE spend number.

## The numbers (SAM-HQ owner policy)

| Input | Value |
| --- | --- |
| Incremental local capital | **$400** |
| Useful life | **48 months** |
| Installed local marginal inference cost | **$0 / run** |
| Local monthly operating | $0 |
| **Amortized monthly ownership** | $400 ÷ 48 = **$8.33 / mo** |
| **Derived monthly cloud budget** | amortized + operating = **≈ $8.33 / mo** |

These live in the **Intelligence** skill-routing-profiles document (the deployment
owns it), not in the Free plugin — see
`~/togglelogic-intelligence/config/skill-routing-profiles.example.json`:

```json
"economic_policy": {
  "local_capital_cost_usd": 400,
  "useful_life_months": 48,
  "local_monthly_operating_usd": 0,
  "expected_local_runs_per_month": 1000
}
```

Intelligence derives `monthly_cloud_budget_usd = capital/months + operating`
(an explicit `monthly_cloud_budget_usd` overrides it). `amortized_local_monthly_usd`
and the per-run allocated local cost are reported for transparency; they never make a
$0-marginal local model "cost" anything at selection time. Hardware ownership stays
visible as the comparable monthly cloud budget on every choice/receipt.

## How the budget is enforced (now live)

1. **Month-to-date CLOUD spend** is no longer a hand-entered number. With
   `skillRouting.spend.enabled`, the plugin consumes a deployment-owned, validated,
   current-policy-month cloud-spend snapshot (see `docs/RUNTIME-STATE-REFRESH.md`
   and `src/usage/spend-snapshot.js`) written from
   `openclaw gateway usage-cost --all-agents --expect-final --json`. Unpriced LOCAL
   (Ollama) rows are expected $0; **any unpriced CLOUD row fails the snapshot closed**
   so spend is never understated.
2. Intelligence computes `monthly_headroom = max(0, budget − spend)`. A cloud
   candidate whose estimated cost exceeds headroom is **excluded**; local candidates
   are **never** headroom-capped (they are $0 marginal). So once month-to-date cloud
   spend reaches the ~$8.33 budget, cloud routes stop being offered and local-capable
   routes remain — automatically. (September month-to-date on the reference host is
   ≈ $23.13, already **past** the $8.33 budget, so cloud is withheld today.)
3. **Fail closed:** if the snapshot is missing/stale/invalid and
   `spend.finiteCloudBudgetApplies` is set, the plugin feeds a budget-exhausted
   signal so cloud is withheld while local-capable routes remain. The universal
   no-skill fail-safe always runs BEFORE any of this.
4. **Authoritative — no caller override.** When `skillRouting.spend.enabled` is true,
   the validated live snapshot is the single source of month-to-date spend: no
   caller, event, or tool parameter can override it (a hand-entered zero can never
   reopen cloud after a valid or exhausted snapshot). The former
   `monthly_cloud_spend_usd` tool parameter was removed; an attempted override is
   ignored and audited. The static `monthlyCloudSpendUsd` is used only when the
   feature is off, or via the documented no-finite-budget fallback.
5. **Optional post-snapshot delta fails closed.** The optional cost-log top-up
   (`spend.delta`) only ADDS a total it can prove COMPLETE for calls strictly after
   the snapshot's `through` instant. Any unpriced post-through cloud row, unknown
   provider provenance, parse/tail-truncation that could conceal a post-through row,
   or an unreadable ledger makes the provider unavailable/cloud-suppressed under a
   finite budget — it never returns the base total as if verified.

### Trust model — checksum vs. authentication, and file ownership

The snapshot's `fingerprint` is a **public SHA-256 checksum** over every
trust/freshness/routing field (source, plugin pair, policy month, timezone,
`generated_at_ms`/`generated_at`, `through_ms`, total, day count, cloud/local
missing-cost counts and the local attribution map, and `local_providers`). It is
**drift/tamper EVIDENCE, not authentication** — anyone can recompute it over edited
contents, so a matching fingerprint proves internal consistency, not provenance.
Authenticity comes from the **deployment-owned file**: the generator writes the
snapshot **0600 under a 0700 directory** owned by the OpenClaw service identity
(never on a user turn — the plugin never shells out), and the plugin only ever READS
it. The consumer additionally cross-checks the snapshot's `local_providers` against
the plugin's OWN configured local set (exact normalized match) and fails closed on
mismatch, so a snapshot built against a different local/cloud partition than the
running config is never trusted.

## Capability floors (Graph / Zoom require real tool-calling)

`skillRouting.skillRequirements` (routing constraints, not learned model choices)
declares the capability floor each skill needs. `microsoft-graph` and `zoom-meetings`
require `tool_calling_strong` + `requiresTools`, so an installed **general-purpose-only**
local model is excluded for them even when it is the cheapest $0 option — it cannot
make the Graph/Zoom call. A skill with no explicit entry inherits the conservative
default (`tool_calling_strong` + `requiresTools`); opt a proven tool-free skill DOWN
explicitly to let a local model win.

## High-precision meeting recipe

The meeting-prep intent is deliberately narrow: it requires a **meeting** term AND a
**prepare/brief** term (`allTerms:["meeting"]`, `anyTerms:["prepare","prep","brief",
"briefing",…]`). "prepare me for my 2 pm meeting" matches; a bare "meeting" does not.
A matched recipe resolves to the authoritative calendar skill (`microsoft-graph`)
only when it is in the verified inventory, then the meeting/calendar safety contract
grounds it against Outlook via Microsoft Graph (past/absent/ambiguous → clarify,
never fabricate).

## SAM-HQ scope (Telegram account `default`)

The canary binds to the owner's own SAM-HQ Telegram DM — channel `telegram`, account
`default` (the account SAM itself runs on, session-key form
`agent:main:telegram:default:direct:<owner-peer-id>`), `requireOwner:true`,
`allowGlobal:false`. **No owner peer id is baked into this package**: the distributable
example uses the placeholder `<OWNER_TELEGRAM_PEER_ID>` in `scope.ownerSenderIds`.

## Distributable example

A complete, schema-valid example (validated against the real OpenClaw 2026.9.4 schema)
is at [`examples/sam-hq-owner-policy.openclaw.json`](examples/sam-hq-owner-policy.openclaw.json).
Copy the `plugins.entries.togglelogic` block into your `openclaw.json` and replace
`<MANAGED_PLUGIN_ROOT>` and `<OWNER_TELEGRAM_PEER_ID>`. It ships `intelligence.shadow:
true` (observe/audit only) for a first canary; flip to active only after the scoped
canary runs clean.
