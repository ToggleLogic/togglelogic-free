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

const PASSTHROUGH = Object.freeze({});

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

export async function dispatchByMode({ mode, event, hookContext, config, seam, familyResolver, configuredProviders = [] }) {
  switch (mode) {
    case "passthrough":
      return passthroughResult();

    case "configured": {
      const route = pickConfiguredRoute(config.configuredRoutes, event, hookContext);
      if (!route) return passthroughResult({ reason: "no configured match" });
      if (route.modelId.startsWith("family:")) {
        const alias = route.modelId.slice("family:".length);
        const resolved = familyResolver?.resolve(alias, configuredProviders);
        if (!resolved) {
          return passthroughResult({ reason: "family route unresolved", matchedKey: route.key, familyAlias: alias });
        }
        return {
          override: { modelOverride: resolved.modelId, providerOverride: resolved.provider },
          selectedModel: `${resolved.provider}/${resolved.modelId}`,
          selectedProvider: resolved.provider,
          selectionReason: "configured_family",
          selectionDetails: {
            matchedKey: route.key,
            familyAlias: alias,
            strategy: config.familyResolution.aliases[alias]?.strategy ?? "lowest_cost",
            priceSource: "deployment-cached-models.dev",
          },
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

function configuredTaskLabel(event, hookContext) {
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
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return null;
}
