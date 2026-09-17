# ToggleLogic Free 1.7.0-rc.2

ToggleLogic 1.7 changes first-use skill teaching from three abstract policies
into an owner-facing model marketplace.

## Meaningful choices

When the accepted pool supports them, the education prompt shows three distinct
durable lineages:

- **Economy** minimizes expected workflow cost while meeting the skill contract.
- **Recommended** is ToggleLogic Intelligence's skill-specific balance of
  capability evidence, reliability, and cost.
- **Premium** favors the strongest eligible evidence even when it costs more.

Each option states the concrete child currently resolved for its lineage, its
estimated whole-workflow cost range, a skill-specific advantage, and its main
trade-off. The recommendation explains why it fits this skill. These descriptions
are evidence supplied by ToggleLogic Intelligence; Free displays and binds them
to the owner's decision without inventing comparative claims.

Two eligible lineages are shown as two choices. One eligible lineage is shown
once as **Only eligible model**. Duplicate policy results are collapsed, so a
single Grok—or any other model—can no longer appear as three fictional choices.

## Safe learning

The owner may reply with the displayed `1`, `2`, or `3`. The pending plan remains
restart-safe, expires on the configured TTL, and is bound to the authenticated
owner, sender, and conversation. ToggleLogic records the exact strategy and
durable lineage behind the displayed choice for the applicable skill version.
Numbered model children remain execution-time resolutions, not permanent pins.

## Truthful execution receipts

Receipts now distinguish:

- the **planned lineage and child**, selected before execution; and
- the **observed execution model**, read only from structured provider/model
  evidence on the completed child assistant event.

If OpenClaw does not expose that evidence, the receipt says so and does not call
the planned model the model actually used. Token and metered-cost limitations
remain explicit.

## Scope and safety

This release does not expand authority. Active teaching and execution remain
owner-scoped and opt-in. The deterministic skill boundary, sender/session
binding, capability and privacy constraints, cloud budget, bounded child, and
tool-call guard remain in force. Global and unattended enforcement remain
unavailable pending a host-provided in-flight model token/cost/pass safeguard.
