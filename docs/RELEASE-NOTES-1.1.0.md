# ToggleLogic 1.1.0 developer notes

Release date: 2026-08-11

## Purpose

Version 1.1.0 makes the existing observe-only cost log usable as a local fleet
meter. It does not create an invoice and it does not transmit telemetry.

## Ledger contract

Every cost-log call and summary row carries:

- `schema: togglelogic.fleet-usage.v1`
- `deploymentId`: configured stable slug, or the local hostname as fallback
- `costCenter`: optional configured non-secret slug

Priced call rows also carry:

- `costBasis: public-rate-estimate`
- `invoiceEligible: false`

Those markers are load-bearing. A downstream collector must not present local
public-rate calculations as provider-billed truth. Invoice eligibility belongs
to the fleet reconciliation layer, after authoritative provider totals agree.

## Privacy boundary

The free plugin writes the ledger locally. It does not phone home. Attribution
accepts only 1–64 character portable slugs and rejects free-form strings such as
email addresses and filesystem paths. The ledger contains no prompt or assistant
text.

## Upgrade configuration

Cost visibility remains opt-in and requires the OpenClaw conversation hook:

```json
{
  "plugins": {
    "entries": {
      "togglelogic": {
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
      }
    }
  }
}
```

## Compatibility and behavior

- Minimum OpenClaw remains `>=2026.6.5`.
- Routing behavior is unchanged.
- Existing cost logs remain readable; new rows are distinguishable by `schema`.
- No automatic network transfer, enforcement, blocking, or billing occurs.

## Verification

The release tests cover attribution normalization, schema stamping, hostname
fallback, absence of prompt/session content, and the rule that estimates are
never marked invoice-ready.
