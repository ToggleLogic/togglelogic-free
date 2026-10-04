/*
 * ToggleLogic (Free Tier) — persistent prepaid balance estimates.
 * (c) 2026 Motherboard, Inc. Source-available under the ToggleLogic Free-Tier
 * License (see LICENSE); all rights reserved.
 * PATENT PENDING.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { readLedger } from "./ledger-reader.js";
import { classifyLedgerCall, dollarsToMicros, microsToDollars } from "./ledger-row.js";
import { resolveOpenClawPath } from "../path-utils.js";

export const BALANCE_NOTICE = "Estimate only: priced observed spend is a floor on spend; remaining may be overstated. Unpriced and usage-missing calls are excluded from spend. Retained ledger history may be incomplete.";
const validProvider = (value) => typeof value === "string" && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(value);
const validAmount = (value) => Number.isFinite(value) && value > 0 && Number.isSafeInteger(dollarsToMicros(value)) && dollarsToMicros(value) > 0;
const validDate = (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;

export function createBalances({ config = {}, ledgerPath, events, now = () => Date.now() } = {}) {
  const target = resolveOpenClawPath(config.path ?? "~/.openclaw/togglelogic/balances.jsonl");
  const lowUsd = config.lowBalanceUsd ?? 10, lowPct = config.lowBalancePct ?? 20;
  async function read() {
    let text;
    try { text = await fs.readFile(target, "utf8"); }
    catch (error) { if (error.code === "ENOENT") return []; throw new Error("Cannot read balance history"); }
    try {
      if (text && !text.endsWith("\n")) throw new Error();
      return text.split("\n").filter((line) => line.trim()).map((line) => {
        const row = JSON.parse(line);
        if (row.kind === "topup" && validProvider(row.provider) && validAmount(row.amountUsd) && validDate(row.date) && typeof row.id === "string") return row;
        if (row.event === "provider_balance_low" && validProvider(row.provider) && typeof row.period === "string") return row;
        throw new Error();
      });
    } catch { throw new Error("Invalid balance history; restore a valid file before continuing"); }
  }
  async function locked(fn) {
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    let held = false;
    for (let i = 0; i < 100; i++) {
      try { await fs.mkdir(target + ".lock", { mode: 0o700 }); held = true; break; }
      catch (error) { if (error.code !== "EEXIST") throw new Error("Cannot lock balance history"); await delay(20); }
    }
    if (!held) throw new Error("Balance history is locked; retry, or inspect a stale lock after writer shutdown");
    try { return await fn(); } finally { await fs.rmdir(target + ".lock"); }
  }
  const append = (row) => fs.appendFile(target, JSON.stringify(row) + "\n", { mode: 0o600 });
  async function topup({ provider, amount, date, note }) {
    if (!validProvider(provider) || !validAmount(amount) || !validDate(date) || date > new Date(now()).toISOString().slice(0, 10)) {
      throw new Error("Top-up requires a provider ID, positive finite USD amount, and valid non-future YYYY-MM-DD date");
    }
    if (note !== undefined && (typeof note !== "string" || note.length > 500 || /[\x00-\x1f]/.test(note))) throw new Error("Note must be a single line of at most 500 characters");
    return locked(async () => {
      await read(); // Never append past a corrupt or interrupted history tail.
      const row = { kind: "topup", id: randomUUID(), provider, amountUsd: microsToDollars(dollarsToMicros(amount)), date,
        ts: new Date(now()).toISOString(), ...(note ? { note } : {}) };
      await append(row); return row;
    });
  }
  async function reports(rows, provider) {
    if (provider !== undefined && !validProvider(provider)) throw new Error("Invalid provider ID");
    const totals = new Map();
    for (const row of rows) {
      if (row.kind !== "topup" || (provider && row.provider !== provider)) continue;
      const value = totals.get(row.provider) ?? { provider: row.provider, topupMicros: 0, spentMicros: 0, firstTopup: row.date,
        unpricedCalls: 0, usageMissingCalls: 0 };
      value.topupMicros += dollarsToMicros(row.amountUsd);
      if (!Number.isSafeInteger(value.topupMicros)) throw new Error("Balance total exceeds supported precision");
      value.firstTopup = value.firstTopup < row.date ? value.firstTopup : row.date;
      value.period = row.id;
      totals.set(row.provider, value);
    }
    if (!totals.size) return [];
    const diagnostics = await readLedger(resolveOpenClawPath(ledgerPath ?? "~/.openclaw/logs/togglelogic-cost.jsonl"), (row) => {
      const total = totals.get(row.provider);
      if (!total || Date.parse(row.ts) < Date.parse(total.firstTopup) || Date.parse(row.ts) > now()) return;
      const state = classifyLedgerCall(row);
      if (state.priced) total.spentMicros += dollarsToMicros(row.costUsd);
      if (!Number.isSafeInteger(total.spentMicros)) throw new Error("Spend total exceeds supported precision");
      if (state.unpriced) total.unpricedCalls++;
      if (state.usageMissing) total.usageMissingCalls++;
    });
    return [...totals.values()].map(({ topupMicros, spentMicros, ...value }) => ({ ...value, basis: "estimate",
      topupsUsd: microsToDollars(topupMicros), pricedSpendUsd: microsToDollars(spentMicros),
      estimatedRemainingUsd: microsToDollars(topupMicros - spentMicros),
      historyIncomplete: !diagnostics.filesRead || diagnostics.malformedRows > 0 || diagnostics.invalidTimestampRows > 0,
      notice: BALANCE_NOTICE }));
  }
  const balance = async (provider) => reports(await read(), provider);
  async function check() {
    if (!(await read()).some((row) => row.kind === "topup")) return [];
    return locked(async () => {
      const rows = await read();
      const values = await reports(rows);
      for (const value of values) {
        if (rows.some((row) => row.event === "provider_balance_low" && row.provider === value.provider && row.period === value.period)) continue;
        const usd = value.estimatedRemainingUsd <= lowUsd;
        const pct = value.estimatedRemainingUsd * 100 <= value.topupsUsd * lowPct;
        if (!usd && !pct) continue;
        const event = { schema: "togglelogic.event.v1", event: "provider_balance_low", provider: value.provider,
          estimatedRemainingUsd: value.estimatedRemainingUsd, basis: "estimate", period: value.period,
          threshold: usd ? { kind: "usd", value: lowUsd } : { kind: "pct", value: lowPct }, ts: new Date(now()).toISOString() };
        // This append is the durable event and once-only marker. Secondary sinks
        // are best effort; the canonical event survives an interruption here.
        await append(event);
        await events?.emit("provider_balance_low", event);
      }
      return values;
    });
  }
  return { topup, balance, check, path: target };
}
