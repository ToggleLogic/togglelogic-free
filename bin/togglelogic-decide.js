#!/usr/bin/env node
/*
 * ToggleLogic (Free Tier) — decision core command line (replay).
 * (c) 2026 Motherboard, Inc. Source-available under the ToggleLogic Free-Tier
 * License (see LICENSE); all rights reserved.
 * PATENT PENDING.
 */
import { promises as fs, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { normalizeConfig } from "../src/config/normalize.js";
import { replayRecords } from "../src/core/replay.js";
import { resolveOpenClawPath } from "../src/path-utils.js";

const USAGE = "Usage: togglelogic-decide replay --log <routing.jsonl> --config <openclaw.json | plugin config.json> [--json]\n" +
  "Re-runs recorded routing decisions against the policy and prints the differences. Reads only; writes nothing.";

// Accepts a full OpenClaw config (plugins.entries.togglelogic.config) or a bare
// ToggleLogic plugin config object.
export function pluginConfigFrom(raw) {
  return raw?.plugins?.entries?.togglelogic?.config ?? raw ?? {};
}

async function main(args) {
  if (!args.length || (args.length === 1 && ["--help", "-h"].includes(args[0]))) { console.log(USAGE); return; }
  if (args.shift() !== "replay") throw new Error(USAGE);
  const options = {};
  while (args.length) {
    const name = args.shift();
    if (name === "--json") { options.json = true; continue; }
    if (!["--log", "--config"].includes(name) || options[name] !== undefined || !args.length || args[0].startsWith("--")) throw new Error(USAGE);
    options[name] = args.shift();
  }
  if (!options["--log"] || !options["--config"]) throw new Error(USAGE);
  let raw;
  try { raw = JSON.parse(await fs.readFile(resolveOpenClawPath(options["--config"]), "utf8")); }
  catch { throw new Error("Cannot read --config as JSON"); }
  let text;
  try { text = await fs.readFile(resolveOpenClawPath(options["--log"]), "utf8"); }
  catch { throw new Error("Cannot read --log"); }
  const report = await replayRecords(text.split("\n"), normalizeConfig(pluginConfigFrom(raw)));
  if (options.json) { console.log(JSON.stringify(report, null, 2)); }
  else {
    const skipped = Object.entries(report.notReplayable).map(([reason, n]) => `${reason} ${n}`).join(", ") || "none";
    console.log(`policy ${report.policyDigest}`);
    console.log(`records ${report.total}; replayed ${report.replayed}; matched ${report.matched}; differ ${report.differences.length}; unparseable ${report.unparseable}`);
    console.log(`not replayable: ${skipped}`);
    for (const d of report.differences) {
      console.log(`DIFF ${d.requestId ?? "-"} ${d.timestamp ?? ""}: ${d.recorded.reason} ${d.recorded.model ?? "-"} -> ${d.replayed.reason} ${d.replayed.model ?? "-"}`);
    }
  }
  if (report.differences.length) process.exitCode = 2;
}
if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) main(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 1; });
