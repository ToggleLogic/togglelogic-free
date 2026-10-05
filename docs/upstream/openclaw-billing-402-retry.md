<!--
ToggleLogic (Free Tier) — upstream billing retry issue draft.
(c) 2026 Motherboard, Inc. Source-available under the ToggleLogic Free-Tier
License (see LICENSE); all rights reserved. PATENT PENDING.
-->
# Draft: preserve billing refusal classification through retries

Installed version, exact `openclaw --version` output:
`OpenClaw 2026.9.7 (c074824)`.

Reported September 28 behavior: a Google prepayment billing refusal with a 402
marker was relabeled `reason=rate_limit`, producing nine retries spaced about
30 seconds apart. This report is supplied historical evidence, not a fresh
live-provider reproduction on the version above.

Sanitized synthetic input: `402 PAYMENT_REQUIRED: prepayment required`.
Expected: preserve the billing classification, stop retrying that provider in
this turn, and allow configured failover. `429 RESOURCE_EXHAUSTED: quota exceeded`
alone must remain a retryable rate limit; the resource status alone is ambiguous.

Installed-source inspection: `PluginHookLlmOutputEvent` has `lastAssistant?: unknown`.
In `builtin-openclaw-dCw2mRD9.mjs`, `captureStreamSnapshot` retains the last
assistant message; `completeEmbeddedAttemptResult` passes it as
`llm_output.lastAssistant` alongside provider/model and usage. The assistant's
`stopReason: "error"` and `errorMessage` expose refusal evidence even with zero
usage. Free validates assistant provider/model attribution and does not infer
billing from zero usage. Missing/mismatched assistant evidence is ignored.
`agent_end.error` is run-level and lacks reliable per-attempt provider attribution.

Free can observe this payload and affect a subsequent routing decision. The
void-typed output hook cannot interrupt core's in-turn retry loop. Request:
regression-test billing classification before rate-limit retry scheduling and
retain structured status, provider, and billing reason in a per-attempt hook.

No raw provider errors are copied into Free events or audit records. Review and
reproduce upstream before submitting this draft; it has not been posted.
