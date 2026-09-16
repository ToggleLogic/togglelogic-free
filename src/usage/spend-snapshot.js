/*
 * ToggleLogic (Free Tier) — deployment-owned CLOUD-SPEND SNAPSHOT.
 * (c) 2026 Motherboard, Inc. Source-available under the ToggleLogic Free-Tier
 * License (see LICENSE). PATENT PENDING.
 *
 * WHY THIS EXISTS (1.6.1-rc.3):
 *   The hardware-equivalent monthly cloud policy compares month-to-date CLOUD
 *   model spend against a finite amortized budget (see docs/ECONOMIC-PROFILE).
 *   Until now that spend was a STATIC configured number (default 0), so the
 *   ceiling was decorative: a deployment past its budget still saw cloud routes
 *   offered. This module makes the spend LIVE and AUTHORITATIVE.
 *
 * THE MODEL (mirrors the skill-inventory snapshot design):
 *   1. A DEPLOYMENT-OWNED generator (scripts/generate-spend-snapshot.mjs) runs
 *      `openclaw gateway usage-cost --all-agents --expect-final --json` at
 *      deploy/refresh time (NEVER on a user turn — the plugin never shells out),
 *      validates it, and writes a versioned + fingerprinted current-month spend
 *      SNAPSHOT to a deployment-owned path.
 *   2. The plugin CONSUMES that snapshot and re-verifies, before trusting a
 *      single dollar: source, plugin pair, policy month, freshness, non-negative
 *      finite total, ZERO unpriced CLOUD rows, and fingerprint integrity.
 *
 * FAIL CLOSED. A missing, malformed, stale, wrong-month, wrong-source,
 * wrong-version, negative/non-finite, unpriced-cloud, or drifted snapshot yields
 * ok:false. The coordinator treats an unavailable spend as budget-exhausted when
 * a finite cloud budget applies (cloud routes are withheld; local-capable routes
 * remain). NEVER throws from the consumer path.
 *
 * LOCAL vs CLOUD missing costs (2026-09-15 policy):
 *   `openclaw gateway usage-cost` reports `missingCostEntries` and
 *   `missingCostByModel` per day and in totals. Missing-cost rows for a LOCAL
 *   provider (Ollama) are EXPECTED — installed local inference is $0 marginal, so
 *   an unpriced local row is benign. Missing-cost rows for a CLOUD provider mean
 *   real spend the source could not price: that understates the total, so it FAILS
 *   CLOSED (we must never route as if under budget on an unknowably-larger spend).
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { resolveOpenClawPath } from "../path-utils.js";

export const SPEND_SNAPSHOT_SCHEMA_VERSION = 1;
export const SPEND_SNAPSHOT_KIND = "togglelogic-cloud-spend-snapshot";
export const SPEND_SNAPSHOT_SOURCE = "openclaw gateway usage-cost --all-agents --expect-final --json";
export const SPEND_SNAPSHOT_GENERATOR = "scripts/generate-spend-snapshot.mjs";
// Daily-cadence freshness with slack for a late/slow refresh run. A snapshot older
// than this fails closed (the refresh job stopped, or the box was asleep).
export const DEFAULT_SPEND_MAX_AGE_MS = 26 * 60 * 60 * 1000;
export const DEFAULT_LOCAL_PROVIDERS = Object.freeze(["ollama"]);
const MAX_SNAPSHOT_BYTES = 1 * 1024 * 1024;
// Bounded tail read for the optional cost-log delta so a large ledger can never
// blow memory on a turn. Rows older than the snapshot's `through` timestamp are
// already counted in the snapshot, so only the tail is relevant.
const DEFAULT_DELTA_MAX_BYTES = 8 * 1024 * 1024;

function cleanString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function round6(n) {
  return Math.round((Number(n) || 0) * 1e6) / 1e6;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

// Canonicalize a provider-name list into a deterministic, deduped, sorted,
// lowercased array so the SAME set always fingerprints/compares identically
// regardless of source ordering or casing.
function canonicalProviders(value) {
  return [...new Set((Array.isArray(value) ? value : [])
    .map((p) => String(p || "").trim().toLowerCase())
    .filter(Boolean))].sort();
}

// Canonicalize a {ref: count} attribution map into a deterministic, key-sorted
// array of [ref, count] pairs so a hand-reordered object can never change the
// fingerprint (or evade it) without altering the trust-bearing content.
function canonicalCountMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value)
    .map(([k, v]) => [String(k), Number.isFinite(Number(v)) ? Number(v) : v])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/**
 * Provider token of a usage model ref — the lowercased segment before the first
 * "/". `ollama/glm4:9b` -> `ollama`; a bare ref with no provider is "" (treated
 * as CLOUD/unknown provenance so an unattributable missing-cost row fails closed).
 */
export function providerTokenOf(ref) {
  const s = String(ref || "").trim().toLowerCase();
  const slash = s.indexOf("/");
  return slash > 0 ? s.slice(0, slash) : "";
}

/**
 * Is a usage model ref a LOCAL (zero marginal cost) provider? Only an explicit,
 * deployment-declared local provider counts; unknown provenance is CLOUD.
 */
export function isLocalRef(ref, localProviders = DEFAULT_LOCAL_PROVIDERS) {
  const set = new Set((Array.isArray(localProviders) ? localProviders : DEFAULT_LOCAL_PROVIDERS)
    .map((p) => String(p || "").trim().toLowerCase())
    .filter(Boolean));
  const token = providerTokenOf(ref);
  return token !== "" && set.has(token);
}

/**
 * Resolve the policy month "YYYY-MM" for an instant in a given IANA timezone.
 * Uses Intl so the owner-local month boundary (not UTC) governs the budget
 * period. Falls back to a UTC slice if the timezone is unusable. Never throws.
 */
export function resolvePolicyMonth(nowMs, timeZone) {
  const ms = Number.isFinite(nowMs) ? nowMs : Date.now();
  const tz = cleanString(timeZone);
  if (tz) {
    try {
      const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit" })
        .formatToParts(new Date(ms));
      const year = parts.find((p) => p.type === "year")?.value;
      const month = parts.find((p) => p.type === "month")?.value;
      if (year && month) return `${year}-${month}`;
    } catch { /* fall through to UTC */ }
  }
  return new Date(ms).toISOString().slice(0, 7);
}

/**
 * Canonical fingerprint over EVERY trust/freshness/routing field of a spend
 * snapshot. Any hand-edit of a dollar amount, month, timestamp (incl.
 * generated_at_ms/generated_at — so freshness can't be forged without drift),
 * provider-classification basis (local_providers), or missing-cost summary
 * (incl. the local attribution map) changes the fingerprint, so tamper/drift
 * fails closed.
 *
 * NOTE ON THREAT MODEL (1.6.1-rc.3): this is a PUBLIC checksum — anyone can
 * recompute it over edited contents, so it is DRIFT/TAMPER-EVIDENCE, not
 * authentication. The authenticity guarantee is the deployment-owned file: the
 * generator writes the snapshot 0600 under a 0700 directory owned by the OpenClaw
 * service identity, and the plugin only ever reads it. See docs/ECONOMIC-PROFILE.md.
 */
export function computeSpendFingerprint(snapshot) {
  const s = snapshot || {};
  const canonical = {
    schema_version: s.schema_version,
    kind: s.kind,
    source: s.source,
    generator: cleanString(s.generator) || "",
    policy_month: s.policy_month,
    timezone: s.timezone,
    plugin_pair: s.plugin_pair && typeof s.plugin_pair === "object"
      ? { free: cleanString(s.plugin_pair.free) || "", intelligence: cleanString(s.plugin_pair.intelligence) || "" }
      : {},
    // Freshness fields — bound so a hand-edit to generated_at_ms (to bypass the
    // staleness check) or to generated_at can never pass the recompute.
    generated_at_ms: s.generated_at_ms,
    generated_at: cleanString(s.generated_at) || null,
    // As-of instant used by the delta lower bound.
    through_ms: s.through_ms,
    through_iso: cleanString(s.through_iso) || null,
    month_to_date_cost_usd: round6(s.month_to_date_cost_usd),
    days_counted: s.days_counted,
    cloud_missing_cost_entries: s.cloud_missing_cost_entries,
    local_missing_cost_entries: s.local_missing_cost_entries,
    // Local missing-cost ATTRIBUTION and the provider-classification basis are
    // trust-bearing (they decide which unpriced rows are benign $0 local), so they
    // are bound too.
    local_missing_cost_by_model: canonicalCountMap(s.local_missing_cost_by_model),
    local_providers: canonicalProviders(s.local_providers),
  };
  return sha256(JSON.stringify(canonical));
}

/**
 * buildSpendSnapshotFromUsageCost — PURE. Turn a parsed `openclaw gateway
 * usage-cost ... --json` object into a validated current-month cloud-spend
 * snapshot, or a fail-closed error list. Does no I/O; stamps time only from the
 * supplied `generatedAtMs`.
 *
 *   options = { generatedAtMs, policyMonth?, timezone, pluginFree,
 *               pluginIntelligence, localProviders }
 *   returns { ok, snapshot?, errors, monthToDateCostUsd?, policyMonth?,
 *             cloudMissing?, localMissing? }
 */
export function buildSpendSnapshotFromUsageCost(usageJson, options = {}) {
  const errors = [];
  const timezone = cleanString(options.timezone) || "UTC";
  const generatedAtMs = Number.isFinite(options.generatedAtMs) ? options.generatedAtMs : 0;
  const localProviders = Array.isArray(options.localProviders) && options.localProviders.length
    ? options.localProviders : DEFAULT_LOCAL_PROVIDERS;
  const pluginFree = cleanString(options.pluginFree);
  const pluginIntelligence = cleanString(options.pluginIntelligence);

  if (!usageJson || typeof usageJson !== "object") {
    return { ok: false, errors: ["usage-cost JSON is not an object"] };
  }
  const updatedAt = Number(usageJson.updatedAt);
  if (!Number.isFinite(updatedAt) || updatedAt <= 0) {
    errors.push(`usage-cost updatedAt is missing or non-finite (${JSON.stringify(usageJson.updatedAt)})`);
  }
  const daily = Array.isArray(usageJson.daily) ? usageJson.daily : null;
  if (!daily) errors.push("usage-cost has no daily[] array");
  if (errors.length) return { ok: false, errors };

  // Policy month: the caller may pin it (tests / explicit policy); otherwise it is
  // derived from the source's own updatedAt in the policy timezone. Either way we
  // require the source's updatedAt to fall in that month, so a stale/wrong-month
  // usage dump can never masquerade as the current month.
  const updatedAtMonth = resolvePolicyMonth(updatedAt, timezone);
  const policyMonth = cleanString(options.policyMonth) || updatedAtMonth;
  if (!/^\d{4}-\d{2}$/.test(policyMonth)) {
    return { ok: false, errors: [`invalid policy month ${JSON.stringify(policyMonth)}`] };
  }
  if (updatedAtMonth !== policyMonth) {
    errors.push(`usage-cost updatedAt month ${updatedAtMonth} != policy month ${policyMonth} (stale/wrong-month source) — failing closed`);
  }

  let monthToDate = 0;
  let daysCounted = 0;
  let cloudMissing = 0;
  let localMissing = 0;
  const cloudMissingByModel = {};
  const localMissingByModel = {};

  for (const row of daily) {
    const date = cleanString(row?.date);
    if (!date || date.slice(0, 7) !== policyMonth) continue;
    daysCounted += 1;
    const totalCost = Number(row?.totalCost);
    if (!Number.isFinite(totalCost)) {
      errors.push(`day ${date} totalCost is non-finite (${JSON.stringify(row?.totalCost)})`);
      continue;
    }
    if (totalCost < 0) {
      errors.push(`day ${date} totalCost is negative (${totalCost})`);
      continue;
    }
    monthToDate += totalCost;

    // MISSING-COST ATTRIBUTION RECONCILIATION (1.6.1-rc.3, Blocker 4). The daily
    // missingCostEntries count must be a nonnegative integer, and when >0 the
    // per-model breakdown must FULLY reconcile: the nonnegative-integer sum of
    // missingCostByModel MUST EQUAL missingCostEntries. Any deficit (a proven local
    // row cannot silently absorb other unexplained rows), surplus, negative,
    // fractional, or otherwise malformed count is unattributed/invalid and FAILS
    // CLOSED — the unexplained remainder is charged to CLOUD so the total can never
    // read as under budget on unknowably-larger spend.
    const rawMissing = row?.missingCostEntries;
    let missingEntries = 0;
    if (rawMissing !== undefined && rawMissing !== null) {
      if (!Number.isInteger(rawMissing) || rawMissing < 0) {
        errors.push(`day ${date} missingCostEntries is not a nonnegative integer (${JSON.stringify(rawMissing)}) — failing closed`);
        continue;
      }
      missingEntries = rawMissing;
    }
    if (missingEntries > 0) {
      const byModel = row?.missingCostByModel && typeof row.missingCostByModel === "object" && !Array.isArray(row.missingCostByModel)
        ? row.missingCostByModel : null;
      if (!byModel || Object.keys(byModel).length === 0) {
        // Unattributable missing cost — cannot prove it is local, so treat as cloud.
        cloudMissing += missingEntries;
        cloudMissingByModel[`unattributed@${date}`] = missingEntries;
      } else {
        let attributed = 0;
        let rowMalformed = false;
        for (const [ref, count] of Object.entries(byModel)) {
          if (!Number.isInteger(count) || count < 0) {
            errors.push(`day ${date} missingCostByModel[${JSON.stringify(ref)}] is not a nonnegative integer (${JSON.stringify(count)}) — failing closed`);
            rowMalformed = true;
            continue;
          }
          attributed += count;
          if (isLocalRef(ref, localProviders)) {
            localMissing += count;
            localMissingByModel[ref] = (localMissingByModel[ref] || 0) + count;
          } else {
            cloudMissing += count;
            cloudMissingByModel[ref] = (cloudMissingByModel[ref] || 0) + count;
          }
        }
        if (!rowMalformed && attributed !== missingEntries) {
          errors.push(`day ${date} missing-cost attribution does not reconcile: sum(missingCostByModel)=${attributed} != missingCostEntries=${missingEntries} — unattributed/invalid; failing closed`);
          // Charge any deficit to CLOUD so cloudMissing reflects the unexplained rows.
          if (attributed < missingEntries) {
            const deficit = missingEntries - attributed;
            cloudMissing += deficit;
            cloudMissingByModel[`unreconciled@${date}`] = deficit;
          }
        }
      }
    }
  }

  if (cloudMissing > 0) {
    errors.push(`unpriced CLOUD spend: ${cloudMissing} missing-cost cloud entr${cloudMissing === 1 ? "y" : "ies"} (${Object.keys(cloudMissingByModel).join(", ")}) — month-to-date total understated; failing closed`);
  }

  if (errors.length) {
    return { ok: false, errors, policyMonth, monthToDateCostUsd: round6(monthToDate), cloudMissing, localMissing };
  }

  const snapshot = {
    schema_version: SPEND_SNAPSHOT_SCHEMA_VERSION,
    kind: SPEND_SNAPSHOT_KIND,
    source: SPEND_SNAPSHOT_SOURCE,
    generator: SPEND_SNAPSHOT_GENERATOR,
    generated_at: generatedAtMs ? new Date(generatedAtMs).toISOString() : null,
    generated_at_ms: generatedAtMs,
    policy_month: policyMonth,
    timezone,
    plugin_pair: {
      ...(pluginFree ? { free: pluginFree } : {}),
      ...(pluginIntelligence ? { intelligence: pluginIntelligence } : {}),
    },
    // The authoritative "as of" instant: cost is complete through here. A cost-log
    // delta (optional) counts only calls STRICTLY AFTER this to avoid double count.
    through_ms: updatedAt,
    through_iso: new Date(updatedAt).toISOString(),
    month_to_date_cost_usd: round6(monthToDate),
    days_counted: daysCounted,
    cloud_missing_cost_entries: cloudMissing, // 0 when ok (else we would have failed)
    local_missing_cost_entries: localMissing,
    local_missing_cost_by_model: localMissingByModel,
    local_providers: [...new Set((localProviders).map((p) => String(p).toLowerCase()))],
  };
  snapshot.fingerprint = computeSpendFingerprint(snapshot);
  return { ok: true, snapshot, monthToDateCostUsd: snapshot.month_to_date_cost_usd, policyMonth, cloudMissing, localMissing };
}

/**
 * loadSpendSnapshot — CONSUME + VERIFY a deployment-owned spend snapshot.
 *
 * Options:
 *   snapshotPath, snapshot, expectedSource, expectedPluginFree,
 *   expectedPluginIntelligence, expectedPolicyMonth (current month in policy tz),
 *   maxAgeMs, nowMs, deps { readFile, statSync }
 *
 * Returns { ok, monthToDateCostUsd, policyMonth, throughMs, generatedAtMs, ageMs,
 *           stale, localMissingEntries, source, errors }. FAILS CLOSED; never throws.
 */
export function loadSpendSnapshot(options = {}) {
  const deps = options.deps || {};
  const expectedSource = cleanString(options.expectedSource) || SPEND_SNAPSHOT_SOURCE;
  const expectedFree = cleanString(options.expectedPluginFree);
  const expectedIntelligence = cleanString(options.expectedPluginIntelligence);
  const expectedPolicyMonth = cleanString(options.expectedPolicyMonth);
  const maxAgeMs = Number.isFinite(options.maxAgeMs) && options.maxAgeMs > 0 ? options.maxAgeMs : DEFAULT_SPEND_MAX_AGE_MS;
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();

  const fail = (errors, extra = {}) => ({
    ok: false, monthToDateCostUsd: null, policyMonth: extra.policyMonth ?? null,
    throughMs: extra.throughMs ?? null, generatedAtMs: extra.generatedAtMs ?? null,
    ageMs: extra.ageMs ?? null, stale: extra.stale === true, localMissingEntries: null,
    source: extra.source || "none", verified: false, errors,
  });

  let snapshot = options.snapshot;
  let sourcePath = snapshot ? "provided-snapshot" : null;
  if (!snapshot) {
    const snapshotPath = cleanString(options.snapshotPath);
    if (!snapshotPath) return fail(["no spend snapshot path or object supplied"]);
    try {
      const readFileImpl = deps.readFile || fs.readFileSync;
      const statImpl = deps.statSync || fs.statSync;
      const stat = statImpl(snapshotPath);
      if (stat.size > MAX_SNAPSHOT_BYTES) throw new Error(`snapshot exceeds ${MAX_SNAPSHOT_BYTES} bytes`);
      snapshot = JSON.parse(String(readFileImpl(snapshotPath, "utf8")));
      sourcePath = snapshotPath;
    } catch (error) {
      return fail([`could not read spend snapshot: ${error.message}`], { source: snapshotPath });
    }
  }

  if (!snapshot || typeof snapshot !== "object") return fail(["spend snapshot is not an object"], { source: sourcePath });
  const errors = [];
  if (snapshot.schema_version !== SPEND_SNAPSHOT_SCHEMA_VERSION) errors.push(`unsupported spend snapshot schema_version ${snapshot.schema_version} (need ${SPEND_SNAPSHOT_SCHEMA_VERSION})`);
  if (snapshot.kind !== SPEND_SNAPSHOT_KIND) errors.push(`unexpected spend snapshot kind ${JSON.stringify(snapshot.kind)}`);
  if (cleanString(snapshot.source) !== expectedSource) errors.push(`spend snapshot source ${JSON.stringify(snapshot.source)} != expected ${JSON.stringify(expectedSource)}`);

  const pair = snapshot.plugin_pair && typeof snapshot.plugin_pair === "object" ? snapshot.plugin_pair : {};
  if (expectedFree && cleanString(pair.free) !== expectedFree) errors.push(`spend snapshot Free version ${JSON.stringify(pair.free)} != running ${JSON.stringify(expectedFree)}`);
  if (expectedIntelligence && cleanString(pair.intelligence) !== expectedIntelligence) errors.push(`spend snapshot Intelligence version ${JSON.stringify(pair.intelligence)} != expected ${JSON.stringify(expectedIntelligence)}`);

  const policyMonth = cleanString(snapshot.policy_month);
  if (!policyMonth || !/^\d{4}-\d{2}$/.test(policyMonth)) errors.push(`spend snapshot policy_month ${JSON.stringify(snapshot.policy_month)} is missing/invalid`);
  else if (expectedPolicyMonth && policyMonth !== expectedPolicyMonth) errors.push(`spend snapshot policy_month ${policyMonth} != current policy month ${expectedPolicyMonth} (stale/wrong-month) — failing closed`);

  const generatedAtMs = Number.isFinite(snapshot.generated_at_ms) ? snapshot.generated_at_ms : null;
  const ageMs = generatedAtMs != null ? nowMs - generatedAtMs : null;
  let stale = false;
  if (generatedAtMs == null) errors.push("spend snapshot is missing generated_at_ms (cannot verify freshness)");
  else if (ageMs < 0) errors.push(`spend snapshot generated_at_ms is in the future by ${-ageMs}ms (clock/tamper)`);
  else if (ageMs > maxAgeMs) { stale = true; errors.push(`spend snapshot is stale: age ${Math.round(ageMs / 3_600_000)}h exceeds max ${Math.round(maxAgeMs / 3_600_000)}h`); }

  const total = Number(snapshot.month_to_date_cost_usd);
  if (!Number.isFinite(total)) errors.push(`spend snapshot month_to_date_cost_usd is non-finite (${JSON.stringify(snapshot.month_to_date_cost_usd)})`);
  else if (total < 0) errors.push(`spend snapshot month_to_date_cost_usd is negative (${total})`);

  const cloudMissing = Number(snapshot.cloud_missing_cost_entries) || 0;
  if (cloudMissing > 0) errors.push(`spend snapshot carries ${cloudMissing} unpriced CLOUD missing-cost entries — total is understated; failing closed`);

  const throughMs = Number.isFinite(snapshot.through_ms) ? snapshot.through_ms : null;
  if (throughMs == null) errors.push("spend snapshot is missing through_ms");

  // Provider-classification basis cross-check (Blocker 3): do NOT trust the
  // snapshot's own local_providers to decide which unpriced rows are benign local
  // $0. When the caller passes the normalized configured local set, the snapshot's
  // local_providers MUST match it EXACTLY (normalized); a mismatch means the
  // snapshot was built against a different local/cloud partition than the running
  // config, so its cloud-missing=0 assertion is untrustworthy — fail closed.
  const expectedLocal = canonicalProviders(options.expectedLocalProviders);
  if (expectedLocal.length > 0) {
    const snapshotLocal = canonicalProviders(snapshot.local_providers);
    if (snapshotLocal.join(",") !== expectedLocal.join(",")) {
      errors.push(`spend snapshot local_providers [${snapshotLocal.join(", ") || "none"}] != configured local providers [${expectedLocal.join(", ")}] — classification basis mismatch; failing closed`);
    }
  }

  const recomputed = computeSpendFingerprint(snapshot);
  if (recomputed !== cleanString(snapshot.fingerprint)) errors.push("spend snapshot fingerprint does not match its contents (drift/tamper) — failing closed");

  if (errors.length) return fail(errors, { source: sourcePath, policyMonth, throughMs, generatedAtMs, ageMs, stale });

  return {
    ok: true,
    monthToDateCostUsd: round6(total),
    policyMonth,
    throughMs,
    generatedAtMs,
    ageMs,
    stale: false,
    localMissingEntries: Number(snapshot.local_missing_cost_entries) || 0,
    localProviders: Array.isArray(snapshot.local_providers) ? snapshot.local_providers : DEFAULT_LOCAL_PROVIDERS,
    source: cleanString(snapshot.source),
    verified: true,
    errors: [],
  };
}

/**
 * applyCostLogDelta — OPTIONAL conservative top-up from the plugin's OWN cost log.
 *
 * The snapshot is authoritative through `base.throughMs`. Cloud calls the plugin
 * observed AFTER that instant (same policy month) are not yet in the source dump;
 * summing their already-reconciled `costUsd` adds them without re-pricing anything.
 *
 * FAIL CLOSED, NOT SILENT-SKIP (1.6.1-rc.3, Blocker 5). The earlier revision
 * quietly skipped unpriced cloud rows, malformed rows, and (on a large ledger)
 * older post-through rows beyond the bounded tail, while still returning the base
 * total as if verified — understating spend. Now the delta only ever returns a
 * total it can PROVE complete. `result.complete === true` means the delta is
 * trustworthy; `result.failClosed === true` means completeness could not be proven
 * and the CALLER (spend-provider) must treat spend as unavailable (cloud-suppressed
 * under a finite budget) rather than trust the base total.
 *
 * Conditions that fail closed:
 *  - the delta ledger is unreadable (I/O error, not merely absent);
 *  - the bounded tail read cannot prove it reaches back to `throughMs`
 *    (file exceeds maxBytes and the earliest parsed row is still after throughMs) —
 *    older post-through rows could be beyond the window;
 *  - a row cannot be parsed (other than the single expected partial leading row of
 *    a truncated tail read) — it might BE a post-through cloud call;
 *  - a post-through call row has no parseable timestamp (cannot be bounded);
 *  - a post-through call row has unknown provider provenance (cannot classify
 *    local vs cloud);
 *  - a post-through CLOUD call row lacks a finite nonnegative costUsd (would
 *    understate).
 *
 * When it DOES apply:
 *  - NO double-pricing of cache reads: `costUsd` is the single cache-aware total the
 *    observer already computed (pricing.costBreakdown); summing it never re-applies
 *    a cache multiplier.
 *  - Deliberate overlap policy (documented): a row whose ts == throughMs is assumed
 *    already in the snapshot and skipped; any near-boundary overlap can only
 *    OVERSTATE spend — the safe direction against a budget.
 *  - Local rows are $0 marginal ONLY when their provider is in the EXPLICIT
 *    configured local set passed in `options.localProviders`.
 *
 * Never throws.
 */
export function applyCostLogDelta(base, options = {}) {
  const result = {
    monthToDateCostUsd: base?.monthToDateCostUsd ?? null,
    baseCostUsd: base?.monthToDateCostUsd ?? null,
    deltaUsd: 0,
    deltaRows: 0,
    deltaApplied: false,
    complete: false,
    failClosed: false,
    reason: null,
    note: null,
  };
  const failClosed = (reason, note) => {
    result.failClosed = true;
    result.complete = false;
    result.deltaApplied = false;
    result.reason = reason;
    result.note = note || reason;
    return result;
  };

  if (!base || base.ok !== true || !Number.isFinite(base.monthToDateCostUsd)) {
    // The base itself is unavailable — the caller already fails closed on !ok, so we
    // do not need to force suppression here; the delta simply cannot be computed.
    result.reason = "base_unavailable";
    result.note = "base spend unavailable; delta not applied";
    return result;
  }
  const throughMs = Number.isFinite(base.throughMs) ? base.throughMs : null;
  if (throughMs == null) return failClosed("base_missing_through_ms", "base snapshot missing through_ms; cannot bound the delta — failing closed");

  const costLogPath = cleanString(options.costLogPath);
  if (!costLogPath) {
    // Delta enabled but no ledger path configured → the base snapshot stands on its
    // own; there is no post-through ledger to prove incomplete. Complete base-only.
    result.complete = true;
    result.reason = "no_cost_log_path";
    result.note = "no cost-log path; delta not applied (base only)";
    return result;
  }
  const policyMonth = cleanString(options.policyMonth) || base.policyMonth;
  const timezone = cleanString(options.timezone) || "UTC";
  const localProviders = Array.isArray(options.localProviders) && options.localProviders.length
    ? options.localProviders : (base.localProviders || DEFAULT_LOCAL_PROVIDERS);
  const maxBytes = Number.isFinite(options.maxBytes) && options.maxBytes > 0 ? options.maxBytes : DEFAULT_DELTA_MAX_BYTES;
  const deps = options.deps || {};

  let text = "";
  let truncated = false;
  try {
    const readFileImpl = deps.readFile || fs.readFileSync;
    const statImpl = deps.statSync || fs.statSync;
    let stat = null;
    try {
      stat = statImpl(costLogPath);
    } catch (inner) {
      if (inner?.code === "ENOENT") {
        // Absent ledger → no post-through rows were recorded → base is complete.
        result.complete = true;
        result.reason = "cost_log_absent";
        result.note = "cost log absent; delta not applied (base only)";
        return result;
      }
      throw inner;
    }
    if (Number.isFinite(stat?.size) && stat.size > maxBytes) {
      // Bounded tail read: only the recent tail can be held in memory. Whether it
      // PROVES completeness since through_ms is decided after parsing (min-ts proof).
      truncated = true;
      const fd = (deps.openSync || fs.openSync)(costLogPath, "r");
      try {
        const buf = Buffer.alloc(maxBytes);
        const bytesRead = (deps.readSync || fs.readSync)(fd, buf, 0, maxBytes, stat.size - maxBytes);
        text = buf.slice(0, bytesRead).toString("utf8");
      } finally { (deps.closeSync || fs.closeSync)(fd); }
    } else {
      text = String(readFileImpl(costLogPath, "utf8"));
    }
  } catch (error) {
    return failClosed("cost_log_unreadable", `cost log unreadable (${error.message}); delta cannot be proven — failing closed`);
  }

  let delta = 0;
  let rows = 0;
  let minParsedTsMs = Infinity; // earliest ts across ALL parsed rows (truncation proof)
  const lines = text.split("\n");
  let sawNonEmpty = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const isFirstNonEmpty = !sawNonEmpty;
    sawNonEmpty = true;
    let row;
    try {
      row = JSON.parse(trimmed);
    } catch {
      // The ONLY tolerated unparseable row is the leading partial line of a
      // truncated tail read (an older row split by the byte window). Its coverage
      // is still governed by the min-ts completeness proof below. Any OTHER
      // unparseable row could conceal a post-through cloud call → fail closed.
      if (truncated && isFirstNonEmpty) continue;
      return failClosed("cost_log_unparseable_row", "cost log has an unparseable row that could conceal post-through spend — failing closed");
    }
    if (!row || typeof row !== "object") return failClosed("cost_log_malformed_row", "cost log has a malformed (non-object) row — failing closed");
    const anyTs = Date.parse(cleanString(row.ts) || "");
    if (Number.isFinite(anyTs) && anyTs < minParsedTsMs) minParsedTsMs = anyTs;
    if (row.kind !== "call") continue; // summaries etc. carry no marginal cost
    const tsMs = Date.parse(cleanString(row.ts) || "");
    if (!Number.isFinite(tsMs)) return failClosed("cost_log_call_missing_ts", "a cost-log call row has no parseable timestamp — cannot bound it against the snapshot; failing closed");
    if (tsMs <= throughMs) continue;                        // already in the snapshot
    if (resolvePolicyMonth(tsMs, timezone) !== policyMonth) continue; // other month
    // POST-THROUGH, same-month call row: it MUST be classifiable and priced.
    const ref = cleanString(row.resolvedRef) || `${cleanString(row.provider) || ""}/${cleanString(row.model) || ""}`;
    if (providerTokenOf(ref) === "") {
      return failClosed("cost_log_unknown_provenance", "a post-through cost-log call row has unknown provider provenance — cannot classify local vs cloud; failing closed");
    }
    if (isLocalRef(ref, localProviders)) continue;          // local = $0 marginal (explicit config set)
    const costUsd = Number(row.costUsd);
    if (!Number.isFinite(costUsd) || costUsd < 0) {
      return failClosed("cost_log_unpriced_cloud", "a post-through CLOUD cost-log call row lacks a finite nonnegative cost — spend would be understated; failing closed");
    }
    delta += costUsd;
    rows += 1;
  }

  // Truncation completeness proof: a tail read only proves it captured every
  // post-through row if it reaches back to (or before) the snapshot boundary — i.e.
  // the earliest parsed row is at or before through_ms. Otherwise older post-through
  // rows may lie beyond the window and we must fail closed rather than tail-skip.
  if (truncated && !(Number.isFinite(minParsedTsMs) && minParsedTsMs <= throughMs)) {
    return failClosed("cost_log_tail_incomplete", `cost log exceeds ${maxBytes} bytes and the bounded tail does not reach back to the snapshot boundary — cannot prove completeness since through_ms; failing closed`);
  }

  result.deltaUsd = round6(delta);
  result.deltaRows = rows;
  result.deltaApplied = true;
  result.complete = true;
  result.reason = truncated ? "delta_applied_tail_proven" : "delta_applied_full_read";
  result.note = null;
  result.monthToDateCostUsd = round6(base.monthToDateCostUsd + delta);
  return result;
}

/** Default deployment-owned spend snapshot path (mirrors defaultInventoryPaths). */
export function defaultSpendSnapshotPath(config = {}) {
  const sr = config.skillRouting || {};
  const spend = sr.spend || {};
  return resolveOpenClawPath(cleanString(spend.snapshotPath) || "~/.openclaw/togglelogic/cloud-spend.snapshot.json");
}

export const _internals = { round6, sha256, providerTokenOf, path };
