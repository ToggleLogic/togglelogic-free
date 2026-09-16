/*
 * ToggleLogic (Free Tier) — spend-snapshot generator argument tests (Blocker 2).
 *
 * `openclaw gateway usage-cost` DEFAULTS to a 30-day window, which can omit day 1
 * of a 31-day policy month when the refresh runs late in the month. The generator
 * must pass `--days` with a floor of MIN_USAGE_DAYS (35) so the whole current
 * month is always covered, then rely on the downstream policy-month filter. These
 * tests pin the exact exec argv without shelling out (the script guards main() so
 * importing it never runs `openclaw`).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseArgs,
  usageCostArgs,
  effectiveDays,
  MIN_USAGE_DAYS,
} from "../scripts/generate-spend-snapshot.mjs";

test("MIN_USAGE_DAYS covers the longest month with slack", () => {
  assert.ok(MIN_USAGE_DAYS >= 35, "must exceed 31 days plus timezone slack");
});

test("usageCostArgs includes --days and the window is never below MIN_USAGE_DAYS", () => {
  const args = usageCostArgs();
  assert.deepEqual(args.slice(0, 5), ["gateway", "usage-cost", "--all-agents", "--expect-final", "--json"]);
  const idx = args.indexOf("--days");
  assert.ok(idx >= 0, "--days must be passed to openclaw");
  const days = Number(args[idx + 1]);
  assert.ok(Number.isInteger(days) && days >= 35, `window ${days} must be >= 35`);
});

test("effectiveDays floors below-minimum requests up to MIN_USAGE_DAYS", () => {
  assert.equal(effectiveDays(1), MIN_USAGE_DAYS);
  assert.equal(effectiveDays(30), MIN_USAGE_DAYS);
  assert.equal(effectiveDays(35), MIN_USAGE_DAYS);
  assert.equal(effectiveDays(undefined), MIN_USAGE_DAYS);
  assert.equal(effectiveDays(NaN), MIN_USAGE_DAYS);
  // A larger explicit window is honored (older rows are filtered out downstream).
  assert.equal(effectiveDays(60), 60);
  assert.equal(usageCostArgs(60)[usageCostArgs(60).indexOf("--days") + 1], "60");
});

test("parseArgs defaults --days to MIN_USAGE_DAYS and parses an explicit value", () => {
  assert.equal(parseArgs(["--free", "1.6.1-rc.3", "--intelligence", "1.4.1-rc.3"]).days, MIN_USAGE_DAYS);
  assert.equal(parseArgs(["--days", "40"]).days, 40);
});

test("a below-floor --days still produces an argv with >= 35 days", () => {
  const args = parseArgs(["--days", "10"]);
  const argv = usageCostArgs(args.days);
  assert.equal(Number(argv[argv.indexOf("--days") + 1]), MIN_USAGE_DAYS);
});
