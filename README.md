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
- **Static / intent routes.** Map host-supplied task labels to models in
  `configuredRoutes`. The Free plugin never inspects prompt text to infer a
  task.
- **Optional family aliases for configured routes.** An operator may explicitly
  map a route to `family:<alias>`. Resolution is disabled by default, restricted
  to approved providers already configured in OpenClaw, requires a fresh public
  pricing catalog with complete non-zero prices, and safely passes through if
  any condition is not met.
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
The optional configured-route family alias reads only a deployment-local cache
of the public Models.dev catalog; no catalog or proprietary registry ships here,
and this feature never participates in `cheap` mode.
Automatic benchmark-driven selection is the separately-licensed Intelligence layer; if
installed, this plugin detects it and defers to it (see `intelligence` config). To
license it: https://togglelogic.ai/

## OpenClaw compatibility

> **Backward-compatible with OpenClaw 2026.6.5 and later; validated through
> OpenClaw 2026.7.1-2.**

The minimum gateway version remains `>=2026.6.5`, and the plugin API floor
remains `>=2026.5.2`. Those lower bounds are intentional: they preserve support
for existing OpenClaw deployments and do not mean ToggleLogic depends on an
obsolete host release. ToggleLogic Free 1.3.1 was packaged and passed its full
release quality gate on OpenClaw `2026.7.1-2`. OpenClaw versions newer than the
stated validation point should be verified before production promotion.

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
| `configured` | Apply `configuredRoutes` from a host-supplied task label, then optional `default` |
| `cheap` | Apply the deployment-declared cheapest default (dumb, static) |
| `intelligence` | Defer to the separately-licensed Intelligence layer (not included); report unavailable rather than silently downgrading |

Owner overrides apply **above** the mode in all cases.

### Optional configured-route family aliases

Family resolution is explicit and off by default. A route must use the
`family:<alias>` form, and the alias must name allowed providers. Those
providers must also exist in OpenClaw's `models.providers` configuration.

```json
{
  "mode": "configured",
  "configuredRoutes": { "research": "family:grok" },
  "familyResolution": {
    "enabled": true,
    "maxAgeHours": 48,
    "aliases": {
      "grok": {
        "family": "grok",
        "providers": ["xai"],
        "strategy": "lowest_cost",
        "maxInputPerM": 5,
        "maxOutputPerM": 20
      }
    }
  }
}
```

`newest` is also available, but still obeys provider, freshness, complete-price,
and optional price-ceiling gates. Failure produces passthrough, never a bare
family name.

**Optional expiry.** An override may include `expires_at_ms` (a numeric epoch-ms deadline).
After it passes, the override stops applying and routing returns to automatic — no file rewrite
needed. Writers SHOULD set `expires_at_ms` so a forgotten override cannot hold forever; omit it
only for a deliberately indefinite override. A present-but-non-numeric `expires_at_ms` is
rejected (fail-closed) and logged to the audit stream.

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

### Fleet attribution

Version 1.1 adds privacy-safe, local fleet attribution to every cost-log call and
summary. Configure a stable deployment slug and an optional cost-center slug; the
plugin writes them to the local JSONL ledger using schema
`togglelogic.fleet-usage.v1`. It does not transmit usage, identifiers, prompts, or
customer information to Motherboard or any ToggleLogic service. If `deploymentId`
is omitted, the local hostname is used.

Dollar values in this ledger are explicitly marked `public-rate-estimate` and
`invoiceEligible: false`. A fleet operator must reconcile deployment totals
against authoritative provider billing before creating an invoice.

Enable it (also requires `hooks.allowConversationAccess`, since `llm_output` is a
conversation hook):

```json
{
  "plugins": { "entries": { "togglelogic": {
    "enabled": true,
    "hooks": { "allowConversationAccess": true },
    "config": {
      "features": { "costVisibility": { "enabled": true } },
      "costVisibility": {
        "attribution": {
          "deploymentId": "sam-andy",
          "costCenter": "andy"
        }
      }
    }
  } } }
}
```

## Config reference

See `openclaw.plugin.json` `configSchema` for every field: `mode`, `logging`,
`configuredRoutes`, `cheapHeuristic`, `familyResolution`, `intelligence`, `ownerOverride`, `features`,
`audit`, `costVisibility`.

## License

Use of this Software is governed by the **ToggleLogic Free-Tier License** ([LICENSE](./LICENSE)).
It is free to use but **revocable**, reserves all of Motherboard, Inc.'s rights including
its pending patents, and prohibits redistribution and competing use. It is **not** an
open-source license.
