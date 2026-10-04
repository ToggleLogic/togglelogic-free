/*
 * ToggleLogic (Free Tier) — generic configured-model lineage resolution.
 * (c) 2026 Motherboard, Inc. Source-available under the ToggleLogic Free-Tier
 * License (see LICENSE); all rights reserved.
 * PATENT PENDING.
 */

import { deriveLineage } from "./lineage.js";
import { hostFallbacks } from "../usage/provider-refusal.js";
import { EVENTS } from "../audit/audit-events.js";

export function validLineage(value) {
  if (typeof value !== "string" || value.length > 512) return false;
  if (/^[a-z0-9][a-z0-9._-]*\/\*$/.test(value)) return true;
  return deriveLineage(value).lineage === value;
}

export function configuredModels(hostConfig = {}, agentId) {
  // A declared allowlist is authoritative, including models supplied by core's
  // catalog. Never expand it with every model from the public pricing feed.
  const allowlist = Object.keys(hostConfig.agents?.defaults?.models ?? {});
  if (allowlist.length) return allowlist.filter((ref) => deriveLineage(ref).lineage !== null);
  const refs = [];
  for (const [provider, entry] of Object.entries(hostConfig.models?.providers ?? {})) {
    for (const model of entry.models ?? []) if (typeof model.id === "string") refs.push(`${provider}/${model.id}`);
  }
  const agent = hostConfig.agents?.list?.find((value) => value.id === agentId);
  const model = agent?.model ?? hostConfig.agents?.defaults?.model;
  const primary = typeof model === "string" ? model : model?.primary;
  if (primary) refs.push(primary);
  refs.push(...hostFallbacks(hostConfig, agentId));
  return [...new Set(refs)].filter((ref) => deriveLineage(ref).lineage !== null);
}

const matches = (lineage, ref) => lineage.endsWith("/*")
  ? ref.startsWith(lineage.slice(0, -1)) : deriveLineage(ref).lineage === lineage;
const validDate = (date) => typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date) &&
  Number.isFinite(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date;

export function resolveLineage({ lineage, allowedModels = [], catalog = [], unavailable = () => false }) {
  if (!validLineage(lineage)) return { lineage, child: null, reason: "invalid-lineage" };
  if (unavailable(lineage.split("/")[0])) return { lineage, child: null, reason: "provider-unavailable" };
  const allowed = new Set(allowedModels);
  const candidates = catalog.filter((row) => allowed.has(row.ref) && matches(lineage, row.ref) && validDate(row.releaseDate));
  candidates.sort((a, b) => b.releaseDate.localeCompare(a.releaseDate) || (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
  return { lineage, child: candidates[0]?.ref ?? null, reason: candidates.length ? "newest-configured-release" : "no-configured-dated-child" };
}

export function createLineageResolver({ lineages = [], hostConfig, pricing, availability } = {}) {
  return async (agentId) => {
    const catalog = await pricing.catalog();
    const allowedModels = configuredModels(hostConfig, agentId);
    const skipped = [];
    for (const lineage of lineages) {
      const result = resolveLineage({ lineage, allowedModels, catalog, unavailable: (provider) => availability?.unavailable(provider) ?? false });
      if (result.child) return { ...result, skipped };
      skipped.push(result);
    }
    const error = new Error("ToggleLogic: no available configured fallback lineage can be resolved");
    error.code = "FALLBACK_LINEAGE_UNRESOLVED";
    error.skipped = skipped;
    throw error;
  };
}

export function auditFallbackPlan({ hostConfig, lineages = [], audit, logger } = {}) {
  const ids = [undefined, ...(hostConfig?.agents?.list ?? []).map((a) => a.id)];
  const fallbacks = [...new Set(ids.flatMap((id) => hostFallbacks(hostConfig, id)))];
  const missing = fallbacks.filter((ref) => {
    const lineage = deriveLineage(ref).lineage;
    return lineage && lineage !== ref && !lineages.some((entry) => validLineage(entry) && matches(entry, ref));
  });
  const invalid = lineages.filter((entry) => !validLineage(entry));
  const warning = missing.length > 0 || invalid.length > 0;
  audit?.emit?.({ event: EVENTS.FALLBACK_PLAN_CHECK, outcome: warning ? "failure" : "success", principal: { source: "plugin" },
    details: { numberedFallbacksWithoutLineage: missing, invalidLineages: invalid, status: warning ? "warning" : "ok" } });
  if (warning) logger?.warn?.("ToggleLogic FALLBACK_PLAN_CHECK: configure fallback lineages; numbered host fallbacks lack matching lineage entries or the plan is invalid");
  return { missing, invalid };
}
