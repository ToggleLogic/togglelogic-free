/*
 * ToggleLogic (Free Tier) — append-only cost events for host subscribers.
 * (c) 2026 Motherboard, Inc. Source-available under the ToggleLogic Free-Tier
 * License (see LICENSE); all rights reserved.
 * PATENT PENDING.
 */
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { createLogger } from "../observability/logger.js";
import { EVENTS, OUTCOMES } from "../audit/audit-events.js";

const TYPES = new Set([EVENTS.MODEL_UNPRICED, EVENTS.USAGE_MISSING, EVENTS.BUDGET_THRESHOLD_CROSSED, "provider_unavailable", "provider_available"]);

export function isLocalProvider(provider, localProviders = ["ollama", "lmstudio", "llamacpp", "vllm-local"], hostConfig = {}) {
  if (localProviders.includes(String(provider).toLowerCase())) return true;
  try {
    const host = new URL(hostConfig?.models?.providers?.[provider]?.baseUrl).hostname.toLowerCase();
    return ["localhost", "127.0.0.1", "[::1]"].includes(host);
  } catch { return false; }
}

function period(event, ts) {
  return ts.slice(0, event === EVENTS.MODEL_UNPRICED ? 10 : 13);
}

/**
 * Fixed payload allowlist: never copy provider errors, credentials, URLs, or
 * arbitrary event properties. Identity fields must be portable identifiers.
 */
function identifier(value) {
  return typeof value === "string" && /^[a-z0-9][a-z0-9._:/@+-]{0,255}$/i.test(value)
    && !value.includes("://") && !value.includes("@") ? value : null;
}

export function createUsageEvents({ config = {}, audit, fallbackLogger, deploymentId, costCenter,
  logger, now = () => Date.now() } = {}) {
  const log = logger ?? createLogger({
    path: config.path ?? "~/.openclaw/logs/togglelogic-events.jsonl",
    rotateSizeMb: config.rotateSizeMb ?? 50,
  }, fallbackLogger);
  const seen = new Map();
  let queue = Promise.resolve();
  let loaded = false;

  function key(row) {
    if (row.event === EVENTS.BUDGET_THRESHOLD_CROSSED) return JSON.stringify([row.event, row.deploymentId, row.month, row.thresholdPct]);
    return JSON.stringify([row.event, row.deploymentId, row.costCenter, row.resolvedRef, period(row.event, row.ts)]);
  }
  function remember(row) { seen.set(key(row), { day: row.ts.slice(0, 10), month: row.month ?? null }); }

  // Recover first-only suppression across restarts from retained event files.
  // Retention beyond the current file and five rotations belongs to the host.
  async function load() {
    if (loaded) return;
    loaded = true;
    if (!log.path) return;
    const today = new Date(now()).toISOString().slice(0, 10);
    for (const suffix of ["", ".1", ".2", ".3", ".4", ".5"]) {
      const input = createReadStream(log.path + suffix, { encoding: "utf8" });
      const lines = createInterface({ input, crlfDelay: Infinity });
      try {
        for await (const line of lines) {
          try {
            const row = JSON.parse(line);
            if (row.schema === "togglelogic.event.v1" && TYPES.has(row.event) &&
              typeof row.ts === "string" && (row.event === EVENTS.BUDGET_THRESHOLD_CROSSED
                ? typeof row.month === "string" : row.ts.slice(0, 10) === today)) remember(row);
          } catch { /* An interrupted tail must not hide later valid records. */ }
        }
      } catch (error) {
        if (error.code !== "ENOENT") fallbackLogger?.warn?.("togglelogic events: could not restore deduplication history");
      } finally { lines.close(); input.destroy(); }
    }
  }

  function emit(event, input = {}) {
    if (!TYPES.has(event)) return Promise.resolve();
    if (event === "provider_unavailable" || event === "provider_available") {
      if (!identifier(input.provider)) return Promise.resolve();
      if (event === "provider_unavailable" && (!["credits_depleted", "billing_disabled", "payment_required"].includes(input.reason) ||
          !Number.isFinite(input.since) || !Number.isFinite(input.cooldownUntil))) return Promise.resolve();
      const row = { schema: "togglelogic.event.v1", ts: new Date(now()).toISOString(), event, provider: identifier(input.provider),
        ...(event === "provider_unavailable" ? { reason: input.reason, since: input.since, cooldownUntil: input.cooldownUntil } : {}) };
      queue = queue.then(async () => {
        await Promise.allSettled([log.write(row), Promise.resolve().then(() => audit?.emit?.({ event, outcome: "success", principal: { source: "plugin" }, details: row }))]);
      }).catch(() => {});
      return queue;
    }
    const budget = event === EVENTS.BUDGET_THRESHOLD_CROSSED;
    if (budget && (!/^\d{4}-(0[1-9]|1[0-2])$/.test(input.month) ||
        ![input.thresholdPct, input.monthlyUsd, input.spentUsd].every(Number.isFinite))) return Promise.resolve();
    const row = {
      schema: "togglelogic.event.v1", ts: new Date(input.ts ?? now()).toISOString(), event,
      deploymentId: identifier(deploymentId), costCenter: identifier(costCenter),
      requestId: identifier(input.requestId),
      ...(budget ? { month: input.month, thresholdPct: input.thresholdPct, monthlyUsd: input.monthlyUsd,
        spentUsd: input.spentUsd, unpricedCalls: input.unpricedCalls ?? 0,
        usageMissingCalls: input.usageMissingCalls ?? 0, historyIncomplete: input.historyIncomplete === true } : {
        provider: identifier(input.provider), model: identifier(input.model), resolvedRef: identifier(input.resolvedRef),
      ...(event === EVENTS.MODEL_UNPRICED ? { reason: input.reason === "outside-price-coverage" ? "outside-price-coverage" : "no-price-in-source" } : { calls: 1 }) }),
    };
    queue = queue.then(async () => {
      await load();
      const today = new Date(now()).toISOString().slice(0, 10);
      for (const [id, value] of seen) {
        if (!value.month && value.day < today) seen.delete(id);
      }
      if (seen.has(key(row))) return;
      remember(row);
      // Independent sinks: an audit failure must not prevent the host event.
      await Promise.allSettled([
        Promise.resolve().then(() => log.write(row)),
        Promise.resolve().then(() => audit?.emit({ event, outcome: OUTCOMES.FAILURE,
          principal: { source: "cost-visibility" }, correlationId: row.requestId ?? undefined,
          details: row })),
      ]);
    }).catch(() => { fallbackLogger?.warn?.("togglelogic events: event emission failed"); });
    return queue;
  }
  return { emit, flush: () => queue, path: log.path };
}
