# ToggleLogic Free 1.5.0-rc.1

## Purpose

This release candidate makes ToggleLogic's governed-escalation boundary portable
across agent deployments. The routing core remains unchanged. The approval state
machine remains deterministic, fail-closed, turn-bound, and one-use.

## What changed

- Removed the hardcoded `SAM` name from approval notices.
- Replaced the built-in product-specific approval vocabulary with strict neutral
  defaults and deployment-configurable affirmative/negative phrase lists.
- Replaced hardcoded provider and model display-name rules with optional
  deployment-configured maps. Exact provider/model references remain available
  when no display name is supplied.
- Connected the existing `externalDataNotice` setting to the actual invitation
  and confirmation text.
- Make the final confirmation display the deployment's configured affirmative
  and negative phrases instead of hardcoding `Yes` and `No`.
- Added `docs/INTEGRATION-RESPONSIBILITY-CONTRACT.md`, a developer guide explaining
  the boundaries among the host runtime, ToggleLogic, and the deployed agent.

## Why this matters

ToggleLogic can choose a model and record that decision. It cannot authenticate an
owner, interpret every deployment's language, perform a CRM or email action, or
prove that the action happened. Those responsibilities require host and deployment
support. Keeping them outside the routing core makes ToggleLogic useful to other
developers without embedding one customer's agent policy in the plugin.

## Configuration migration

Governed escalation now recognizes only exact `Yes` and `No` by default after
normalization. Deployments that accept phrases such as `Go ahead`, `Approved`, or
localized equivalents must declare them explicitly:

```json
{
  "governedEscalation": {
    "externalDataNotice": "this request and active Acme Assistant context will be sent to Example AI",
    "approvalLanguage": {
      "affirmative": ["yes", "approved", "go ahead"],
      "negative": ["no", "cancel", "stop"]
    },
    "displayNames": {
      "providers": { "example": "Example AI" },
      "models": { "example/model-v2": "Example Model 2" }
    }
  }
}
```

These values affect presentation and deterministic phrase normalization only.
They do not grant owner authority. The deployment must authenticate the speaker
and channel before treating any text as an owner command.

## Release status

This is a release candidate. It is not a ClawHub production promotion. Production
promotion requires the full quality gate, independent review, package inspection,
and a controlled host canary.
