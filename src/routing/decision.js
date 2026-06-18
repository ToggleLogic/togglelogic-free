/*
 * ToggleLogic (Free Tier) — model-routing plugin for OpenClaw.
 * (c) 2026 Motherboard, Inc. Source-available under the ToggleLogic Free-Tier
 * License (see LICENSE): free, limited, REVOCABLE use; all rights reserved.
 * PATENT PENDING. The benchmark Intelligence engine + Toggle Registry are NOT
 * in this package.
 */

/**
 * Decision data structure.
 *
 * One Decision object per before_model_resolve invocation. Serialized as
 * one line of JSON in the routing log (jsonl format) for grep/jq use and
 * eventual ingestion by togglelogic-tail / togglelogic-status CLI tools
 * (v0.3.x backlog).
 *
 * Schema (alpha.1 — fields may extend in alpha.2+, never remove):
 *   requestId          — opaque correlation id, monotonically increasing
 *   timestamp          — ISO8601 of decision start
 *   pluginVersion      — e.g. "0.3.0-alpha.1"
 *   requestedModel     — null in alpha.1 (not in event shape; v0.4 work)
 *   requestedProvider  — null in alpha.1 (same)
 *   capabilityNeeds    — derived heuristically from event (e.g. ["vision"])
 *   selectedModel      — model emitted as override, or null
 *   selectedProvider   — provider emitted as override, or null
 *   selectionReason    — "passthrough" | "configured" | "intelligence" | "pin" | "fallback"
 *                        ("pin" added in v0.4.0-beta — substrate 4.2 owner-defined skill pins.
 *                         Set when a pin matches AND its model resolves; details.pin_matched
 *                         carries the pin name and details.pin_resolution = "honored". When
 *                         a pin matches but its model fails reachability checks, the request
 *                         falls through to "intelligence" with details.pin_resolution =
 *                         "failover_*" so the operator can see the pin couldn't fire.)
 *   selectionDetails   — free-form object for reason-specific context
 *   mode               — effective mode after resolution (NOT configured mode)
 *   durationMs         — total time in interceptor (filled by finalize)
 */

let counter = 0;

export function newDecision({ event, mode, version }) {
  return {
    requestId: generateRequestId(),
    timestamp: new Date().toISOString(),
    pluginVersion: version,
    requestedModel: null,
    requestedProvider: null,
    capabilityNeeds: deriveCapabilityNeeds(event),
    selectedModel: null,
    selectedProvider: null,
    selectionReason: "passthrough",
    selectionDetails: {},
    mode,
    durationMs: 0,
    _startedAt: Date.now(),
  };
}

export function finalizeDecision(decision) {
  decision.durationMs = Date.now() - decision._startedAt;
  delete decision._startedAt;
  return decision;
}

function deriveCapabilityNeeds(event) {
  const needs = [];
  if (event?.attachments) {
    needs.push("attachments");
    const list = Array.isArray(event.attachments)
      ? event.attachments
      : [event.attachments];
    if (list.some(isImageAttachment)) needs.push("vision");
  }
  return needs;
}

function isImageAttachment(att) {
  if (!att || typeof att !== "object") return false;
  const mime = String(
    att.mimeType ?? att.mime ?? att.contentType ?? ""
  ).toLowerCase();
  return mime.startsWith("image/");
}

function generateRequestId() {
  counter = (counter + 1) & 0xffffffff;
  return `tl-${Date.now().toString(36)}-${counter.toString(36)}`;
}
