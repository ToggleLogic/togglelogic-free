/*
 * ToggleLogic (Free Tier) — ledger completeness, billing, and price provenance tests.
 * (c) 2026 Motherboard, Inc. Source-available under the ToggleLogic Free-Tier
 * License (see LICENSE); all rights reserved.
 * PATENT PENDING.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { deriveLineage, billingFields } from "../src/usage/ledger-row.js";
import { createCostObserver } from "../src/usage/cost-observer.js";
import { createPricing } from "../src/usage/pricing.js";
import { normalizeConfig } from "../src/config/normalize.js";

const required = ["deploymentId", "costCenter", "provider", "model", "resolvedRef", "lineage", "lineageReason",
  "inputTok", "outputTok", "cacheTok", "cacheReadTok", "cacheWriteTok", "costUsd", "priceSource", "priceVersion",
  "unpriced", "usageMissing", "requestId", "billable", "invoiceEligible", "invoiceEligibleReason"];

test("every call outcome serializes complete fields and an explicit invoice reason", async () => {
  for (const priced of [true, false]) for (const present of [true, false]) for (const billable of [true, false]) {
    const rows = [];
    const observer = createCostObserver({ config: normalizeConfig({ costVisibility: {
      attribution: { deploymentId: "deployment", costCenter: "team", billable }, log: { enabled: false } } }),
      deps: { logger: { write: async (row) => rows.push(JSON.parse(JSON.stringify(row))) },
        eventLogger: { write: async () => {} },
        pricing: { resolve: async () => ({ priced, source: priced ? "models.dev" : null, priceVersion: priced ? 12345 : null }),
          costUsd: () => 0.02 } } });
    await observer.handler({ provider: "example", model: "model-v2", usage: present ? { input: 2, output: 1 } : {} });
    await observer.budgets.flush();
    const row = rows[0];
    for (const field of required) assert.ok(Object.hasOwn(row, field), `${field}: ${JSON.stringify(row)}`);
    assert.equal(row.lineage, "example/model");
    assert.equal(row.invoiceEligible, false);
    assert.equal(row.billable, priced && present && billable);
    assert.equal(row.invoiceEligibleReason, !priced ? "unpriced" : !present ? "usage-missing" :
      !billable ? "not-billable-deployment" : "public-rate-estimate");
    assert.equal(row.costUsd, priced && present ? 0.02 : null);
    assert.equal(row.priceVersion, priced ? 12345 : null);
  }
});

test("invoice reason precedence and deployment billable default", () => {
  assert.equal(normalizeConfig({}).costVisibility.attribution.billable, true);
  assert.deepEqual(billingFields({ priced: false, usageMissing: true, billableDeployment: false }),
    { billable: false, invoiceEligible: false, invoiceEligibleReason: "unpriced" });
});

test("lineage strips only terminal date/version components, with explicit failure reasons", () => {
  for (const ref of ["example/model-2.1", "example/model-v2-v3", "example/model-2026-09-28", "example/model@20260928", "example/model-v2:0"]) {
    assert.deepEqual(deriveLineage(ref), { lineage: "example/model", lineageReason: null });
  }
  for (const ref of ["example/model-2-fast", "example/model-70b", "example/vendor/model-fast"]) {
    assert.equal(deriveLineage(ref).lineage, ref);
  }
  for (const ref of [null, "model", "example/123", "example/v2", "example/model?key=value", "example/" + "x".repeat(600)]) {
    const result = deriveLineage(ref);
    assert.equal(result.lineage, null); assert.ok(result.lineageReason);
  }
});

test("pricing provenance is exact cache fetchedAt or hash of override/bundled bytes", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tl-price-version-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const cachePath = path.join(dir, "cache.json"), overridePath = path.join(dir, "override.json");
  let time = 100000000;
  const data = { google: { models: { "gemini-test": { cost: { input: 1, output: 2 } } } } };
  const deps = { now: () => time, fetchImpl: async () => ({ ok: true, json: async () => data }) };
  const price = createPricing({ cachePath }, null, deps);
  assert.equal((await price.resolve("google/gemini-test")).priceVersion, time);
  const cache = JSON.parse(await fs.readFile(cachePath, "utf8"));
  assert.equal(cache.fetchedAt, time);
  time += 100;
  const restarted = createPricing({ cachePath }, null, { now: () => time, fetchImpl: () => { throw new Error("offline"); } });
  assert.equal((await restarted.resolve("google/gemini-test")).priceVersion, cache.fetchedAt);
  time += 48 * 3600000;
  assert.equal((await restarted.resolve("google/gemini-test")).priceVersion, cache.fetchedAt, "stale cache preserves original fetch time");
  const bytes = '{"google/gemini-test":{"input":2,"output":3}}\n';
  await fs.writeFile(overridePath, bytes);
  const override = createPricing({ cachePath, userPriceOverridePath: overridePath }, null, deps);
  const resolved = await override.resolve("google/gemini-test");
  assert.equal(resolved.source, "override");
  assert.equal(resolved.priceVersion, `sha256:${createHash("sha256").update(bytes).digest("hex")}`);
  const bundled = JSON.parse(await fs.readFile(new URL("../src/usage/pricing-fallback.json", import.meta.url), "utf8"));
  const model = bundled.models.find((entry) => entry.p === "google" && entry.i > 0 && entry.o > 0);
  assert.ok(model);
  const fallback = createPricing({ cachePath: path.join(dir, "missing.json") }, null,
    { fetchImpl: async () => { throw new Error("offline"); } });
  const backup = await fallback.resolve(`${model.p}/${model.m}`);
  const bundledBytes = await fs.readFile(new URL("../src/usage/pricing-fallback.json", import.meta.url));
  assert.equal(backup.source, "bundled");
  assert.equal(backup.priceVersion, `sha256:${createHash("sha256").update(bundledBytes).digest("hex")}`);
});
