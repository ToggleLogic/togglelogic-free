/*
 * ToggleLogic (Free Tier) — every shipped source file carries the published license header.
 * (c) 2026 Motherboard, Inc. Source-available under the ToggleLogic Free-Tier
 * License (see LICENSE); all rights reserved.
 * PATENT PENDING.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function jsFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? jsFiles(full) : name.endsWith(".js") ? [full] : [];
  });
}

test("every shipped src/ and bin/ JavaScript file starts with the published license header", () => {
  const missing = [];
  for (const file of ["src", "bin"].flatMap((d) => jsFiles(path.join(root, d)))) {
    let head = readFileSync(file, "utf8");
    if (head.startsWith("#!")) head = head.slice(head.indexOf("\n") + 1);
    head = head.slice(0, 600);
    const ok = /^\/\*\n \* ToggleLogic \(Free Tier\) — .+\n/.test(head)
      && head.includes("(c) 2026 Motherboard, Inc.")
      && head.includes("ToggleLogic Free-Tier")
      && head.includes("PATENT PENDING");
    if (!ok) missing.push(path.relative(root, file));
  }
  assert.deepEqual(missing, [], `files missing the published header: ${missing.join(", ")}`);
});

test("no patent application numbers or filing dates in shipped files", () => {
  const offenders = [];
  for (const file of ["src", "bin"].flatMap((d) => jsFiles(path.join(root, d)))) {
    if (/\b6[0-9]\/[0-9]{3},[0-9]{3}\b/.test(readFileSync(file, "utf8"))) offenders.push(path.relative(root, file));
  }
  assert.deepEqual(offenders, []);
});
