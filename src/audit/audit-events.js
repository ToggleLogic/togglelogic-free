/*
 * ToggleLogic (Free Tier) — model-routing plugin for OpenClaw.
 * (c) 2026 Motherboard, Inc. Source-available under the ToggleLogic Free-Tier
 * License (see LICENSE): free, limited, REVOCABLE use; all rights reserved.
 * PATENT PENDING. The benchmark Intelligence engine + Toggle Registry are NOT
 * in this package.
 */

/**
 * Audit event types and the canonical fields each one carries.
 *
 * Schema bar: NIST 800-53 AU-2 (Auditable Events), AU-3 (Content of Audit
 * Records), AU-12 (Audit Record Generation). The bar from Al's Phase 4
 * brief: a fresh auditor with no prior exposure can answer "what did this
 * system do, when, and on whose behalf" from the audit stream alone.
 *
 * Every line written through the audit logger MUST set:
 *   - timestamp: ISO 8601 UTC (AU-3 (a))
 *   - event:     value from EVENTS below (AU-3 (b))
 *   - outcome:   "success" | "failure" | "skip" | "noop" (AU-3 (c))
 *   - principal: who/what initiated the action (AU-3 (d))
 *
 * Subject and details are event-specific and may be omitted when irrelevant.
 *
 * Credentials, tokens, API keys, and full prompt bodies MUST NEVER appear
 * in audit lines. The audit stream is the most exposed log surface we
 * write — design assumption is that it will be exported to a SIEM that
 * many people can read. Reference credentials by name + path only.
 */

export const AUDIT_SCHEMA = "togglelogic-audit/v1";

export const EVENTS = Object.freeze({
  // --- Lifecycle / config ---
  PLUGIN_REGISTER: "plugin.register",
  CONFIG_LOAD: "config.load",
  FEATURE_GATE: "feature.gate",

  // --- Dispatch capability ---
  DISPATCH_HOOK_FIRE: "dispatch.hook.fire",
  // dispatch.tier1.ack records the Tier-1 acknowledgement decision and
  // delivery. As of plugin v0.5.1-beta (Phase 5, 2026-05-14) this event
  // emits in two phases for async async delivery paths:
  //   details.phase = "attempted" — HTTP request dispatched (outcome=success
  //                                 reflects the synchronous dispatch result)
  //   details.phase = "delivered" — HTTP response or failure received
  //                                 (outcome=success/failure reflects the
  //                                 actual delivery)
  // Both records carry the same correlationId. Auditors querying
  // "did Tier-1 ack deliver?" should join on correlationId and look at the
  // phase="delivered" record's outcome. The skip/noop/no-token paths emit
  // a single synchronous record with no phase field (the action never left
  // the plugin's process boundary, so attempt vs. delivery don't diverge).
  DISPATCH_TIER1_ACK: "dispatch.tier1.ack",
  DISPATCH_TIER2_SANITIZE: "dispatch.tier2.sanitize",
  DISPATCH_TRIGGER_MATCH: "dispatch.trigger.match",
  DISPATCH_REPHRASE: "dispatch.rephrase",
  DISPATCH_DECISION: "dispatch.decision",
  // Phase A pre-execution acknowledgment (2026-05-18). Records the
  // classifier-derived model recommendation + input/output token estimates
  // + cost estimate that the operator sees BEFORE the LLM call completes.
  // Two-phase pair like DISPATCH_TIER1_ACK: phase="attempted" (synchronous
  // dispatch) + phase="delivered" (HTTP outcome). correlationId joins.
  // For calibration: join against the agent runtime's per-call usage data
  // (see Phase C executionLog capability) by sessionKey + timestamp window.
  DISPATCH_ESTIMATE: "dispatch.estimate",

  // --- Routing capability (dormant in default config) ---
  ROUTING_HOOK_FIRE: "routing.hook.fire",
  ROUTING_DECISION: "routing.decision",

  // --- Credential boundary ---
  CREDENTIAL_LOOKUP: "credential.lookup",

  // --- Outbound redaction (Phase S1) ---
  // Fires when the message_sending hook detects one or more credential
  // value patterns in an outbound message body and rewrites the body
  // before transport. details.patternCounts carries pattern-name +
  // count pairs; matched substrings are NEVER recorded.
  REDACTION_INTERCEPT: "redaction.intercept",
});

export const OUTCOMES = Object.freeze({
  SUCCESS: "success",
  FAILURE: "failure",
  SKIP: "skip",
  NOOP: "noop",
});

/**
 * Map an event to its NIST 800-53 control families. Recorded on each line
 * so auditors can filter the stream by control without reading code.
 */
export function controlsFor(event) {
  switch (event) {
    case EVENTS.PLUGIN_REGISTER:
    case EVENTS.CONFIG_LOAD:
    case EVENTS.FEATURE_GATE:
      return ["AU-2", "AU-3", "CM-2", "CM-6"];
    case EVENTS.DISPATCH_ESTIMATE:
      return ["AU-2", "AU-3", "AU-12"];
    case EVENTS.DISPATCH_HOOK_FIRE:
    case EVENTS.DISPATCH_TIER1_ACK:
    case EVENTS.DISPATCH_TIER2_SANITIZE:
    case EVENTS.DISPATCH_TRIGGER_MATCH:
    case EVENTS.DISPATCH_REPHRASE:
    case EVENTS.DISPATCH_DECISION:
    case EVENTS.ROUTING_HOOK_FIRE:
    case EVENTS.ROUTING_DECISION:
      return ["AU-2", "AU-3", "AU-12"];
    case EVENTS.CREDENTIAL_LOOKUP:
      return ["AU-2", "AU-3", "AU-12", "IA-5"];
    case EVENTS.REDACTION_INTERCEPT:
      // SC-28 (Protection of Information at Rest) reads through to in-flight
      // exfiltration prevention; SI-12 (Information Handling and Retention)
      // covers the discard-before-emit policy this hook enforces.
      return ["AU-2", "AU-3", "AU-12", "SC-28", "SI-12"];
    default:
      return ["AU-2", "AU-3"];
  }
}
