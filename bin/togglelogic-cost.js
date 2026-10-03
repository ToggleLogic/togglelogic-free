#!/usr/bin/env node
/*
 * ToggleLogic (Free Tier) — offline cost ledger command line export.
 * (c) 2026 Motherboard, Inc. Source-available under the ToggleLogic Free-Tier
 * License (see LICENSE); all rights reserved.
 * PATENT PENDING.
 */
import { promises as fs } from "node:fs";
import { exportLedger, formatExport } from "../src/usage/cost-export.js";
import { resolveOpenClawPath } from "../src/path-utils.js";

const USAGE = "Usage: togglelogic-cost export --month YYYY-MM [--format csv|json] [--ledger <path>] [--out <path>]";
async function main(args) {
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) { console.log(USAGE); return; }
  if (args.shift() !== "export") throw new Error(USAGE);
  const options = {};
  while (args.length) {
    const name = args.shift();
    if (!["--month", "--format", "--ledger", "--out"].includes(name) || options[name] !== undefined ||
        !args.length || args[0].startsWith("--")) throw new Error(USAGE);
    options[name] = args.shift();
  }
  const format = options["--format"] ?? "json";
  if (!["json", "csv"].includes(format)) throw new Error("Format must be csv or json");
  const ledgerPath = resolveOpenClawPath(options["--ledger"] ?? "~/.openclaw/logs/togglelogic-cost.jsonl");
  const report = await exportLedger({ month: options["--month"], ledgerPath });
  const text = formatExport(report, format);
  if (options["--out"]) {
    // Refuse existing paths, including a live ledger, rather than truncate them.
    try { await fs.writeFile(resolveOpenClawPath(options["--out"]), text, { flag: "wx", mode: 0o600 }); }
    catch { throw new Error("Cannot create output file; choose a new writable path"); }
  } else process.stdout.write(text);
}
main(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 1; });
