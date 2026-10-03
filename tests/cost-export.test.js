/*
 * ToggleLogic (Free Tier) — offline CSV/JSON export golden and CLI tests.
 * (c) 2026 Motherboard, Inc. Source-available under the ToggleLogic Free-Tier
 * License (see LICENSE); all rights reserved.
 * PATENT PENDING.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { exportLedger, formatExport } from "../src/usage/cost-export.js";
import { monthBounds } from "../src/usage/ledger-reader.js";
import { rotated, current } from "./fixtures/cost-export-fixture.js";

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../bin/togglelogic-cost.js", import.meta.url));
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tl-export-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const ledgerPath = path.join(dir, "cost.jsonl");
  const write = (file, rows) => fs.writeFile(file, rows.map(JSON.stringify).join("\n") + "\n");
  await write(ledgerPath + ".2", rotated);
  await write(ledgerPath, current);
  await write(ledgerPath + ".backup", current); // not a numeric rotation
  return { dir, ledgerPath, write };
}

test("CSV and JSON goldens include every call and deployment/provider/lineage rollups in dollars", async (t) => {
  const f = await fixture(t), report = await exportLedger({ ledgerPath: f.ledgerPath, month: "2026-09" });
  assert.deepEqual(report.totals, { calls: 6, pricedUsd: 1.05, unpricedCalls: 1, usageMissingCalls: 1, billableUsd: 0.55 });
  assert.equal(report.rollup.length, 2);
  assert.equal(report.rows.at(-1).ts, "2026-09-30T23:30:00.000Z");
  assert.equal(report.rows.filter((row) => row.invoiceEligible).length, 1, "only an already reconciled row retains eligibility");
  assert.equal(report.incomplete, true);
  for (const format of ["csv", "json"]) {
    const expected = await fs.readFile(new URL(`./fixtures/cost-export.${format}`, import.meta.url), "utf8");
    assert.equal(formatExport(report, format), expected);
  }
});

test("export CLI stdout and output file work offline, without overwriting input or existing output", async (t) => {
  const f = await fixture(t);
  const args = [cli, "export", "--month", "2026-09", "--ledger", f.ledgerPath];
  const result = await exec(process.execPath, args);
  assert.equal(JSON.parse(result.stdout).totals.pricedUsd, 1.05);
  assert.equal(result.stderr, "");
  const out = path.join(f.dir, "export.csv");
  await exec(process.execPath, [...args, "--format", "csv", "--out", out]);
  assert.match(await fs.readFile(out, "utf8"), /timezone=UTC/);
  await assert.rejects(exec(process.execPath, [...args, "--out", out]), /Cannot create output file/);
  const before = await fs.readFile(f.ledgerPath, "utf8");
  await assert.rejects(exec(process.execPath, [...args, "--out", f.ledgerPath]), /Cannot create output file/);
  assert.equal(await fs.readFile(f.ledgerPath, "utf8"), before);
  for (const tail of [["--month", "2026-13"], ["--month", "2026-09", "--format", "xml"],
    ["--month", "2026-09", "--unknown", "x"], ["--month", "2026-09", "--month", "2026-10"]]) {
    await assert.rejects(exec(process.execPath, [cli, "export", ...tail]));
  }
});

test("missing and corrupt ledgers are explicitly incomplete; malformed tails never hide valid rows", async (t) => {
  const f = await fixture(t);
  await fs.appendFile(f.ledgerPath, '{incomplete\n{"kind":"call","ts":"bad"}\n');
  const report = await exportLedger({ ledgerPath: f.ledgerPath, month: "2026-09" });
  assert.deepEqual(report.diagnostics, { filesRead: 2, malformedRows: 1, invalidTimestampRows: 1 });
  assert.equal(report.totals.calls, 6);
  const empty = await exportLedger({ ledgerPath: path.join(f.dir, "missing.jsonl"), month: "2026-09" });
  assert.equal(empty.incomplete, true); assert.equal(empty.diagnostics.filesRead, 0);
  assert.equal(empty.rows.length, 0);
});

test("CSV quotes text, neutralizes spreadsheet formulas, and exports no arbitrary error or credential fields", async (t) => {
  const f = await fixture(t);
  await f.write(f.ledgerPath, [{ ...current[0], costCenter: 'team,"west"', provider: "=formula", error: "PRIVATE_ERROR", apiKey: "PRIVATE_KEY" }]);
  const report = await exportLedger({ ledgerPath: f.ledgerPath, month: "2026-09" });
  const csv = formatExport(report, "csv");
  assert.match(csv, /"team,""west"""/);
  assert.match(csv, /'=formula/);
  assert.doesNotMatch(csv + JSON.stringify(report), /PRIVATE_ERROR|PRIVATE_KEY/);
});

test("UTC bounds cover leap February and December rollover", () => {
  assert.equal(monthBounds("2028-02").endExclusive, "2028-03-01T00:00:00.000Z");
  assert.equal(monthBounds("2026-12").endExclusive, "2027-01-01T00:00:00.000Z");
  for (const month of [undefined, "2026-00", "2026-13", "26-09", "0000-01"]) assert.throws(() => monthBounds(month));
});
