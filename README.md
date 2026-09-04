# ToggleLogic Free — policy-based model routing for OpenClaw

> **PATENT PENDING.** Source-available under the **ToggleLogic Free Startup
> Commercial Use License 2.0** (see [LICENSE](./LICENSE)). It is not open source.
> © 2026 Motherboard, Inc. · https://togglelogic.ai/

## Routing you configure. Overrides that stick. A record of both.

ToggleLogic Free is the source-available routing layer for OpenClaw. It applies
your configured model choices, keeps an owner's explicit choice in force until
it is changed, and writes what happened to local records you can inspect.

It does not read prompts to guess intent. Your policy and provider credentials
remain under your control. Its routing audit and cost ledger stay on your machine
and are not transmitted to Motherboard. Model traffic still goes to the providers
you configure in OpenClaw.

## What it does

- **Configured routes.** Point a host-supplied task label at an exact model.
  Routing is deterministic and entirely under your control.
- **Deployment-declared cheapest default.** Name the inexpensive model you want
  used when nothing higher-priority applies. ToggleLogic Free does not classify
  the request or calculate the cheapest capable model.
- **Owner overrides that persist.** Set a model in the moment and it stays set
  until you change it. No silent re-routing on the next turn.
- **A local audit record.** See which task, which model, and on what basis in a
  structured routing log. ToggleLogic does not transmit that record to Motherboard.
- **Local cost visibility.** Estimate cost per model from public pricing data,
  computed on your machine. Unpriced models remain visibly unpriced, never a
  false `$0.00`.
- **Optional model-family aliases.** Name a family for a configured route and
  resolve it only within providers you have approved. Resolution safely passes
  through when freshness, provider, or price requirements are not satisfied.

## What it does not do

No prompt inspection or intent inference. No benchmark-driven selection. No
Toggle Registry, private classifiers, proprietary benchmark data, or bundled
provider credentials.

Those belong to **ToggleLogic Intelligence**, a separately licensed source-available package.
Its public engine can be inspected and contributed to; eligible startups register before commercial production use. The maintained production registry, benchmark intelligence, private evidence, signed packs, and services remain separately delivered. Free is the mechanism. Intelligence is the judgment.

## OpenClaw compatibility

> **Backward-compatible with OpenClaw 2026.6.5 and later; validated through
> OpenClaw 2026.9.1.**

The minimum gateway version remains `>=2026.6.5`, and the plugin API floor
remains `>=2026.5.2`. Those lower bounds are intentional: they preserve support
for existing OpenClaw deployments and do not mean ToggleLogic depends on an
obsolete host release. ToggleLogic Free 1.3.4 was packaged and passed its full
release quality gate on OpenClaw `2026.9.1`. OpenClaw versions newer than the
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

Bring your own provider credentials. Set your routing policy. The evidence stays
local.

## License, in brief

ToggleLogic Free is source-available, not open source. Personal use and internal
business use are free. You may also build, host, and charge for a bona fide product
containing ToggleLogic Free without contacting Motherboard first while your
consolidated startup group remains below both:

- **USD $1,000,000 in cumulative outside funding actually received**; and
- **USD $1,000,000 in actual gross revenue during a trailing 12-month period**.

Announced but unreceived financing, ARR, valuation, projected sales, and pipeline
do not count. Rights in a release lawfully received are not revocable absent a
material breach. Curable breaches receive a 30-day cure under the controlling
license.

Crossing either threshold starts a 30-day notice window and an automatic 180-day
transition license. If no commercial agreement or extension is effective when
that period ends, you must stop accepting new customers, making new deployments,
or materially expanding external commercial use. Existing customers may continue
running lawfully delivered copies, and you may provide defined security,
compatibility, defect-correction, and migration updates to previously deployed or
contractually committed customers for another 12 months.

This permission covers **ToggleLogic Free only**. It grants no access or rights to
ToggleLogic Intelligence, the Toggle Registry, proprietary benchmark selection,
private evidence, or other excluded components. Early contact is optional; contact
Motherboard whenever an Intelligence evaluation, architecture discussion, support,
or partnership would help: https://togglelogic.ai/contact/.

Read [LICENSE](./LICENSE) for the controlling terms or see the plain-language
summary at https://togglelogic.ai/licensing/.

## Modes

| Mode | Behavior |
|---|---|
| `auto` | Compatible Intelligence layer if present → else the cheap default if configured → else passthrough |
| `passthrough` | Defer every selection to OpenClaw's default (log only) |
| `configured` | Apply `configuredRoutes` from a host-supplied task label, then optional `default` |
| `cheap` | Apply the deployment-declared cheapest default (dumb, static) |
| `intelligence` | Defer to the separately licensed Intelligence package (not included in Free); report unavailable rather than silently downgrading |

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

Use of this Software is governed by the **ToggleLogic Free Startup Commercial Use
License 2.0** ([LICENSE](./LICENSE)). It permits personal and internal use and
defined commercial use by qualifying startups. Rights in a lawfully received
release are stable and may be terminated only under the license's breach-and-cure
terms. It is **not** an open-source license. See [NOTICE.md](./NOTICE.md) and
[TRADEMARKS.md](./TRADEMARKS.md).
