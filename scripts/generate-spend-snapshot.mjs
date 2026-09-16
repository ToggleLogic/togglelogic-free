#!/usr/bin/env node
/*
 * ToggleLogic (Free Tier) — DEPLOYMENT-OWNED cloud-spend snapshot generator.
 * (c) 2026 Motherboard, Inc. Source-available under the ToggleLogic Free-Tier
 * License (see LICENSE). PATENT PENDING.
 *
 * This is the ONE place `openclaw gateway usage-cost --all-agents --expect-final
 * --json` is executed. It runs at DEPLOY / REFRESH time (never on a user turn —
 * the plugin never shells out) and writes a versioned + fingerprinted snapshot of
 * the CURRENT policy-month CLOUD spend that the plugin consumes and re-verifies
 * (see src/usage/spend-snapshot.js).
 *
 * FAILS CLOSED. It refuses to write on: malformed usage JSON, a stale/wrong-month
 * source, a negative/non-finite total, or ANY unpriced CLOUD missing-cost row
 * (unpriced LOCAL/Ollama rows are expected $0 and are fine). A refusal exits
 * non-zero with the reason on stderr so the refresh job's sentinel/log shows it.
 *
 * EXACT DEPLOYMENT COMMAND (run on the host, as the OpenClaw service identity):
 *
 *   node scripts/generate-spend-snapshot.mjs \
 *     --out ~/.openclaw/togglelogic/cloud-spend.snapshot.json \
 *     --free 1.6.1-rc.3 --intelligence 1.4.1-rc.3 \
 *     --timezone America/New_York
 *
 * WINDOW (1.6.1-rc.3, Blocker 2): `openclaw gateway usage-cost` DEFAULTS to a
 * 30-day window, which can omit day 1 of a 31-day policy month when the refresh
 * runs late in the month. We therefore pass `--days` with a floor of
 * MIN_USAGE_DAYS (35) so the whole current month is always covered with slack,
 * and still FILTER to the owner policy month in buildSpendSnapshotFromUsageCost
 * (daily rows outside the month are ignored). Passing a larger --days only adds
 * older rows that the month filter discards; it never inflates the total.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  buildSpendSnapshotFromUsageCost,
  SPEND_SNAPSHOT_SOURCE,
  DEFAULT_LOCAL_PROVIDERS,
} from "../src/usage/spend-snapshot.js";

// Minimum usage-cost lookback. Must exceed the longest month (31 days) with slack
// for the owner-local month boundary, so day 1 is never dropped regardless of when
// in the month the refresh runs. The month filter downstream discards older rows.
export const MIN_USAGE_DAYS = 35;
export const USAGE_CACHE_RETRY_MS = 2000;
export const USAGE_CACHE_MAX_ATTEMPTS = 16;

export function parseArgs(argv) {
  const args = {
    out: null, free: null, intelligence: null, timezone: "UTC",
    openclaw: "openclaw", month: null, localProviders: [], days: MIN_USAGE_DAYS, help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--out" || a === "-o") args.out = argv[++i];
    else if (a === "--free") args.free = argv[++i];
    else if (a === "--intelligence" || a === "--intel") args.intelligence = argv[++i];
    else if (a === "--timezone" || a === "--tz") args.timezone = argv[++i];
    else if (a === "--month") args.month = argv[++i];
    else if (a === "--days") args.days = Number.parseInt(argv[++i], 10);
    else if (a === "--local-provider") args.localProviders.push(argv[++i]);
    else if (a === "--openclaw-bin") args.openclaw = argv[++i];
    else if (!a.startsWith("-") && !args.out) args.out = a;
  }
  return args;
}

// Effective lookback: never below MIN_USAGE_DAYS, even if a smaller --days is given.
export function effectiveDays(requested) {
  return Number.isInteger(requested) && requested > MIN_USAGE_DAYS ? requested : MIN_USAGE_DAYS;
}

// The EXACT argument vector passed to `openclaw`. Kept pure + exported so a test
// can assert `--days` is present and the window is >= MIN_USAGE_DAYS without
// shelling out.
export function usageCostArgs(days = MIN_USAGE_DAYS) {
  return ["gateway", "usage-cost", "--all-agents", "--expect-final", "--json", "--days", String(effectiveDays(days))];
}

export function usageCacheIsRefreshing(usageJson) {
  return usageJson?.cacheStatus?.status === "refreshing";
}

function waitSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function expandHome(p) {
  if (!p) return p;
  return p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(
      "Usage: node scripts/generate-spend-snapshot.mjs --out <path> --free <version> --intelligence <version> [--timezone <IANA>] [--month YYYY-MM] [--days N>=35] [--local-provider <name> ...] [--openclaw-bin <path>]\n",
    );
    return;
  }
  if (!args.free || !args.intelligence) {
    process.stderr.write("generate-spend-snapshot: --free and --intelligence are required; refusing to write an unpaired snapshot.\n");
    process.exit(2);
  }
  const outPath = expandHome(args.out) || path.join(os.homedir(), ".openclaw", "togglelogic", "cloud-spend.snapshot.json");
  const localProviders = args.localProviders.length ? args.localProviders : [...DEFAULT_LOCAL_PROVIDERS];

  const days = effectiveDays(args.days);
  const execArgs = usageCostArgs(days);
  let usageJson;
  try {
    for (let attempt = 1; attempt <= USAGE_CACHE_MAX_ATTEMPTS; attempt += 1) {
      const raw = execFileSync(args.openclaw, execArgs, {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      });
      usageJson = JSON.parse(raw);
      if (!usageCacheIsRefreshing(usageJson)) break;
      if (attempt === USAGE_CACHE_MAX_ATTEMPTS) {
        throw new Error(`usage-cost cache remained refreshing after ${USAGE_CACHE_MAX_ATTEMPTS} attempts`);
      }
      waitSync(USAGE_CACHE_RETRY_MS);
    }
  } catch (error) {
    process.stderr.write(`generate-spend-snapshot: could not obtain a settled usage-cost response from \`${args.openclaw} ${execArgs.join(" ")}\`: ${error.message}\n`);
    process.exit(2);
  }

  const built = buildSpendSnapshotFromUsageCost(usageJson, {
    generatedAtMs: Date.now(),
    timezone: args.timezone,
    ...(args.month ? { policyMonth: args.month } : {}),
    pluginFree: args.free,
    pluginIntelligence: args.intelligence,
    localProviders,
  });

  if (!built.ok) {
    process.stderr.write("generate-spend-snapshot: FAILING CLOSED — refusing to write an untrusted spend snapshot:\n");
    for (const e of built.errors) process.stderr.write(`  - ${e}\n`);
    process.exit(3);
  }

  const snapshot = built.snapshot;
  try {
    fs.mkdirSync(path.dirname(outPath), { recursive: true, mode: 0o700 });
    const tmp = `${outPath}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, outPath);
  } catch (error) {
    process.stderr.write(`generate-spend-snapshot: could not write snapshot to ${outPath}: ${error.message}\n`);
    process.exit(4);
  }

  process.stdout.write(
    [
      `ToggleLogic cloud-spend snapshot written: ${outPath}`,
      `  source:        ${SPEND_SNAPSHOT_SOURCE} --days ${days}`,
      `  policy month:  ${snapshot.policy_month} (${snapshot.timezone})`,
      `  month-to-date: $${snapshot.month_to_date_cost_usd.toFixed(2)} cloud (${snapshot.days_counted} day(s))`,
      `  through:       ${snapshot.through_iso}`,
      `  local missing: ${snapshot.local_missing_cost_entries} entr${snapshot.local_missing_cost_entries === 1 ? "y" : "ies"} (expected $0) ${JSON.stringify(snapshot.local_missing_cost_by_model)}`,
      `  cloud missing: ${snapshot.cloud_missing_cost_entries} (must be 0)`,
      `  fingerprint:   ${snapshot.fingerprint}`,
      `  pair:          Free ${snapshot.plugin_pair.free || "(unset)"} / Intelligence ${snapshot.plugin_pair.intelligence || "(unset)"}`,
      `  generated:     ${snapshot.generated_at}`,
      "",
    ].join("\n"),
  );
}

// Run main() ONLY when executed directly, so tests can import the pure helpers
// (parseArgs/usageCostArgs/effectiveDays) without shelling out to `openclaw`.
const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) main();
