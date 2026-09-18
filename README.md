# ToggleLogic Free

ToggleLogic Free is a generic model-routing and enforcement connector for OpenClaw.

It provides:

- sticky owner model overrides;
- static routing from host-supplied structured labels;
- a deployment-declared cheap default;
- a compatibility seam for separately licensed ToggleLogic Intelligence;
- one-time approval controls for configured external-model escalation;
- structured routing and cost audit records; and
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

## Product boundary

The controlling boundary is [docs/INTEGRATION-RESPONSIBILITY-CONTRACT.md](docs/INTEGRATION-RESPONSIBILITY-CONTRACT.md).
Version 2.0 removes the application-specific orchestration surface that was
mistakenly included in the 1.6–1.7 line.

## License

See [LICENSE](LICENSE), [NOTICE.md](NOTICE.md), and [TRADEMARKS.md](TRADEMARKS.md).
