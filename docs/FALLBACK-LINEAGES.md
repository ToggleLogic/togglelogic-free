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
children are excluded from the plan and recorded in the startup audit. Invalid
entries trigger one startup warning without disabling routing or cost visibility. Derivation is purely syntactic and shared with the
ledger; see [the ledger rule](COST-LEDGER.md). Qualifiers such as `preview`,
`mini`, and size labels remain distinct. There is no private family data or
semantic family inference.

For each entry, the resolver intersects public release metadata with the host's
configured models. A nonempty `agents.defaults.models` allowlist is authoritative.
Otherwise it uses explicitly configured provider models and the applicable
agent's primary and fallbacks. It never authorizes a child merely because it
appears in the public feed, and it does not expand host aliases or unqualified
model names. Configure qualified references for eligible children.

When matching children have valid models.dev `release_date` metadata, the newest
date wins; equal dates use ascending qualified-reference order. If none has a
valid release date, the first matching child in host-config order is selected
with `reason: "configured-order-no-release-date"`. This also supports local
lineages and provider wildcards without inventing release dates.

The feed is refreshed on the existing pricing-cache cadence. A new child can be
picked without changing the lineage plan only if the host has configured/allowed
it. A stale cache cannot reveal a newer release. Neither bundled rates nor price
overrides invent release dates.

A provider in a TL-5 cooldown is skipped. On a subsequent routing decision for
that provider, Free resolves the first available lineage and records both
`lineage` and `resolvedChild`, plus the resolution reason. Owner overrides
retain precedence and record a cooldown conflict. Both routing and cost
visibility must be enabled to observe refusals and apply next-turn failover.
An empty or exhausted plan tries available host-configured fallbacks in order,
respecting the host allowlist and provider cooldowns. If none is available, Free
preserves the selection, emits `fallback_unresolved` and a FAILURE audit record,
and logs a warning. `before_model_resolve` never throws. Core still owns in-turn
retries; Free does not guarantee provider success.

At routing startup, `FALLBACK_PLAN_CHECK` (`fallback.plan.check`) warns when
numbered host fallbacks have no matching lineage entry. This audit does not
modify core's fallback configuration or certify live provider availability.

No software installation or deployment is part of this change. Existing stored
ledger lineage values are retained; newly observed rows use the shared rule.
