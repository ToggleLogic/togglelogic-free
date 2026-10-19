/*
 * ToggleLogic (Free Tier) — Decision API v1 wire request to the core's DecisionRequest.
 * (c) 2026 Motherboard, Inc. Source-available under the ToggleLogic Free-Tier
 * License (see LICENSE); all rights reserved.
 * PATENT PENDING.
 */

/**
 * Maps a `togglelogic.decision/v1` request (docs/design/schemas/
 * decision-request.v1.schema.json) to the DecisionRequest `decide()` takes.
 *
 * - `candidates[].ref` becomes the allowlist of refs; `fallbacks` stay in order.
 * - `requested.ref` is split into provider/model at the first "/".
 * - `work.label` is the host-supplied task label for configured routes. It
 *   travels in the transitional `host.context.taskType` slot until mode
 *   dispatch takes request fields (M1, Free 2.3.0).
 * - `hostSignals.unavailableProviders` is returned as a set so the caller can
 *   compose it into the availability service.
 * - `content` is never copied. The Free core does not read, log or audit it.
 */
import { DECISION_API_VERSION } from "./decide.js";

function split(ref) {
  if (typeof ref !== "string" || !ref.includes("/")) return { ref: null, provider: null, model: null };
  const i = ref.indexOf("/");
  return { ref, provider: ref.slice(0, i), model: ref.slice(i + 1) };
}

export function fromWireRequest(wire) {
  if (!wire || typeof wire !== "object") throw new TypeError("Decision request must be an object");
  if (wire.apiVersion !== DECISION_API_VERSION) throw new TypeError(`Unsupported apiVersion; expected ${DECISION_API_VERSION}`);
  if (!Array.isArray(wire.candidates)) throw new TypeError("Decision request needs a candidates array");
  const requested = wire.requested
    ? { ...split(wire.requested.ref), source: wire.requested.source ?? "none" }
    : { ref: null, provider: null, model: null, source: "none" };
  const label = typeof wire.work?.label === "string" && wire.work.label.trim() ? wire.work.label.trim() : null;
  return {
    request: {
      apiVersion: DECISION_API_VERSION,
      requestId: wire.requestId ?? null,
      agent: null,
      defaultRef: typeof wire.defaultRef === "string" ? wire.defaultRef : null,
      requested,
      candidates: wire.candidates.map((c) => c?.ref).filter((ref) => typeof ref === "string"),
      fallbacks: Array.isArray(wire.fallbacks) ? wire.fallbacks.filter((ref) => typeof ref === "string") : [],
      ...(wire.usageEstimate ? { usageEstimate: { inputTokens: wire.usageEstimate.inputTokens, outputTokens: wire.usageEstimate.outputTokens } } : {}),
      host: { event: {}, context: label ? { taskType: label } : {} },
    },
    unavailableProviders: new Set(Array.isArray(wire.hostSignals?.unavailableProviders) ? wire.hostSignals.unavailableProviders : []),
  };
}
