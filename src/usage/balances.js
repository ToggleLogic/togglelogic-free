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
import { eventEnvelope } from "./events.js";
import { resolveOpenClawPath } from "../path-utils.js";

export const BALANCE_NOTICE = "Estimate only: priced observed spend is a floor on spend; remaining may be overstated. Unpriced and usage-missing calls are excluded from spend. Retained ledger history may be incomplete.";
const validProvider = (value) => typeof value === "string" && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(value);
const validAmount = (value) => Number.isFinite(value) && value > 0 && Number.isSafeInteger(dollarsToMicros(value)) && dollarsToMicros(value) > 0;
const validDate = (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;

export function createBalances({ config = {}, ledgerPath, events, deploymentId, costCenter, now = () => Date.now(), deps = {} } = {}) {
  const target = resolveOpenClawPath(config.path ?? "~/.openclaw/togglelogic/balances.jsonl");
  const lowUsd = config.lowBalanceUsd ?? 10, lowPct = config.lowBalancePct ?? 20;
  const io = deps.fs ?? fs;
  const replay = deps.readLedger ?? readLedger;
  let cachedRows = [], stamp = null;
  async function read() {
    let stat;
    try { stat = await io.stat(target); }
    catch (error) { if (error.code === "ENOENT") { stamp = null; cachedRows = []; return []; } throw error; }
    const nextStamp = `${stat.mtimeMs}:${stat.size}`;
    if (stamp === nextStamp) return cachedRows;
    let text;
    try { text = await io.readFile(target, "utf8"); }
    catch (error) { if (error.code === "ENOENT") return []; throw new Error("Cannot read balance history"); }
    try {
      if (text && !text.endsWith("\n")) throw new Error();
      const rows = text.split("\n").filter((line) => line.trim()).map((line) => {
        const row = JSON.parse(line);
        if (row.kind === "topup" && validProvider(row.provider) && validAmount(row.amountUsd) && validDate(row.date) && typeof row.id === "string") return row;
        if (row.event === "provider_balance_low" && validProvider(row.provider) && typeof row.period === "string") return row;
        throw new Error();
      });
      cachedRows = rows; stamp = nextStamp; return rows;
    } catch { throw new Error("Invalid balance history; restore a valid file before continuing"); }
  }
  async function locked(fn) {
    await io.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const lock = target + ".lock", owner = `${process.pid}-${randomUUID()}.json`;
    const staging = lock + "." + randomUUID();
    await io.mkdir(staging, { mode: 0o700 });
    await io.writeFile(path.join(staging, owner), JSON.stringify({ pid: process.pid, ts: now() }), { mode: 0o600 });
    const alive = deps.pidAlive ?? ((pid) => {
      try { process.kill(pid, 0); return true; } catch (error) { return error.code !== "ESRCH"; }
    });
    async function recover() {
      try {
        const entries = await io.readdir(lock);
        if (!entries.length) {
          if (now() - (await io.stat(lock)).mtimeMs > 60000) { await io.rmdir(lock); return; }
          return false;
        }
        for (const entry of entries) {
          if (!/^\d+-[a-f0-9-]+\.json$/.test(entry)) continue;
          const record = JSON.parse(await io.readFile(path.join(lock, entry), "utf8"));
          if (Number.isInteger(record.pid) && record.pid > 0 && Number.isFinite(record.ts) && now() - record.ts > 60000 && !alive(record.pid)) {
            // Remove only the uniquely named dead owner's record. Another
            // contender cannot accidentally unlink a replacement live owner.
            await io.unlink(path.join(lock, entry));
          }
        }
        await io.rmdir(lock); // only succeeds if empty
      } catch (error) {
        if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code)) throw error;
      }
    }
    let held = false;
    try {
      for (let i = 0; i < (deps.lockAttempts ?? 100); i++) {
        if (await recover() === false) { await delay(20); continue; }
        try {
          // A nonempty directory is published atomically: no crash window
          // between acquiring the lock and recording its owner.
          await io.rename(staging, lock); held = true; break;
        } catch (error) {
          if (!["EEXIST", "ENOTEMPTY"].includes(error.code)) throw error;
          await delay(20);
        }
      }
      if (!held) throw new Error("Balance history is locked by a live or recent writer; retry");
      return await fn();
    } finally {
      const directory = held ? lock : staging;
      await io.unlink(path.join(directory, owner));
      try { await io.rmdir(directory); } catch (error) { if (error.code !== "ENOTEMPTY" && error.code !== "ENOENT") throw error; }
    }
  }
  const append = async (row) => {
    await io.appendFile(target, JSON.stringify(row) + "\n", { mode: 0o600 });
    stamp = null;
  };
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
  const days = new Map();
  let diagnostics = { filesRead: 0, malformedRows: 0, invalidTimestampRows: 0 };
  let startup;
  function add(row) {
    if (row.kind !== "call" || !validProvider(row.provider) || !Number.isFinite(Date.parse(row.ts)) || Date.parse(row.ts) > now()) return;
    const day = new Date(row.ts).toISOString().slice(0, 10);
    const key = `${row.provider}/${day}`;
    const value = days.get(key) ?? { provider: row.provider, day, spentMicros: 0, unpricedCalls: 0, usageMissingCalls: 0 };
    const state = classifyLedgerCall(row);
    if (state.priced) value.spentMicros += dollarsToMicros(row.costUsd);
    if (!Number.isSafeInteger(value.spentMicros)) throw new Error("Spend total exceeds supported precision");
    if (state.unpriced) value.unpricedCalls++;
    if (state.usageMissing) value.usageMissingCalls++;
    days.set(key, value);
  }
  function start() {
    startup ??= replay(resolveOpenClawPath(ledgerPath ?? "~/.openclaw/logs/togglelogic-cost.jsonl"), add).then((result) => { diagnostics = result; });
    return startup;
  }
  async function record(row) { await start(); add(row); }
  async function reports(rows, provider) {
    if (provider !== undefined && !validProvider(provider)) throw new Error("Invalid provider ID");
    await start();
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
    for (const value of days.values()) {
      const total = totals.get(value.provider);
      if (!total || value.day < total.firstTopup) continue;
      total.spentMicros += value.spentMicros;
      total.unpricedCalls += value.unpricedCalls;
      total.usageMissingCalls += value.usageMissingCalls;
      if (!Number.isSafeInteger(total.spentMicros)) throw new Error("Spend total exceeds supported precision");
    }
    return [...totals.values()].map(({ topupMicros, spentMicros, ...value }) => ({ ...value, basis: "estimate",
      topupsUsd: microsToDollars(topupMicros), pricedSpendUsd: microsToDollars(spentMicros),
      estimatedRemainingUsd: microsToDollars(topupMicros - spentMicros),
      historyIncomplete: !diagnostics.filesRead || diagnostics.malformedRows > 0 || diagnostics.invalidTimestampRows > 0,
      notice: BALANCE_NOTICE }));
  }
  const balance = async (provider) => reports(await read(), provider);
  async function check(correlation = {}) {
    if (!(await read()).some((row) => row.kind === "topup")) return [];
    return locked(async () => {
      const rows = await read();
      const values = await reports(rows);
      for (const value of values) {
        if (rows.some((row) => row.event === "provider_balance_low" && row.provider === value.provider && row.period === value.period)) continue;
        const usd = value.estimatedRemainingUsd <= lowUsd;
        const pct = value.estimatedRemainingUsd * 100 <= value.topupsUsd * lowPct;
        if (!usd && !pct) continue;
        const event = { schema: "togglelogic.event.v1", event: "provider_balance_low", ...eventEnvelope({ deploymentId, costCenter, ...correlation }), provider: value.provider,
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
  return { topup, balance, check, start, record, path: target };
}
