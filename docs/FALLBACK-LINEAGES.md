<!--
ToggleLogic (Free Tier) — generic fallback lineage configuration.
(c) 2026 Motherboard, Inc. Source-available under the ToggleLogic Free-Tier
License (see LICENSE); all rights reserved. PATENT PENDING.
-->
# Fallback lineages

Configure an ordered `routing.fallbackLineages` array in the plugin config:

```json
{
  "routing": {
    "fallbackLineages": [
      "google/gemini-flash",
      "anthropic/claude-haiku",
      "xai/grok",
      "ollama/*"
    ]
  }
}
```

Entries must be provider-qualified lineages or a provider wildcard. Numbered
children are rejected. Derivation is purely syntactic and shared with the
ledger; see [the ledger rule](COST-LEDGER.md). Qualifiers such as `preview`,
`mini`, and size labels remain distinct. There is no private family data or
semantic family inference.

For each entry, the resolver intersects public release metadata with the host's
configured models. A nonempty `agents.defaults.models` allowlist is authoritative.
Otherwise it uses explicitly configured provider models and the applicable
agent's primary and fallbacks. It never authorizes a child merely because it
appears in the public feed, and it does not expand host aliases or unqualified
model names. Configure qualified references for eligible children.

Eligible children must have a valid models.dev `release_date`. The newest date
wins; equal dates use ascending qualified-reference order. The feed is refreshed
on the existing pricing-cache cadence. A new child can be picked without
changing the lineage plan **only if the host has configured/allowed it**.
A stale public cache can be used during a source outage; it cannot establish
that a newer child exists. Bundled rates or price overrides never invent
release dates. Models without public release dates, including local models,
are ineligible until the source supplies that metadata.

A provider in a TL-5 cooldown is skipped. On a subsequent routing decision for
that provider, Free resolves the first available lineage and records both
`lineage` and `resolvedChild`, plus the resolution reason. Owner overrides
retain precedence and record a cooldown conflict. Both routing and cost
visibility must be enabled to observe refusals and apply next-turn failover.
An empty or exhausted plan produces a rejected hook plus failure audit; Free
never silently pins a numbered host fallback. Core decides how to handle hook
failures and still owns in-turn retries.

At routing startup, `FALLBACK_PLAN_CHECK` (`fallback.plan.check`) warns when
numbered host fallbacks have no matching lineage entry. This audit does not
modify core's fallback configuration or certify live provider availability.

No software installation or deployment is part of this change. Existing stored
ledger lineage values are retained; newly observed rows use the shared rule.
