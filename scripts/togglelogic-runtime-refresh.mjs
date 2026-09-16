#!/usr/bin/env node
/*
 * ToggleLogic (Free Tier) — durable RUNTIME-STATE refresh stage (CANDIDATE).
 * (c) 2026 Motherboard, Inc. Source-available under the ToggleLogic Free-Tier
 * License (see LICENSE). PATENT PENDING.
 *
 * A conservative, fail-closed refresh stage a scheduled job can call AFTER a
 * managed install to keep the paired skill-inventory + cloud-spend snapshots
 * fresh (both expire in ~24-26h; the generators are otherwise deploy-time only).
 *
 * It DOES NOT bake a development path into production: the plugin root defaults to
 * this script's OWN install location (dev repo now, managed plugin dir after
 * install), overridable via --plugin-root / TOGGLELOGIC_PLUGIN_ROOT. It reads the
 * live config READ-ONLY to confirm the feature is enabled and NEVER mutates it,
 * the live gateway, or the live schedule.
 *
 * FAIL CLOSED + VISIBLE. Any of: missing plugin, disabled feature, incompatible
 * pair, malformed usage JSON, stale/wrong month, or unpriced CLOUD spend records a
 * failed stage in the sentinel, leaves the previous good snapshots UNTOUCHED (the
 * pair is committed only when BOTH new snapshots validate), and exits non-zero so
 * the calling job surfaces it.
 *
 * See docs/RUNTIME-STATE-REFRESH.md for the install/rollback runbook and the exact
 * candidate one-line patch for the existing refresh job.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const a = {
    pluginRoot: process.env.TOGGLELOGIC_PLUGIN_ROOT || path.resolve(HERE, ".."),
    intelligenceRoot: process.env.TOGGLELOGIC_INTELLIGENCE_ROOT || path.join(os.homedir(), "togglelogic-intelligence"),
    free: null, intelligence: null, timezone: "UTC",
    inventoryOut: null, spendOut: null, sentinel: null,
    config: process.env.OPENCLAW_CONFIG_PATH || "",
    openclaw: "openclaw", month: null, localProviders: [], help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const t = argv[i];
    if (t === "--help" || t === "-h") a.help = true;
    else if (t === "--plugin-root") a.pluginRoot = argv[++i];
    else if (t === "--intelligence-root") a.intelligenceRoot = argv[++i];
    else if (t === "--free") a.free = argv[++i];
    else if (t === "--intelligence" || t === "--intel") a.intelligence = argv[++i];
    else if (t === "--timezone" || t === "--tz") a.timezone = argv[++i];
    else if (t === "--inventory-out") a.inventoryOut = argv[++i];
    else if (t === "--spend-out") a.spendOut = argv[++i];
    else if (t === "--sentinel") a.sentinel = argv[++i];
    else if (t === "--config") a.config = argv[++i];
    else if (t === "--month") a.month = argv[++i];
    else if (t === "--local-provider") a.localProviders.push(argv[++i]);
    else if (t === "--openclaw-bin") a.openclaw = argv[++i];
  }
  return a;
}

function expandHome(p) {
  if (!p) return p;
  return p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write("Usage: node scripts/togglelogic-runtime-refresh.mjs [--plugin-root <dir>] [--intelligence-root <dir>] [--free <v>] [--intelligence <v>] [--timezone <IANA>] [--config <openclaw.json>] [--inventory-out <path>] [--spend-out <path>] [--sentinel <path>] [--month YYYY-MM] [--local-provider <name> ...] [--openclaw-bin <path>]\n");
    return;
  }

  const pluginRoot = path.resolve(expandHome(args.pluginRoot));
  const intelligenceRoot = path.resolve(expandHome(args.intelligenceRoot));
  const tzHome = path.join(os.homedir(), ".openclaw", "togglelogic");
  const inventoryOut = expandHome(args.inventoryOut) || path.join(tzHome, "skill-inventory.snapshot.json");
  const spendOut = expandHome(args.spendOut) || path.join(tzHome, "cloud-spend.snapshot.json");
  const sentinelPath = expandHome(args.sentinel) || path.join(tzHome, "runtime-refresh.sentinel.json");
  const invTmp = `${inventoryOut}.refresh-tmp-${process.pid}`;
  const spendTmp = `${spendOut}.refresh-tmp-${process.pid}`;

  // Lazy imports FROM THE PLUGIN ROOT (managed install path in production), so the
  // stage always uses the installed plugin's own validators — never a dev copy.
  let mod;
  try {
    mod = {
      orchestrator: await import(new URL("file://" + path.join(pluginRoot, "src/maintenance/runtime-refresh.js")).href),
      config: await import(new URL("file://" + path.join(pluginRoot, "src/config/normalize.js")).href),
      inventory: await import(new URL("file://" + path.join(pluginRoot, "src/skill-routing/skill-inventory.js")).href),
      spend: await import(new URL("file://" + path.join(pluginRoot, "src/usage/spend-snapshot.js")).href),
    };
  } catch (error) {
    // Plugin missing/unreadable — write a minimal sentinel and fail closed.
    writeSentinel(sentinelPath, {
      schema: "togglelogic_runtime_refresh_sentinel/v1",
      overall: "failure",
      failed_stages: ["plugin_present"],
      started_at: null, finished_at: null,
      stages: [{ name: "plugin_present", status: "failed", detail: { error: `cannot load plugin at ${pluginRoot}: ${error.message}` } }],
    });
    process.stderr.write(`togglelogic-runtime-refresh: FAIL — cannot load plugin at ${pluginRoot}: ${error.message}\n`);
    process.exit(2);
  }

  const { runRuntimeRefresh, checkCompatiblePair, checkSpendNonRegression } = mod.orchestrator;
  const { normalizeConfig } = mod.config;
  const { loadSkillInventory } = mod.inventory;
  const { loadSpendSnapshot, resolvePolicyMonth } = mod.spend;

  const freeVersion = args.free || safe(() => readJson(path.join(pluginRoot, "package.json")).version) || null;
  const intelVersion = args.intelligence || safe(() => readJson(path.join(intelligenceRoot, "package.json")).version) || null;
  const localProviders = args.localProviders.length ? args.localProviders : ["ollama"];

  const stages = [
    {
      name: "plugin_present",
      run: () => {
        const pkg = safe(() => readJson(path.join(pluginRoot, "package.json")));
        const man = safe(() => readJson(path.join(pluginRoot, "openclaw.plugin.json")));
        if (!pkg || !man) return { ok: false, detail: { error: `plugin package.json/openclaw.plugin.json unreadable at ${pluginRoot}` } };
        if (freeVersion && pkg.version !== freeVersion) return { ok: false, detail: { error: `plugin version ${pkg.version} != expected ${freeVersion}` } };
        return { ok: true, detail: { pluginRoot, version: pkg.version } };
      },
    },
    {
      name: "feature_enabled",
      run: () => {
        const cfgPath = expandHome(args.config);
        if (!cfgPath) return { ok: false, detail: { error: "no --config / OPENCLAW_CONFIG_PATH given; cannot confirm the feature is enabled (fail closed)" } };
        const raw = safe(() => readJson(cfgPath));
        if (!raw) return { ok: false, detail: { error: `config unreadable at ${cfgPath}` } };
        const entry = raw?.plugins?.entries?.togglelogic?.config ?? raw?.config ?? raw;
        const cfg = normalizeConfig(entry);
        const skillOn = cfg.features.skillRouting.enabled === true;
        const spendOn = cfg.skillRouting.spend.enabled === true;
        if (!skillOn) return { ok: false, detail: { error: "features.skillRouting.enabled is not true", skillRouting: false } };
        if (!spendOn) return { ok: false, detail: { error: "skillRouting.spend.enabled is not true", spend: false } };
        return { ok: true, detail: { skillRouting: true, spend: true, timezone: cfg.skillRouting.spend.timezone || cfg.skillRouting.ownerTimezone } };
      },
    },
    {
      name: "compatible_pair",
      run: () => {
        const manifest = safe(() => readJson(path.join(intelligenceRoot, "release-manifest.json")));
        const check = checkCompatiblePair(freeVersion, manifest);
        return { ok: check.ok, detail: check.ok ? { free: freeVersion, intelligence: check.intelligenceVersion } : { errors: check.errors } };
      },
    },
    {
      name: "inventory_generated",
      run: () => {
        try {
          execFileSync("node", [path.join(pluginRoot, "scripts/generate-skill-inventory.mjs"), "--out", invTmp, "--free", freeVersion, "--intelligence", intelVersion], { stdio: "pipe", encoding: "utf8" });
        } catch (error) {
          return { ok: false, detail: { error: `generator failed: ${firstLine(error.stderr || error.message)}` } };
        }
        const load = loadSkillInventory({ snapshotPath: invTmp, expectedPluginFree: freeVersion, maxAgeMs: 60_000 });
        if (!load.ok) return { ok: false, detail: { error: "generated inventory did not validate", errors: load.errors } };
        return { ok: true, detail: { eligible: load.counts?.eligible ?? load.catalog.length, fingerprint: load.inventoryFingerprint } };
      },
    },
    {
      name: "spend_generated",
      run: () => {
        const genArgs = [path.join(pluginRoot, "scripts/generate-spend-snapshot.mjs"), "--out", spendTmp, "--free", freeVersion, "--intelligence", intelVersion, "--timezone", args.timezone];
        if (args.month) genArgs.push("--month", args.month);
        for (const lp of localProviders) genArgs.push("--local-provider", lp);
        if (args.openclaw !== "openclaw") genArgs.push("--openclaw-bin", args.openclaw);
        try {
          execFileSync("node", genArgs, { stdio: "pipe", encoding: "utf8" });
        } catch (error) {
          // The generator fails closed on malformed usage JSON, stale/wrong month, or unpriced CLOUD spend.
          return { ok: false, detail: { error: `generator failed (malformed usage / stale-month / unpriced cloud?): ${firstLine(error.stderr || error.message)}` } };
        }
        const expectedMonth = args.month || resolvePolicyMonth(Date.now(), args.timezone);
        const load = loadSpendSnapshot({ snapshotPath: spendTmp, expectedPluginFree: freeVersion, expectedPolicyMonth: expectedMonth, maxAgeMs: 60_000 });
        if (!load.ok) return { ok: false, detail: { error: "generated spend snapshot did not validate", errors: load.errors } };
        const previous = safe(() => readJson(spendOut));
        const generated = safe(() => readJson(spendTmp));
        const nonRegression = checkSpendNonRegression(previous, generated);
        if (!nonRegression.ok) {
          return { ok: false, detail: { error: `${nonRegression.error}; preserving the previous committed snapshot` } };
        }
        return { ok: true, detail: { policyMonth: load.policyMonth, monthToDateCostUsd: load.monthToDateCostUsd } };
      },
    },
    {
      name: "committed",
      run: () => {
        try {
          fs.mkdirSync(path.dirname(inventoryOut), { recursive: true, mode: 0o700 });
          fs.mkdirSync(path.dirname(spendOut), { recursive: true, mode: 0o700 });
          fs.renameSync(invTmp, inventoryOut);
          fs.renameSync(spendTmp, spendOut);
        } catch (error) {
          return { ok: false, detail: { error: `atomic pair commit failed: ${error.message}` } };
        }
        return { ok: true, detail: { inventoryOut, spendOut } };
      },
    },
  ];

  const sentinel = await runRuntimeRefresh(stages, {
    onCleanup: () => {
      for (const tmp of [invTmp, spendTmp]) {
        try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* ignore */ }
      }
    },
  });
  sentinel.plugin_root = pluginRoot;
  sentinel.free = freeVersion;
  sentinel.intelligence = intelVersion;
  sentinel.inventory_out = inventoryOut;
  sentinel.spend_out = spendOut;
  writeSentinel(sentinelPath, sentinel);

  const line = sentinel.stages.map((s) => `${s.name}=${s.status}`).join(" ");
  process.stdout.write(`togglelogic-runtime-refresh: ${sentinel.overall.toUpperCase()} — ${line}\n  sentinel: ${sentinelPath}\n`);
  if (sentinel.overall !== "success") {
    for (const s of sentinel.stages) if (s.status === "failed") process.stderr.write(`  FAILED ${s.name}: ${JSON.stringify(s.detail)}\n`);
    process.exit(1);
  }
}

function safe(fn) { try { return fn(); } catch { return null; } }
function firstLine(s) { return String(s || "").split("\n").filter(Boolean)[0] || ""; }

function writeSentinel(sentinelPath, obj) {
  try {
    fs.mkdirSync(path.dirname(sentinelPath), { recursive: true, mode: 0o700 });
    const tmp = `${sentinelPath}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, sentinelPath);
  } catch (error) {
    process.stderr.write(`togglelogic-runtime-refresh: could not write sentinel ${sentinelPath}: ${error.message}\n`);
  }
}

main().catch((error) => {
  process.stderr.write(`togglelogic-runtime-refresh: unexpected error: ${error?.message ?? error}\n`);
  process.exit(2);
});
