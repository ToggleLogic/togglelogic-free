/*
 * ToggleLogic (Free Tier) — routing modes.
 * (c) 2026 Motherboard, Inc. Source-available under the ToggleLogic Free-Tier
 * License (see LICENSE). PATENT PENDING.
 *
 * Modes:
 *   passthrough   — log only; defer every selection to the OpenClaw default.
 *   configured    — apply a static, host-supplied task-label route; passthrough
 *                   on a label miss.  This mode never reads or classifies a
 *                   prompt.
 *   cheap         — apply the deployment-declared cheap default (dumb, static,
 *                   request-agnostic; see cheap-heuristic.js). passthrough if
 *                   no cheap default is configured.
 *   intelligence  — defer to a SEPARATELY-LICENSED Intelligence layer via the
 *                   seam (no engine ships here; seam is a no-op stub without it).
 *   auto (input)  — intelligence if the licensed seam is 'available', else the
 *                   cheap default if one is configured, else passthrough.
 *
 * resolveEffectiveMode collapses 'auto' to a concrete mode. dispatchByMode does
 * the per-mode work. No I/O, no mutation (modulo seam.classify in intelligence).
 */

import { pickCheapDefault } from "./cheap-heuristic.js";
import { evaluateWorkClassFloor } from "./capability-floor.js";

const PASSTHROUGH = Object.freeze({});

/**
 * Canonical task-label normalization (M6 §3.5): lowercase + trim. The IDENTICAL
 * rule is applied to the incoming host task label (configuredTaskLabel, below)
 * and to the stored configuredRoutes keys and CLI pin scopes, so a pin or route
 * for `Inventory-Sync` matches a turn labelled `inventory-sync`. Returns "" for
 * a non-string or blank value.
 */
export function normalizeLabel(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function resolveEffectiveMode(configuredMode, seamStatus, config) {
  if (configuredMode === "passthrough") return "passthrough";
  if (configuredMode === "configured") return "configured";
  if (configuredMode === "cheap") return "cheap";
  if (configuredMode === "intelligence") {
    if (seamStatus === "available" || seamStatus === "detecting") return "intelligence";
    // An explicit Intelligence selection is an operator contract, not a hint.
    // Do not silently downgrade to cheap routing: retain a visible, auditable
    // unavailable state and let the host choose its normal model.
    return "intelligence_unavailable";
  }
  // 'auto' or anything unrecognized: prefer the licensed intelligence layer if
  // it's available; otherwise fall back to the dumb cheap default (if the
  // deployment declared one), else passthrough.
  if (seamStatus === "available" || seamStatus === "detecting") return "intelligence";
  return cheapConfigured(config) ? "cheap" : "passthrough";
}

function cheapConfigured(config) {
  return Boolean(pickCheapDefault(config && config.cheapHeuristic));
}

function overrideForModelRef(modelRef) {
  const slash = typeof modelRef === "string" ? modelRef.indexOf("/") : -1;
  if (slash > 0 && slash < modelRef.length - 1) {
    return {
      modelOverride: modelRef.slice(slash + 1),
      providerOverride: modelRef.slice(0, slash),
    };
  }
  return { modelOverride: modelRef };
}

export async function dispatchByMode({ mode, event, hookContext, config, seam, familyResolver = null, agent = undefined, availability = null }) {
  // Work-class capability floor (Free 2.4.0, D60). When the host task label names
  // a configured work class, it resolves through the capability floor — an ordered
  // route gated by required capabilities and a latency budget — instead of the
  // mode's normal behavior. This overlays EVERY mode and is a no-op when no
  // workClasses are configured (byte-identical to 2.3.0). A floor that no eligible
  // family meets is a LOUD passthrough (`work_class_floor_unmet`), never a silent
  // route to a non-capable family.
  const workClass = resolveWorkClassFor(config, event, hookContext);
  if (workClass) return resolveWorkClass({ label: workClass.label, workClass: workClass.entry, config, seam, familyResolver, agent, availability });

  switch (mode) {
    case "passthrough":
      return passthroughResult();

    case "configured": {
      const route = pickConfiguredRoute(config.configuredRoutes, event, hookContext);
      if (!route) return passthroughResult({ reason: "no configured match" });
      if (route.modelId.startsWith("family:")) {
        // M6 §5.2: resolve a `family:<lineage>` route to the newest configured
        // member via the same resolver a family pin uses. An unresolved family
        // is a loud passthrough (reason carried), never a silent model.
        const lineage = route.modelId.slice("family:".length);
        const resolved = typeof familyResolver === "function" ? familyResolver(lineage, agent) : null;
        if (!resolved || !resolved.child) {
          return passthroughResult({ reason: "family route unresolved", matchedKey: route.key, family: lineage, resolutionReason: resolved?.reason ?? "no-configured-child" });
        }
        const familyOverride = overrideForModelRef(resolved.child);
        return {
          override: familyOverride,
          selectedModel: resolved.child,
          selectedProvider: familyOverride.providerOverride ?? null,
          selectionReason: "configured",
          selectionDetails: { matchedKey: route.key, family: lineage, resolvedChild: resolved.child, resolutionReason: resolved.reason },
        };
      }
      const override = overrideForModelRef(route.modelId);
      return {
        override,
        selectedModel: route.modelId,
        selectedProvider: override.providerOverride ?? null,
        selectionReason: "configured",
        selectionDetails: { matchedKey: route.key },
      };
    }

    case "cheap": {
      // Dumb static default — no request inspection, no registry, no classifier.
      const route = pickCheapDefault(config.cheapHeuristic);
      if (!route) return passthroughResult({ reason: "no cheap default configured" });
      const override = overrideForModelRef(route.modelId);
      return {
        override,
        selectedModel: route.modelId,
        selectedProvider: override.providerOverride ?? null,
        selectionReason: "cheap_default",
        selectionDetails: { matchedKey: route.key },
      };
    }

    case "intelligence": {
      // Defers to a separately-licensed Intelligence layer. Without it the seam
      // is a no-op stub and classify() returns null -> passthrough.
      const choice = await seam.classify({
        prompt: event?.prompt,
        attachments: event?.attachments,
        hookContext,
      });
      if (choice && choice.shadow === true) {
        return {
          override: PASSTHROUGH,
          selectedModel: null,
          selectedProvider: null,
          selectionReason: "intelligence_shadow",
          selectionDetails: choice.details ?? {},
        };
      }
      if (!choice || (!choice.modelOverride && !choice.providerOverride)) {
        return passthroughResult({ reason: "intelligence declined" });
      }
      const pinHonored =
        choice.details &&
        choice.details.pin_matched &&
        choice.details.pin_resolution === "honored";
      return {
        override: {
          ...(choice.modelOverride ? { modelOverride: choice.modelOverride } : {}),
          ...(choice.providerOverride ? { providerOverride: choice.providerOverride } : {}),
        },
        selectedModel: choice.modelOverride ?? null,
        selectedProvider: choice.providerOverride ?? null,
        selectionReason: pinHonored ? "pin" : "intelligence",
        selectionDetails: choice.details ?? {},
      };
    }

    case "intelligence_unavailable":
      return passthroughResult({
        reason: "explicit Intelligence mode unavailable",
        intelligenceStatus: seam.status(),
      });

    default:
      return passthroughResult({ reason: `unknown mode '${mode}'` });
  }
}

function passthroughResult(details = {}) {
  return {
    override: PASSTHROUGH,
    selectedModel: null,
    selectedProvider: null,
    selectionReason: "passthrough",
    selectionDetails: details,
  };
}

// The configured work class for this turn's host task label, or null. Uses the
// identical narrow label fields and normalization as configured routes, so a work
// class keyed `intent_classification` matches a turn labelled the same.
function resolveWorkClassFor(config, event, hookContext) {
  const label = configuredTaskLabel(event, hookContext);
  const entry = label && config?.workClasses ? config.workClasses[label] : null;
  return entry ? { label, entry } : null;
}

// Resolve a work class through the capability floor and shape the dispatch
// result. A met floor routes to the chosen member (`work_class`); an unmet floor
// is a LOUD, distinct passthrough (`work_class_floor_unmet`) the decision core
// surfaces as a failure — it is NOT a silent box default and NOT eligible for the
// integration route hint fallback (that would defeat the floor).
function resolveWorkClass({ label, workClass, config, seam, familyResolver, agent, availability }) {
  const capabilityQuery = seam && typeof seam.queryCapability === "function"
    ? (query) => seam.queryCapability(query)
    : null;
  const floor = evaluateWorkClassFloor({ workClass, config, familyResolver, availability, capabilityQuery, agent });
  if (!floor.ok) {
    return {
      override: PASSTHROUGH,
      selectedModel: null,
      selectedProvider: null,
      selectionReason: "work_class_floor_unmet",
      selectionDetails: { workClass: label, requires: workClass.requires ?? [], latencyBudgetMs: workClass.latencyBudgetMs ?? null, excluded: floor.excluded },
    };
  }
  const override = overrideForModelRef(floor.ref);
  return {
    override,
    selectedModel: floor.ref,
    selectedProvider: override.providerOverride ?? null,
    selectionReason: "work_class",
    selectionDetails: {
      workClass: label,
      resolvedRef: floor.ref,
      member: floor.member,
      ...(floor.family ? { family: floor.family } : {}),
      floorBasis: floor.basis,
      ...(floor.p95Ms != null ? { p95Ms: floor.p95Ms } : {}),
    },
  };
}

/**
 * Static configuredRoutes lookup. The only optional match input is a host-
 * supplied task label. We deliberately never examine event.prompt or arbitrary
 * message text in the Free plugin. A deployment may also set `default` as the
 * final static route.
 */
export function pickConfiguredRoute(configuredRoutes, event = {}, hookContext = {}) {
  const taskKey = configuredTaskLabel(event, hookContext);
  const modelId = taskKey ? configuredRoutes?.[taskKey] : configuredRoutes?.default;
  if (typeof modelId === "string" && modelId.length > 0) {
    return { key: taskKey ?? "default", modelId };
  }
  if (taskKey) {
    const fallback = configuredRoutes?.default;
    if (typeof fallback === "string" && fallback.length > 0) {
      return { key: "default", modelId: fallback, requestedKey: taskKey };
    }
  }
  return null;
}

export function configuredTaskLabel(event, hookContext) {
  // These are documented, structured task labels supplied by the host or
  // integration. Keep the accepted field list narrow so configuration cannot
  // turn this public static mode into hidden prompt classification.
  const candidates = [
    hookContext?.taskType,
    hookContext?.task,
    hookContext?.capability,
    event?.taskType,
    event?.task,
    event?.metadata?.taskType,
  ];
  for (const value of candidates) {
    const normalized = normalizeLabel(value); // M6 §3.5: lowercase + trim
    if (normalized) return normalized;
  }
  return null;
}
