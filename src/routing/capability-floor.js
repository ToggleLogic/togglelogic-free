/*
 * ToggleLogic (Free Tier) — generic work-class capability floor evaluator.
 * (c) 2026 Motherboard, Inc. Source-available under the ToggleLogic Free-Tier
 * License (see LICENSE); all rights reserved.
 * PATENT PENDING.
 */

/**
 * Evaluates a work class's capability floor over its ordered route (Free 2.4.0,
 * D60). Walks `route` in order and returns the FIRST member that is, together:
 *   (i)  resolvable  — a `family:<lineage>` resolves (via the injected resolver)
 *                      to a configured+allowed member; a `provider/model` passes
 *                      through as-is.
 *   (ii) reachable   — its provider is not currently marked unavailable.
 *   (iii) capable    — it satisfies every required capability token, certified by
 *                      the licensed seam when present, else by the deployment's
 *                      declared `capabilities` DATA map.
 *   (iv) in budget   — when the work class declares a `latencyBudgetMs`, the
 *                      member's observed (seam) or declared (config) p95 ≤ budget.
 *
 * Local-first falls out of route ORDER: a deployment lists its local family
 * first, a cheap hosted family after it, so a reachable+capable+fast local member
 * wins and a slow local one is skipped to the hosted fallback.
 *
 * LOUD-FAIL CONTRACT: when no member qualifies — including when NEITHER the seam
 * NOR the config map can answer the floor — the result is `{ ok: false }` with a
 * per-member `excluded` ledger and a reason. The caller turns this into a loud
 * `work_class_floor_unmet` passthrough and NEVER silently routes capability-gated
 * work (e.g. forced-JSON) to a non-capable family.
 *
 * The evaluator is SYNCHRONOUS and reads only pre-resolved/declared data: no
 * catalog fetch and no reachability probe on the hot path (the latency budget it
 * enforces would be meaningless if the check itself blocked).
 *
 * No model names, prices or integration-specific identifiers appear here — tokens,
 * families and latencies are opaque values supplied by config DATA or the seam.
 *
 * @param {object} args
 * @param {{requires:string[], route:string[], latencyBudgetMs:(number|null)}} args.workClass
 * @param {{capabilities?:object, familyLatencyMs?:object}} args.config
 * @param {(family:string, agent?:string)=>({child?:string, reason?:string}|null)} [args.familyResolver]
 * @param {{unavailable?:(provider:string)=>boolean}} [args.availability]
 * @param {(query:{ref:string, requires:string[], latencyBudgetMs:(number|null)})=>({capabilities?:string[], p95Ms?:number}|null)} [args.capabilityQuery]
 * @param {string} [args.agent]
 */
export function evaluateWorkClassFloor({ workClass, config = {}, familyResolver = null, availability = null, capabilityQuery = null, agent = undefined } = {}) {
  const requires = Array.isArray(workClass?.requires) ? workClass.requires : [];
  const budget = Number.isFinite(workClass?.latencyBudgetMs) ? workClass.latencyBudgetMs : null;
  const route = Array.isArray(workClass?.route) ? workClass.route : [];
  const excluded = [];

  for (const member of route) {
    let ref = member;
    let family = null;
    if (member.startsWith("family:")) {
      family = member.slice("family:".length);
      const resolved = typeof familyResolver === "function" ? familyResolver(family, agent) : null;
      if (!resolved || !resolved.child) {
        excluded.push({ member, reason: "family_unresolved", resolutionReason: resolved?.reason ?? "no-configured-child" });
        continue;
      }
      ref = resolved.child;
    }
    const provider = ref.includes("/") ? ref.slice(0, ref.indexOf("/")) : ref;
    if (availability?.unavailable?.(provider)) {
      excluded.push({ member, ref, reason: "unreachable" });
      continue;
    }
    const verdict = certify({ ref, family, member, requires, budget, config, capabilityQuery });
    if (verdict.ok) {
      return { ok: true, ref, member, family, basis: verdict.basis, p95Ms: verdict.p95Ms ?? null, excluded };
    }
    excluded.push({ member, ref, reason: verdict.reason });
  }

  return { ok: false, reason: "work_class_floor_unmet", requires, latencyBudgetMs: budget, excluded };
}

// Certify one candidate ref against the required capability tokens and the
// latency budget. The licensed seam (Intelligence present) is authoritative; the
// deployment-declared config DATA is the Intelligence-absent fallback. When
// NEITHER can answer, returns a loud `no_capability_data` so the member is
// excluded rather than assumed capable.
function certify({ ref, family, member, requires, budget, config, capabilityQuery }) {
  const memberKeys = family ? [member, ref, `family:${family}`] : [member, ref];

  // 1. Licensed seam — observed capabilities + p95 for this box.
  const seamVerdict = typeof capabilityQuery === "function"
    ? safeQuery(capabilityQuery, { ref, requires, latencyBudgetMs: budget })
    : null;
  if (seamVerdict) {
    const caps = Array.isArray(seamVerdict.capabilities) ? seamVerdict.capabilities : [];
    if (!requires.every((token) => caps.includes(token))) return { ok: false, reason: "capability_floor_unmet" };
    const p95 = Number.isFinite(seamVerdict.p95Ms) ? seamVerdict.p95Ms : null;
    const latency = checkLatency(budget, p95);
    return latency.ok ? { ok: true, basis: "intelligence_seam", p95Ms: p95 } : latency;
  }

  // 2. Config fallback — deployment-declared capability + latency DATA.
  const capabilities = config?.capabilities ?? {};
  const latencyMap = config?.familyLatencyMs ?? {};
  // Loud-fail when NEITHER source can answer the required tokens at all.
  const hasData = requires.length === 0 || requires.some((token) => Array.isArray(capabilities[token]));
  if (!hasData) return { ok: false, reason: "no_capability_data" };
  const capable = requires.every((token) => (capabilities[token] ?? []).some((m) => memberKeys.includes(m)));
  if (!capable) return { ok: false, reason: "capability_floor_unmet" };
  const declaredP95 = memberKeys.map((key) => latencyMap[key]).find((value) => Number.isFinite(value));
  const p95 = Number.isFinite(declaredP95) ? declaredP95 : null;
  const latency = checkLatency(budget, p95);
  return latency.ok ? { ok: true, basis: "config_capabilities", p95Ms: p95 } : latency;
}

function checkLatency(budget, p95) {
  if (budget == null) return { ok: true };
  if (p95 == null) return { ok: false, reason: "latency_unknown" };
  if (p95 > budget) return { ok: false, reason: "latency_budget_exceeded" };
  return { ok: true };
}

function safeQuery(capabilityQuery, query) {
  try { return capabilityQuery(query); } catch { return null; }
}
