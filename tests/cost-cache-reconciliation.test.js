/*
 * ToggleLogic (Free Tier) — cache-token pricing reconciliation tests.
 *
 * The 2026-09-15 incident logged $1.44 by billing 501,344 cache tokens at the
 * FULL input rate — ~1.9x the model's own report. The fix: one calculation
 * (pricing.costBreakdown) shared by the cost log and the owner receipt, which
 * prices cache tokens from SOURCE cache-tier rates when present and otherwise
 * from a documented input-rate proxy, stating the basis LOUDLY.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createPricing, buildIndex } from "../src/usage/pricing.js";
import { createCostObserver } from "../src/usage/cost-observer.js";
import { normalizeConfig } from "../src/config/normalize.js";

let cacheSeq = 0;
function pricingWith(modelsDev, cfg = {}) {
  // Unique cache path per pricing instance so one test's saved feed never
  // shadows another's fetched feed.
  const cachePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tl-pricecache-")), `c${cacheSeq++}.json`);
  return createPricing(
    // Test isolation is authoritative: normalized production defaults may
    // contain the live ~/.openclaw cache path, so apply the temporary path
    // after the supplied configuration rather than allowing it to be replaced.
    { ...cfg, sourceUrl: "https://example.invalid/none", cachePath },
    { warn() {} },
    { fetchImpl: async () => ({ ok: true, json: async () => modelsDev }), now: () => 1_800_000_000_000 },
  );
}

test("cache reads are NOT billed at the full input rate (the incident overcharge is gone)", async () => {
  // gemini-flash-like: input 1.5/Mtok, output 6/Mtok, no source cache rate.
  const pricing = pricingWith({ google: { models: { "gemini-3.5-flash": { cost: { input: 1.5, output: 6 } } } } });
  const price = await pricing.resolve("google/gemini-3.5-flash");
  const usage = { input: 452391, output: 1202, cacheRead: 501344, cacheWrite: 0 };
  const bd = pricing.costBreakdown(price, usage);
  // Old (buggy) math billed cache at 1.5/Mtok → cacheReadUsd ≈ 0.752.
  const oldCacheCost = (501344 * 1.5) / 1e6;
  assert.ok(bd.cacheReadUsd < oldCacheCost * 0.5, "cache read priced below half the full-input-rate overcharge");
  assert.equal(bd.cacheBasis, "input-rate-proxy");
  // Proxy default is 0.25x input.
  assert.ok(Math.abs(bd.cacheReadUsd - (501344 * 1.5 * 0.25) / 1e6) < 1e-9);
});

test("source cache-tier rates are used when the feed supplies them", async () => {
  const pricing = pricingWith({ anthropic: { models: { "claude-sonnet-4-6": { cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 } } } } });
  const price = await pricing.resolve("anthropic/claude-sonnet-4-6");
  assert.equal(price.cacheReadPerM, 0.3);
  assert.equal(price.cacheWritePerM, 3.75);
  const bd = pricing.costBreakdown(price, { input: 1000, output: 500, cacheRead: 10000, cacheWrite: 2000 });
  assert.equal(bd.cacheBasis, "source-cache-rate");
  assert.ok(Math.abs(bd.cacheReadUsd - (10000 * 0.3) / 1e6) < 1e-12);
  assert.ok(Math.abs(bd.cacheWriteUsd - (2000 * 3.75) / 1e6) < 1e-12);
});

test("no cache tokens → cacheBasis is 'no-cache-tokens' and total == input+output only", async () => {
  const pricing = pricingWith({ openai: { models: { "gpt-5.5": { cost: { input: 2, output: 8 } } } } });
  const price = await pricing.resolve("openai/gpt-5.5");
  const bd = pricing.costBreakdown(price, { input: 1000, output: 1000 });
  assert.equal(bd.cacheBasis, "no-cache-tokens");
  assert.ok(Math.abs(bd.total - (1000 * 2 + 1000 * 8) / 1e6) < 1e-12);
});

test("configurable cache multipliers flow from config → pricing", async () => {
  const cfg = normalizeConfig({ costVisibility: { pricing: { cacheReadMultiplier: 0.1, cacheWriteMultiplier: 1.25 } } });
  assert.equal(cfg.costVisibility.pricing.cacheReadMultiplier, 0.1);
  assert.equal(cfg.costVisibility.pricing.cacheWriteMultiplier, 1.25);
  const pricing = pricingWith({ google: { models: { "gemini-3.5-flash": { cost: { input: 1.5, output: 6 } } } } }, cfg.costVisibility.pricing);
  const price = await pricing.resolve("google/gemini-3.5-flash");
  const bd = pricing.costBreakdown(price, { input: 0, output: 0, cacheRead: 1_000_000, cacheWrite: 1_000_000 });
  assert.ok(Math.abs(bd.cacheReadUsd - 1.5 * 0.1) < 1e-9);
  assert.ok(Math.abs(bd.cacheWriteUsd - 1.5 * 1.25) < 1e-9);
});

test("costUsd and costBreakdown.total agree — ONE calculation for log and receipt", async () => {
  const pricing = pricingWith({ google: { models: { "gemini-3.5-flash": { cost: { input: 1.5, output: 6 } } } } });
  const price = await pricing.resolve("google/gemini-3.5-flash");
  const usage = { input: 452391, output: 1202, cacheRead: 501344 };
  assert.equal(pricing.costUsd(price, usage), pricing.costBreakdown(price, usage).total);
});

test("the cost observer stamps cacheBasis and cache token split on the priced row", async () => {
  const events = [];
  const observer = createCostObserver({
    config: normalizeConfig({ costVisibility: { log: { enabled: false } } }),
    fallbackLogger: { warn() {} },
    deps: {
      logger: { write: async (r) => events.push(r), path: "(none)" },
      pricing: {
        resolve: async () => ({ provider: "google", curated: true, priced: true, inputPerM: 1.5, outputPerM: 6, source: "test" }),
        costBreakdown: (p, u) => ({ total: 0.75, cacheBasis: "input-rate-proxy", cacheReadUsd: 0.188, cacheWriteUsd: 0, cacheReadRatePerM: 0.375, cacheWriteRatePerM: null }),
        ensureIndex: async () => {},
      },
      now: () => 1_800_000_000_000,
    },
  });
  await observer.handler({ provider: "google", model: "gemini-3.5-flash", usage: { input: 452391, output: 1202, cacheRead: 501344 } });
  const row = events.find((r) => r.kind === "call");
  assert.equal(row.cacheBasis, "input-rate-proxy");
  assert.equal(row.cacheReadTok, 501344);
  assert.equal(row.cacheWriteTok, 0);
  assert.equal(row.cacheReadPerM, 0.375);
  assert.equal(row.costUsd, 0.75);
});

test("buildIndex keeps source cache rates only when positive", () => {
  const idx = buildIndex({ modelsDev: { anthropic: { models: {
    "claude-a": { cost: { input: 3, output: 15, cache_read: 0.3 } },
    "claude-b": { cost: { input: 3, output: 15, cache_read: 0 } },
  } } } });
  const a = idx.get("claude-a"); const b = idx.get("claude-b");
  assert.equal(a.cacheReadPerM, 0.3);
  assert.equal(b.cacheReadPerM, undefined);
});
