/*
 * ToggleLogic (Free Tier) — routing modes.
 * (c) 2026 Motherboard, Inc. Source-available under the ToggleLogic Free-Tier
 * License (see LICENSE). PATENT PENDING.
 *
 * Modes:
 *   passthrough   — log only; defer every selection to the OpenClaw default.
 *   configured    — apply static configuredRoutes mapping; passthrough on miss.
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
    if (seamStatus === "available") return "intelligence";
    return cheapConfigured(config) ? "cheap" : "passthrough";
  }
  // 'auto' or anything unrecognized: prefer the licensed intelligence layer if
  // it's available; otherwise fall back to the dumb cheap default (if the
  // deployment declared one), else passthrough.
  if (seamStatus === "available") return "intelligence";
  return cheapConfigured(config) ? "cheap" : "passthrough";
}

function cheapConfigured(config) {
  return Boolean(pickCheapDefault(config && config.cheapHeuristic));
}

export async function dispatchByMode({ mode, event, hookContext, config, seam }) {
  switch (mode) {
    case "passthrough":
      return passthroughResult();

    case "configured": {
      const route = pickConfiguredRoute(config.configuredRoutes);
      if (!route) return passthroughResult({ reason: "no configured match" });
      return {
        override: { modelOverride: route.modelId },
        selectedModel: route.modelId,
        selectedProvider: null,
        selectionReason: "configured",
        selectionDetails: { matchedKey: route.key },
      };
    }

    case "cheap": {
      // Dumb static default — no request inspection, no registry, no classifier.
      const route = pickCheapDefault(config.cheapHeuristic);
      if (!route) return passthroughResult({ reason: "no cheap default configured" });
      return {
        override: { modelOverride: route.modelId },
        selectedModel: route.modelId,
        selectedProvider: null,
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
 * Static configuredRoutes lookup. alpha: single 'default' key applied to every
 * request. (Channel/capability-scoped matching may extend this later without
 * changing dispatchByMode's return shape.)
 */
function pickConfiguredRoute(configuredRoutes) {
  const modelId = configuredRoutes?.default;
  if (typeof modelId === "string" && modelId.length > 0) {
    return { key: "default", modelId };
  }
  return null;
}
