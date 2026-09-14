# ToggleLogic Free 1.4.2-rc.1

This reliability release candidate corrects a governed-escalation routing
failure introduced in 1.4.0 and still present in 1.4.1.

When the separately installed Intelligence engine intentionally returned no
routing decision, the governed-escalation layer treated the missing capability
tier as permission to force its configured local model. That could replace the
host's more capable default on ambiguous requests, follow-ups, and work that
needed tools or external-content grounding.

An absent decision now means exactly that: ToggleLogic emits no override and
OpenClaw keeps its configured default and fallback policy. Explicitly classified
local tiers continue to use the configured local model, and external tiers
continue through the existing approval boundary.

The release candidate adds unit and end-to-end regressions for the no-decision
path and retains the existing governed-escalation suite. The capability remains
opt-in and disabled by default.

## Affected configurations and temporary mitigation

The faulty branch exists in ToggleLogic Free 1.4.0 and 1.4.1. It is reachable
only when governed escalation is enabled, a local model is configured, and the
Intelligence engine returns no capability tier. Installations that do not use
governed escalation are not affected by this specific failure.

Operators who cannot upgrade immediately should temporarily disable
`features.governedEscalation.enabled`. That restores ordinary host routing but
also disables ToggleLogic's one-use external-model approval gate, so operators
must apply their normal provider and cost controls until the upgrade is
installed.
