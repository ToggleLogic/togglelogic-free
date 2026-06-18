/*
 * ToggleLogic (Free Tier) — the intelligence SEAM.
 * (c) 2026 Motherboard, Inc. Source-available under the ToggleLogic Free-Tier
 * License (see LICENSE). PATENT PENDING.
 *
 * The interface boundary between this free plugin and an OPTIONAL,
 * separately-licensed ToggleLogic Intelligence layer. This file MUST NOT import
 * directly from the licensed layer — only ./adapter.js does, and it is loaded
 * LAZILY via dynamic import, only after detection succeeds. A user with the
 * plugin alone never loads adapter.js, never imports the licensed layer, and
 * classify() always returns null (passthrough). No benchmark engine or registry
 * ships in this package.
 *
 * State: 'detecting' -> detect() -> 'available' (adapter loaded) | 'absent';
 *        'disabled' when intelligence.enabled === false.
 */

import { detectIntelligenceLayer } from "./detector.js";

export function createIntelligenceSeam(intelligenceConfig, fallbackLogger, hostRuntimeConfig = null) {
  const config = intelligenceConfig ?? {};
  const enabled = config.enabled !== false;

  let state = enabled ? "detecting" : "disabled";
  let adapter = null;
  let detectionError = null;
  let detectionResult = null;

  async function detect() {
    if (!enabled) return;
    try {
      // registryPath is config-driven (deployment DATA); detector defaults to a
      // path relative to the layer when unset. No workspace path hardcoded.
      const result = await detectIntelligenceLayer(config.path, config.registryPath);
      detectionResult = result;

      if (result.present) {
        // LAZY DYNAMIC IMPORT — the only line in the seam that touches
        // adapter.js, and adapter.js is the only file that imports from the
        // licensed layer.
        const { createAdapter } = await import("./adapter.js");
        adapter = await createAdapter({
          intelligencePath: result.resolvedPath,
          version: result.version,
          fallbackLogger,
        });
        state = "available";
        try {
          fallbackLogger?.info?.(
            `togglelogic seam: intelligence layer available (v${result.version}).`
          );
        } catch { /* ignore */ }
      } else {
        state = "absent";
        try {
          fallbackLogger?.info?.(
            `togglelogic seam: intelligence layer absent (${result.reason}). ` +
              `Plugin will operate in passthrough/configured/cheap modes.`
          );
        } catch { /* ignore */ }
      }
    } catch (err) {
      detectionError = err;
      state = "absent";
      throw err;
    }
  }

  function status() {
    return state;
  }

  /**
   * Returns { modelOverride?, providerOverride?, details? } or null. null means
   * "decline to choose" — the interceptor falls back to passthrough.
   */
  async function classify(request) {
    if (state !== "available" || !adapter) return null;
    return adapter.classify(request, hostRuntimeConfig);
  }

  function info() {
    return {
      state,
      detectionResult,
      error: detectionError ? String(detectionError.message ?? detectionError) : null,
    };
  }

  return { detect, status, classify, info };
}
