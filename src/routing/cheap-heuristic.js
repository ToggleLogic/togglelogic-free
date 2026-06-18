/*
 * ToggleLogic (Free Tier) — simple cheapest-default heuristic.
 * (c) 2026 Motherboard, Inc. Source-available under the ToggleLogic Free-Tier
 * License (see LICENSE). PATENT PENDING.
 *
 * WHAT THIS IS — and deliberately is NOT.
 *
 * This is a DUMB static default: "prefer the cheap model the deployment names,
 * unless something higher-priority says otherwise." It is intentionally trivial.
 *
 * It does NOT, and must never:
 *   - look at the request at all (it is REQUEST-AGNOSTIC — it never reads the
 *     prompt, attachments, or any per-request feature);
 *   - consult the Toggle Registry or ANY model/benchmark/cost dataset;
 *   - classify the request into a capability tier;
 *   - rank or score models, or compute "cheapest capable" from data.
 *
 * Those behaviors are the patented "ToggleLogic Intelligence" engine (Dynamic
 * Model Determination: classify request -> tier -> registry cost-optimize),
 * which lives in a SEPARATELY-LICENSED layer and is NOT part of this package.
 * This heuristic embeds NO model names, NO prices, and NO capability data: the
 * "cheap" choice is entirely whatever the DEPLOYMENT declares in config. The
 * user teaches real preferences through the owner-override loop (which sits
 * ABOVE this in the interceptor); this only supplies a default when nothing
 * else applies.
 */

/**
 * Pick the deployment-declared cheap default.
 *
 * Accepts either:
 *   cheapHeuristic.default : "<model ref>"            (a single declared default)
 *   cheapHeuristic.order   : ["<cheapest>", ...]      (cheapest-first; we take [0])
 *
 * The ordering is the DEPLOYMENT's declaration of which of ITS models is the
 * cheap one — this function does not know or compute relative cost. Returns
 * { key, modelId } or null (caller passes through to the gateway default).
 */
export function pickCheapDefault(cheapHeuristic) {
  if (!cheapHeuristic || typeof cheapHeuristic !== "object") return null;

  const order = Array.isArray(cheapHeuristic.order) ? cheapHeuristic.order : null;
  if (order && typeof order[0] === "string" && order[0].length > 0) {
    return { key: "cheap_default", modelId: order[0] };
  }

  const def = cheapHeuristic.default;
  if (typeof def === "string" && def.length > 0) {
    return { key: "cheap_default", modelId: def };
  }

  return null;
}
