#!/usr/bin/env node
/*
 * ToggleLogic (Free Tier) — DEPLOYMENT-OWNED skill-inventory snapshot generator.
 * (c) 2026 Motherboard, Inc. Source-available under the ToggleLogic Free-Tier
 * License (see LICENSE). PATENT PENDING.
 *
 * This is the ONE place `openclaw skills list --json` is executed. It runs at
 * DEPLOY TIME (not on any user turn — the plugin never shells out) and writes a
 * versioned + fingerprinted snapshot of the ELIGIBLE skill set that the plugin
 * then consumes and verifies (see src/skill-routing/skill-inventory.js).
 *
 * WHY: the OpenClaw workspace `skill_manifest.json` is NOT authoritative — on the
 * reference host it is stale (2026-05-17, a handful of entries) while
 * `openclaw skills list --json` reports 94 known / 57 eligible. The deployment,
 * which owns the host, is the only party that can authoritatively enumerate the
 * eligible skills; it stamps the snapshot with the running plugin pair so the
 * plugin can reject a snapshot from the wrong version or an unexpected source.
 *
 * EXACT DEPLOYMENT COMMAND (run on the host, as the OpenClaw service identity):
 *
 *   node scripts/generate-skill-inventory.mjs \
 *     --out ~/.openclaw/togglelogic/skill-inventory.snapshot.json \
 *     --free 1.6.1-rc.3 --intelligence 1.4.1-rc.3
 *
 * Re-run it whenever installed/eligible skills change and BEFORE (re)starting the
 * plugin; the plugin fails closed on a missing, stale, wrong-source,
 * wrong-version, or drifted snapshot.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildSnapshotFromSkillsList,
  SNAPSHOT_SOURCE,
} from "../src/skill-routing/skill-inventory.js";

function parseArgs(argv) {
  const args = { out: null, free: null, intelligence: null, openclaw: "openclaw", help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--out" || a === "-o") args.out = argv[++i];
    else if (a === "--free") args.free = argv[++i];
    else if (a === "--intelligence" || a === "--intel") args.intelligence = argv[++i];
    else if (a === "--openclaw-bin") args.openclaw = argv[++i];
    else if (!a.startsWith("-") && !args.out) args.out = a;
  }
  return args;
}

function expandHome(p) {
  if (!p) return p;
  return p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(
      "Usage: node scripts/generate-skill-inventory.mjs --out <path> --free <version> --intelligence <version> [--openclaw-bin <path>]\n",
    );
    return;
  }
  if (!args.free || !args.intelligence) {
    process.stderr.write(
      "generate-skill-inventory: --free and --intelligence are required; refusing to write an unpaired snapshot.\n",
    );
    process.exit(2);
  }
  const outPath = expandHome(args.out) || path.join(os.homedir(), ".openclaw", "togglelogic", "skill-inventory.snapshot.json");

  let listJson;
  try {
    const raw = execFileSync(args.openclaw, ["skills", "list", "--json"], {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
    listJson = JSON.parse(raw);
  } catch (error) {
    process.stderr.write(`generate-skill-inventory: could not run \`${args.openclaw} skills list --json\`: ${error.message}\n`);
    process.exit(2);
  }

  const eligible = (Array.isArray(listJson?.skills) ? listJson.skills : []).filter((s) => s?.eligible === true);
  if (eligible.length === 0) {
    process.stderr.write("generate-skill-inventory: refusing to write a snapshot with ZERO eligible skills (source appears empty/wrong) — the plugin would fail closed anyway.\n");
    process.exit(3);
  }

  const snapshot = buildSnapshotFromSkillsList(listJson, {
    generatedAtMs: Date.now(),
    pluginFree: args.free,
    pluginIntelligence: args.intelligence,
  });

  try {
    fs.mkdirSync(path.dirname(outPath), { recursive: true, mode: 0o700 });
    const tmp = `${outPath}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, outPath);
  } catch (error) {
    process.stderr.write(`generate-skill-inventory: could not write snapshot to ${outPath}: ${error.message}\n`);
    process.exit(4);
  }

  process.stdout.write(
    [
      `ToggleLogic skill-inventory snapshot written: ${outPath}`,
      `  source:      ${SNAPSHOT_SOURCE}`,
      `  known:       ${snapshot.counts.known}`,
      `  eligible:    ${snapshot.counts.eligible}`,
      `  fingerprint: ${snapshot.inventory_fingerprint}`,
      `  pair:        Free ${snapshot.plugin_pair.free || "(unset)"} / Intelligence ${snapshot.plugin_pair.intelligence || "(unset)"}`,
      `  generated:   ${snapshot.generated_at}`,
      "",
    ].join("\n"),
  );
}

main();
