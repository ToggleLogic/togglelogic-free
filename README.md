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

## Owner pins

The owner can pin a model to a single labelled task, or to every task. Pins are
set from the command line with `togglelogic-pin`; the routing hook only reads
them, and each pin is one line in `list`.

```sh
# pin an exact model for one task
togglelogic-pin set --scope task:inventory-sync --model anthropic/claude-opus-4-8 --config openclaw.json
# pin a model family for one task (resolves to a configured member)
togglelogic-pin set --scope task:drafts --family google/gemini-3.5-* --config openclaw.json
# pin all tasks (an all-tasks pin must carry an expiry)
togglelogic-pin set --scope all --model anthropic/claude-sonnet-4-6 --expires +72h --config openclaw.json
# clear one pin, or list every pin
togglelogic-pin clear --scope task:inventory-sync --config openclaw.json
togglelogic-pin list --config openclaw.json
```

**Decision order (highest first):** the owner's own in-chat `/model` pick → owner
pins (a task pin, else the all-tasks pin) → a skill's requested model → the
configured route. A skill can never override an owner pin. On a host where
several people may chat, every allowed chat user's `/model` pick counts as the
owner's; a host that needs otherwise must not mark such picks `source: "user"`.

ToggleLogic Free never recommends a model — choosing the model is the owner's
job. Want the best model recommended for each task? See ToggleLogic Intelligence
— https://togglelogic.ai.

## Conversation access is required for routing

Routing runs on OpenClaw's conversation hooks. Because ToggleLogic Free is a
non-bundled plugin, the host will **not** let it register those hooks unless you
explicitly grant permission:

```json
"hooks": { "allowConversationAccess": true }
```

(under `plugins.entries.togglelogic`, as shown in the snippet above). Without
`plugins.entries.togglelogic.hooks.allowConversationAccess: true`, routing is
**disabled**: the routing hook never fires and every turn falls through to the
host default model unrouted. ToggleLogic Free detects this at startup and makes
it observable — an error-level startup log naming the setting, a `routing.skipped`
audit record, and a not-ready routing capability gate in the plugin-registration
audit — so the misconfiguration is never silent. Set the flag to `true` and
restart the gateway to enable routing.

### Audit-write failures are loud

If the audit log cannot be written (full disk, missing or read-only directory),
ToggleLogic Free keeps routing but never fails silently: every failed write is
counted; an error-level log is written on the first failure and at most once a
minute after that, and at every session start while the problem lasts; an
`audit_write_failed` event (counts and error code only) goes to the separate
events file; and the audit capability gate reports not ready. When writes
succeed again, an `audit.write.recovered` record in the audit log states how
many records were lost and when.

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

## Changelog

- Release notes for every version: [togglelogic.ai/changelog](https://togglelogic.ai/changelog/)
- GitHub releases: [github.com/ToggleLogic/togglelogic-free/releases](https://github.com/ToggleLogic/togglelogic-free/releases)
- Full history: [`CHANGELOG.md`](CHANGELOG.md) in this package.

## Links

- Website: [togglelogic.ai](https://togglelogic.ai/)
- What it costs us: [togglelogic.ai/spend-tracking](https://togglelogic.ai/spend-tracking/)
- Release notes: [togglelogic.ai/changelog](https://togglelogic.ai/changelog/)
- GitHub releases: [github.com/ToggleLogic/togglelogic-free/releases](https://github.com/ToggleLogic/togglelogic-free/releases)

## License

See [LICENSE](LICENSE), [NOTICE.md](NOTICE.md), and [TRADEMARKS.md](TRADEMARKS.md).
