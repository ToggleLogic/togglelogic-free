# ToggleLogic Free

ToggleLogic Free is a generic model-routing and enforcement connector for OpenClaw.

It provides:

- sticky owner model overrides;
- static routing from host-supplied structured labels;
- a deployment-declared cheap default;
- a compatibility seam for separately licensed ToggleLogic Intelligence;
- one-time approval controls for configured external-model escalation;
- structured routing and cost audit records;
- spend tracking: every model call recorded in dollars, with monthly CSV/JSON
  export, budget alerts, prepaid balance estimates, and rerouting around
  providers that refuse calls for billing reasons; and
- neutral bounded-execution envelope validation for trusted consumers.

It deliberately does not provide an assistant, memory, installed-skill discovery,
intent-to-workflow resolution, business contracts, integration-specific policy, or
owner-facing workflow presentation. Those belong to the consuming application.

## Configuration

Routing is opt-in:

```json
{
  "plugins": {
    "entries": {
      "togglelogic": {
        "enabled": true,
        "hooks": { "allowConversationAccess": true },
        "config": {
          "mode": "auto",
          "features": {
            "routing": { "enabled": true },
            "costVisibility": { "enabled": true }
          }
        }
      }
    }
  }
}
```

`configuredRoutes` matches only structured labels supplied by the host. ToggleLogic
Free never reads prompt text to infer a workflow.

## Spend tracking

ToggleLogic Free records each routed model call with the machine it ran on, the
provider, the model family and exact model, its estimated cost in dollars at the
provider's published rate, where that price came from, and whether the call is
billable. A call without a price is counted and flagged, never shown as $0.00.

We run our own agent fleet on it. See our real numbers, model by model:
[Know what your AI costs](https://togglelogic.ai/spend-tracking/).

Details: [cost ledger and exports](docs/COST-LEDGER.md),
[cost events](docs/COST-EVENTS.md), [prepaid balances](docs/PREPAID-BALANCES.md),
and [fallback by model family](docs/FALLBACK-LINEAGES.md).

## Product boundary

The controlling boundary is [docs/INTEGRATION-RESPONSIBILITY-CONTRACT.md](docs/INTEGRATION-RESPONSIBILITY-CONTRACT.md).
Version 2.0 removes the application-specific orchestration surface that was
mistakenly included in the 1.6–1.7 line.

## Links

- Website: [togglelogic.ai](https://togglelogic.ai/)
- What it costs us: [togglelogic.ai/spend-tracking](https://togglelogic.ai/spend-tracking/)
- Release notes: [togglelogic.ai/changelog](https://togglelogic.ai/changelog/)

## License

See [LICENSE](LICENSE), [NOTICE.md](NOTICE.md), and [TRADEMARKS.md](TRADEMARKS.md).
