/*
 * ToggleLogic (Free Tier) — durable runtime-state refresh ORCHESTRATOR.
 * (c) 2026 Motherboard, Inc. Source-available under the ToggleLogic Free-Tier
 * License (see LICENSE). PATENT PENDING.
 *
 * The versioned skill-inventory snapshot expires after 24h and the cloud-spend
 * snapshot after ~26h, but the generators are deploy-time only. This module is the
 * durable, conservative runtime-state refresh STAGE that an existing scheduled job
 * (e.g. the 4 AM registry refresh) can call AFTER a managed install to keep both
 * snapshots current — WITHOUT baking a development path into production.
 *
 * It is a PURE sequencer: it runs an ordered list of named stages, STOPS at the
 * first failure (fail closed), records every stage in a structured sentinel, and
 * runs a cleanup hook so a failed run leaves the previous good snapshots untouched
 * (the pair is committed only when BOTH new snapshots validate). The script
 * (scripts/togglelogic-runtime-refresh.mjs) supplies the real stage implementations
 * — plugin-present, feature-enabled, compatible-pair, inventory-generated,
 * spend-generated (which fails closed on malformed usage JSON, a stale/wrong month,
 * or unpriced CLOUD spend), then atomic pair-commit.
 *
 * NEVER throws. A stage that throws is recorded as failed, not propagated.
 */

export const RUNTIME_REFRESH_SENTINEL_SCHEMA = "togglelogic_runtime_refresh_sentinel/v1";

/**
 * A current-month cumulative spend snapshot must never move backwards. OpenClaw's
 * usage cache can briefly report zero while the gateway is starting; accepting
 * that transient value would incorrectly reopen cloud headroom. A new policy
 * month may start lower and is therefore allowed.
 */
export function checkSpendNonRegression(previous, next) {
  if (!previous || typeof previous !== "object") return { ok: true };
  if (!next || typeof next !== "object") return { ok: false, error: "generated spend snapshot is missing" };
  if (previous.policy_month !== next.policy_month) return { ok: true };
  const before = previous.month_to_date_cost_usd;
  const after = next.month_to_date_cost_usd;
  if (!Number.isFinite(before) || !Number.isFinite(after)) {
    return { ok: false, error: "same-month spend values must be finite" };
  }
  if (after + 1e-9 < before) {
    return { ok: false, error: `same-month cloud spend regressed from ${before} to ${after}` };
  }
  return { ok: true };
}

/**
 * Run the ordered stages. Each stage is { name, run } where run() returns
 * { ok:boolean, detail? } (sync or async). Fails closed: once a stage fails, the
 * rest are recorded as "skipped" and never executed.
 *
 * Options: { now, onCleanup(overall) }. Returns the sentinel object.
 */
export async function runRuntimeRefresh(stages, options = {}) {
  const now = typeof options.now === "function" ? options.now : () => Date.now();
  const startedAtMs = now();
  const results = [];
  let overall = "success";
  const failedStages = [];

  for (const stage of Array.isArray(stages) ? stages : []) {
    const name = stage && typeof stage.name === "string" ? stage.name : "unnamed";
    if (overall !== "success") {
      results.push({ name, status: "skipped" });
      continue;
    }
    let r;
    try {
      r = typeof stage?.run === "function" ? await stage.run() : { ok: false, detail: { error: "stage has no run()" } };
    } catch (error) {
      r = { ok: false, detail: { error: String(error?.message ?? error).slice(0, 512) } };
    }
    const status = r && r.ok ? "ok" : "failed";
    results.push({ name, status, ...(r && r.detail ? { detail: r.detail } : {}) });
    if (status !== "ok") { overall = "failure"; failedStages.push(name); }
  }

  if (typeof options.onCleanup === "function") {
    try { await options.onCleanup(overall); } catch { /* cleanup is best-effort */ }
  }

  const finishedAtMs = now();
  return {
    schema: RUNTIME_REFRESH_SENTINEL_SCHEMA,
    overall,
    failed_stages: failedStages,
    started_at: new Date(startedAtMs).toISOString(),
    finished_at: new Date(finishedAtMs).toISOString(),
    duration_ms: finishedAtMs - startedAtMs,
    stages: results,
  };
}

/**
 * Compatible-pair check: is `freeVersion` a validated pair for the installed
 * Intelligence build described by its release manifest? Mirrors the Intelligence
 * repo's verify_plugin_pair gate (release-state parity + validated_versions
 * membership) so the refresh stage refuses to publish snapshots for an
 * incompatible pair. Pure; never throws.
 */
export function checkCompatiblePair(freeVersion, intelligenceManifest) {
  const errors = [];
  const free = typeof freeVersion === "string" ? freeVersion.trim() : "";
  if (!free) errors.push("free version is missing");
  const manifest = intelligenceManifest && typeof intelligenceManifest === "object" ? intelligenceManifest : null;
  if (!manifest) {
    errors.push("intelligence release manifest is missing/unreadable");
    return { ok: false, errors };
  }
  const freeIsRc = /-rc\.\d+$/.test(free);
  const intelIsRc = manifest.release_state === "release_candidate";
  if (freeIsRc !== intelIsRc) {
    errors.push(`release-state mismatch: Free ${free} (${freeIsRc ? "rc" : "released"}) vs Intelligence ${JSON.stringify(manifest.version)} (${intelIsRc ? "rc" : "released"})`);
  }
  const validated = Array.isArray(manifest.plugin_compatibility?.validated_versions)
    ? manifest.plugin_compatibility.validated_versions : [];
  if (!validated.includes(free)) {
    errors.push(`Free ${free} is not in Intelligence validated_versions [${validated.join(", ")}]`);
  }
  return { ok: errors.length === 0, errors, intelligenceVersion: manifest.version || null, validated };
}
