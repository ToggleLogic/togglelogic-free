<!--
ToggleLogic (Free Tier) — cost event subscription contract.
(c) 2026 Motherboard, Inc. Source-available under the ToggleLogic Free-Tier
License (see LICENSE); all rights reserved.
PATENT PENDING.
-->

# Cost visibility events

With `features.costVisibility.enabled`, hosts can subscribe by tailing
`~/.openclaw/logs/togglelogic-events.jsonl`. Configure another destination with
`costVisibility.events.path` and rotation with `costVisibility.events.rotateSizeMb`
(default 50). Paths respect the active OpenClaw state directory. Writes append
JSON lines; rotation retains five older files, just like the cost log. Subscribers
must follow file rotation. Longer retention is the host's responsibility.

Every row has `schema: "togglelogic.event.v1"`, UTC ISO `ts`, `event`, `deploymentId`,
`costCenter`, and `requestId` (null when routing correlation is unavailable).
Events also go to the plugin audit sink when audit logging is enabled, with the
same event name and event row in `details`. No provider error bodies, credential
fields, billing account IDs, or endpoint URLs are copied into either event sink.

- `model_unpriced`: `provider`, `model`, `resolvedRef`, and `reason`
  (`no-price-in-source` or `outside-price-coverage`). First unpriced remote call per resolved reference per
  UTC day, scoped to deployment attribution.
- `usage_missing`: `provider`, `model`, `resolvedRef`, and `calls`. First call
  with a known price but missing, invalid, or all-zero usage per resolved reference
  per UTC hour. `calls` is 1 at that immediate emission, not the eventual burst
  size. The cost ledger and summary retain every call. This event indicates
  incomplete usage evidence; it does not diagnose a billing refusal.

Suppression is serialized within an observer and restored on restart from the
retained event files. Independent processes must use separate event paths;
there is no cross-process lock. Removing or rotating out all records of an event
also removes its persisted suppression. File failures are reported to the host
logger; observation never changes the model call's outcome.

`costVisibility.localProviders` defaults to `ollama`, `lmstudio`, `llamacpp`, and
`vllm-local`. An explicit array replaces that list. A serving provider is also
local when its host configuration at `models.providers.<provider>.baseUrl` has
hostname `localhost`, `127.0.0.1`, or `::1`. Loopback checks parse the URL; they do
not accept a remote hostname merely containing a loopback name. Unpriced local
calls stay in the ledger and summary but do not emit `model_unpriced`.
`usage_missing` is emitted for priced models regardless of locality.

Daily summaries use UTC boundaries and three separate buckets: priced dollar
subtotal, unpriced calls (no price available), and usage-missing calls (priced
model, no usable usage reported). Neither incomplete bucket is counted as zero
spend. Human summaries show dollars and call counts, with no coverage upsell.
