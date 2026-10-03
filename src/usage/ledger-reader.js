/*
 * ToggleLogic (Free Tier) — offline streaming reader for rotated cost ledgers.
 * (c) 2026 Motherboard, Inc. Source-available under the ToggleLogic Free-Tier
 * License (see LICENSE); all rights reserved.
 * PATENT PENDING.
 */
import { promises as fs, createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";

export async function ledgerFiles(ledgerPath) {
  const dir = path.dirname(ledgerPath), base = path.basename(ledgerPath);
  let entries;
  try { entries = await fs.readdir(dir); }
  catch (error) { if (error.code === "ENOENT") return []; throw new Error("Cannot read ledger directory"); }
  return entries.filter((name) => name === base ||
    (name.startsWith(base + ".") && /^[1-9]\d*$/.test(name.slice(base.length + 1))))
    .sort((a, b) => Number(b.slice(base.length + 1) || 0) - Number(a.slice(base.length + 1) || 0))
    .map((name) => path.join(dir, name));
}

export async function readLedger(ledgerPath, onCall) {
  const files = await ledgerFiles(ledgerPath);
  const diagnostics = { filesRead: files.length, malformedRows: 0, invalidTimestampRows: 0 };
  for (const file of files) {
    const input = createReadStream(file, { encoding: "utf8" });
    const lines = createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (!line.trim()) continue;
        let row;
        try { row = JSON.parse(line); } catch { diagnostics.malformedRows++; continue; }
        if (!row || typeof row !== "object" || Array.isArray(row)) { diagnostics.malformedRows++; continue; }
        if (row.kind !== "call") continue;
        if (typeof row.ts !== "string" || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(row.ts) || !Number.isFinite(Date.parse(row.ts))) {
          diagnostics.invalidTimestampRows++; continue;
        }
        await onCall(row);
      }
    } catch { throw new Error("Cannot read cost ledger; retry with a stable ledger snapshot"); }
    finally { lines.close(); input.destroy(); }
  }
  return diagnostics;
}

export function monthBounds(month) {
  if (typeof month !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || month.startsWith("0000")) {
    throw new Error("Month must be YYYY-MM");
  }
  const start = new Date(`${month}-01T00:00:00.000Z`);
  const end = new Date(start); end.setUTCMonth(end.getUTCMonth() + 1);
  return { startInclusive: start.toISOString(), endExclusive: end.toISOString() };
}
