#!/usr/bin/env node
/*
 * ToggleLogic (Free Tier) — offline cost ledger command line export.
 * (c) 2026 Motherboard, Inc. Source-available under the ToggleLogic Free-Tier
 * License (see LICENSE); all rights reserved.
 * PATENT PENDING.
 */
import { promises as fs } from "node:fs";
import { createBalances, BALANCE_NOTICE } from "../src/usage/balances.js";
import { normalizeConfig } from "../src/config/normalize.js";
import { exportLedger, formatExport } from "../src/usage/cost-export.js";
import { resolveOpenClawPath } from "../src/path-utils.js";

async function balanceCommand(command, args) {
  const options = {};
  const allowed = command === "topup" ? ["--provider", "--amount", "--date", "--note", "--config"] : ["--provider", "--config"];
  while (args.length) {
    const name = args.shift();
    if (!allowed.includes(name) || options[name] !== undefined || !args.length || args[0].startsWith("--")) throw new Error("Invalid balance command options");
    options[name] = args.shift();
  }
  let raw = {};
  const explicitConfig = options["--config"] ?? process.env.OPENCLAW_CONFIG_PATH;
  try { raw = JSON.parse(await fs.readFile(resolveOpenClawPath(explicitConfig ?? "~/.openclaw/openclaw.json"), "utf8")); }
  catch (error) {
    if (explicitConfig || error.code !== "ENOENT") throw new Error("Cannot read config as JSON; provide --config with a valid JSON configuration");
  }
  const config = normalizeConfig(raw.plugins?.entries?.togglelogic?.config ?? {});
  const balances = createBalances({ config: config.costVisibility.balances, ledgerPath: config.costVisibility.log.path });
  if (command === "topup") {
    const row = await balances.topup({ provider: options["--provider"], amount: Number(options["--amount"]), date: options["--date"], note: options["--note"] });
    console.log(`Recorded top-up for ${row.provider} on ${row.date}.`);
  }
  const report = await balances.balance(options["--provider"]);
  console.log(JSON.stringify({ basis: "estimate", notice: BALANCE_NOTICE, providers: report, ...(report.length ? {} : { warning: "No recorded top-ups for the requested provider(s)" }) }, null, 2));
}

const USAGE = "Usage: togglelogic-cost export --month YYYY-MM [--format csv|json] [--ledger <path>] [--out <path>]\n       togglelogic-cost topup --provider <id> --amount <usd> --date YYYY-MM-DD [--note <text>] [--config <path>]\n       togglelogic-cost balance [--provider <id>] [--config <path>]";
async function main(args) {
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) { console.log(USAGE); return; }
  const command = args.shift();
  if (["topup", "balance"].includes(command)) return balanceCommand(command, args);
  if (command !== "export") throw new Error(USAGE);
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
