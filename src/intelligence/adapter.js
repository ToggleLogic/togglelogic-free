/*
 * ToggleLogic (Free Tier) — model-routing plugin for OpenClaw.
 * (c) 2026 Motherboard, Inc. Source-available under the ToggleLogic Free-Tier
 * License (see LICENSE): free, limited, REVOCABLE use; all rights reserved.
 * PATENT PENDING. The benchmark Intelligence engine + Toggle Registry are NOT
 * in this package.
 */

/**
 * THE LICENSE BOUNDARY.
 *
 * This adapter is the ONLY file in the plugin that imports from the
 * licensed ToggleLogic Intelligence layer at ~/togglelogic-intelligence/.
 * The seam (./seam.js) loads this file lazily — only after detection
 * succeeds — so a customer with the open-source plugin alone never
 * imports any licensed code.
 *
 * v0.3.0-alpha.1: STUB. Detection succeeds, adapter loads, but classify()
 *                 always returns null (decline). This proves the lazy
 *                 import works, the state machine transitions correctly,
 *                 and v0.3.1 only needs to flip the classify() body —
 *                 no architectural refactor.
 *
 * v0.3.1: Real classifier wiring. The TODO block below shows the shape
 *         of the import and the call. Until then we run in shadow mode:
 *         the seam reports 'available', requests are logged with mode
 *         'intelligence', but no overrides are emitted.
 */

export async function createAdapter({
  intelligencePath,
  version,
  fallbackLogger,
}) {
  let classifyFn = null;
  try {
    const classifierUrl = new URL(
      "file://" + intelligencePath + "/src/classifier.js"
    ).href;
    const mod = await import(classifierUrl);
    classifyFn = mod.classify;
  } catch (err) {
    try {
      fallbackLogger?.warn?.(
        `togglelogic adapter: failed to load classifier at ` +
        `${intelligencePath}/src/classifier.js: ${err?.message ?? err}`
      );
    } catch (_) {
      /* ignore logger failures */
    }
  }

  try {
    fallbackLogger?.info?.(
      classifyFn !== null
        ? `togglelogic adapter: classifier wired (v${version}). Overrides will be emitted when the classifier matches a non-default tier.`
        : `togglelogic adapter: classifier load FAILED at ${intelligencePath}. Operating in shadow mode (no overrides emitted).`
    );
  } catch {
    /* ignore logger failures */
  }

  /**
   * Returns: { modelOverride?, providerOverride?, details? } or null.
   * Returning null means "decline to choose" — seam will passthrough.
   */
  async function classify(request, runtimeConfig) {
    if (classifyFn === null) return null;

    const prompt = request?.prompt;
    if (typeof prompt !== "string" || prompt.length === 0) return null;

    try {
      // Pass the host-fed execution-surface context (from api.config) so the
      // classifier can resolve each lane's runtime/surface. Optional: the engine
      // falls back to documented defaults when no context is supplied.
      const context = runtimeConfig ? { runtimeConfig } : undefined;
      const result = classifyFn(prompt, context);
      if (!result.recommended_model_ref) return null;
      const ref = result.recommended_model_ref;
      const slash = ref.indexOf("/");
      const override = slash > 0 && slash < ref.length - 1
        ? { providerOverride: ref.slice(0, slash), modelOverride: ref.slice(slash + 1) }
        : { modelOverride: ref };
      // Surface pin metadata so the routing log captures pin_matched /
      // pin_resolution. Both are null in the no-pin path.
      return {
        ...override,
        details: {
          required_tier: result.required_tier,
          confidence: result.confidence,
          matched_rule: result.matched_rule,
          reasoning: result.reasoning,
          pin_matched: result.pin_matched ?? null,
          pin_resolution: result.pin_resolution ?? null,
        },
      };
    } catch (err) {
      try {
        fallbackLogger?.warn?.(
          `togglelogic adapter: classifier threw on prompt: ${err?.message ?? err}`
        );
      } catch (_) {
        /* ignore logger failures */
      }
      return null;
    }
  }

  return {
    classify,
    version,
    isStub: classifyFn === null,
  };
}
