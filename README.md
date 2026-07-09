# ToggleLogic (Free Tier) — model routing for OpenClaw

> **PATENT PENDING.** Source-available under the **ToggleLogic Free-Tier License**
> (see [LICENSE](./LICENSE)) — free, limited, **revocable** use; all rights reserved.
> Not open-source; not MIT/Apache. © 2026 Motherboard, Inc. · https://togglelogic.ai/

ToggleLogic routes each OpenClaw request to a model you control — **bring your own
provider credentials, declare intent, and let the plugin apply your choices.** This
free tier gives you:

- **Owner overrides (sticky, held).** Tell your assistant "use Opus for this" and the
  deployment-side switch writes an override that persists across every subsequent request
  — pins hold until you switch back.
- **Static / intent routes.** Map tasks to models in `configuredRoutes`.
- **A deliberately-simple cheapest-default.** Name the cheap model you want as the
  default; the plugin defaults to it unless an override or route says otherwise.
- **A structured audit stream** of every routing decision (NIST 800-53 AU-2/AU-3/AU-12
  schema bar).
- **Cost visibility (dollars) — observe-only.** See what your calls cost, per model and
  per day, priced from live public data. Unpriced models are shown loudly, never a silent
  $0.00. Opt-in; reports only, never enforces. (See [Cost visibility](#cost-visibility-dollars).)

It does **not** include — and never ships — the patented **ToggleLogic Intelligence**
engine (benchmark-driven automatic model selection) or the **Toggle Registry**. The
free cheapest-default is a *dumb static preference*: it never inspects your request,
never consults a model registry or benchmark, and embeds no model names or prices.
Automatic benchmark-driven selection is the separately-licensed Intelligence layer; if
installed, this plugin detects it and defers to it (see `intelligence` config). To
license it: https://togglelogic.ai/

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

## Modes

| Mode | Behavior |
|---|---|
| `auto` | Licensed Intelligence layer if present → else the cheap default if configured → else passthrough |
| `passthrough` | Defer every selection to OpenClaw's default (log only) |
| `configured` | Apply `configuredRoutes` (static task→model map) |
| `cheap` | Apply the deployment-declared cheapest default (dumb, static) |
| `intelligence` | Defer to the separately-licensed Intelligence layer (not included) |

Owner overrides apply **above** the mode in all cases.

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

Enable it (also requires `hooks.allowConversationAccess`, since `llm_output` is a
conversation hook):

```json
{
  "plugins": { "entries": { "togglelogic": {
    "enabled": true,
    "hooks": { "allowConversationAccess": true },
    "config": { "features": { "costVisibility": { "enabled": true } } }
  } } }
}
```

## Config reference

See `openclaw.plugin.json` `configSchema` for every field: `mode`, `logging`,
`configuredRoutes`, `cheapHeuristic`, `intelligence`, `ownerOverride`, `features`,
`audit`, `costVisibility`.

## License

Use of this Software is governed by the **ToggleLogic Free-Tier License** ([LICENSE](./LICENSE)).
It is free to use but **revocable**, reserves all of Motherboard, Inc.'s rights including
its pending patents, and prohibits redistribution and competing use. It is **not** an
open-source license.
