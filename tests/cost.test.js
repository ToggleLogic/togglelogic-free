/*
 * ToggleLogic (Free Tier) — cost-visibility unit tests (node --test, no deps).
 * (c) 2026 Motherboard, Inc. Source-available under the ToggleLogic Free-Tier License.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isCurated, providerOf, candidateKeys, coreModel } from "../src/usage/normalize-ref.js";
import { buildIndex, createPricing } from "../src/usage/pricing.js";
import { createTally } from "../src/usage/cost-tally.js";
import { createCostObserver } from "../src/usage/cost-observer.js";
import { normalizeConfig } from "../src/config/normalize.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Representative Models.dev-shaped fixture (curated first-party + one non-curated).
const MODELSDEV = {
  anthropic: { models: {
    "claude-opus-4-7": { cost: { input: 5, output: 25 } },
    "claude-haiku-4-5-20251001": { cost: { input: 1, output: 5 } },
    "claude-sonnet-4-6": { cost: { input: 3, output: 15 } },
  } },
  google: { models: {
    "gemini-3.5-flash": { cost: { input: 1.5, output: 9 } },
    "gemini-3-flash-preview": { cost: { input: 0.5, output: 3 } },
  } },
  xai: { models: { "grok-4.3": { cost: { input: 1.25, output: 2.5 } } } },
  openai: { models: {
    "gpt-5.4-mini": { cost: { input: 0.75, output: 4.5 } },
    "gpt-5.1": { cost: { input: 1.25, output: 10 } },
  } },
  togetherai: { models: { "meta-llama/Llama-3.3-70B-Instruct-Turbo": { cost: { input: 1.04, output: 1.04 } } } },
  deepseek: { models: { "deepseek-v3": { cost: { input: 0.27, output: 1.1 } } } },
};

const PROOF = {
  "google/gemini-3-flash-preview": [0.5, 3],
  "google/gemini-3.5-flash": [1.5, 9],
  "anthropic/claude-opus-4-7": [5, 25],
  "anthropic/claude-haiku-4-5": [1, 5],       // date-stripped alias
  "anthropic/claude-sonnet-4-6": [3, 15],
  "xai/grok-4.3": [1.25, 2.5],
  "openai/gpt-5.4-mini": [0.75, 4.5],
  "openai/gpt-5.1": [1.25, 10],
  "openai-codex/gpt-5.4-mini": [0.75, 4.5],    // provider alias
  "together/meta-llama/Llama-3.3-70B-Instruct-Turbo": [1.04, 1.04], // llama family
};

function pricingFrom(modelsDev, extra = {}) {
  // no cache, no network — resolve straight from the injected index
  const p = createPricing(
    { cachePath: path.join(os.tmpdir(), `tl-nocache-${Math.random().toString(36).slice(2)}.json`), refreshHours: 24, ...extra },
    { warn() {} },
    { fetchImpl: async () => ({ ok: true, json: async () => modelsDev }), now: () => 1_800_000_000_000 }
  );
  return p;
}

test("normalization: curation gate + provider inference", () => {
  assert.equal(isCurated("anthropic/claude-opus-4-7"), true);
  assert.equal(isCurated("openai-codex/gpt-5.4-mini"), true);
  assert.equal(providerOf("openai-codex/gpt-5.4-mini"), "openai");
  assert.equal(providerOf("xai/grok-4.3"), "xai");
  assert.equal(providerOf("together/meta-llama/Llama-3.3-70B-Instruct-Turbo"), "meta");
  assert.equal(isCurated("deepseek/deepseek-v3"), false);
  assert.equal(isCurated("mistral/mistral-large"), false);
});

test("resolve: every proof-bar ref resolves to the right dollar price", async () => {
  const p = pricingFrom(MODELSDEV);
  for (const [ref, [i, o]] of Object.entries(PROOF)) {
    const r = await p.resolve(ref);
    assert.equal(r.priced, true, `${ref} should be priced`);
    assert.equal(r.inputPerM, i, `${ref} input`);
    assert.equal(r.outputPerM, o, `${ref} output`);
  }
});

test("loud-fail: non-curated and curated-but-absent are unpriced, never $0.00", async () => {
  const p = pricingFrom(MODELSDEV);
  const nonCurated = await p.resolve("deepseek/deepseek-v3");
  assert.equal(nonCurated.curated, false);
  assert.equal(nonCurated.priced, false);
  assert.equal(p.costUsd(nonCurated, { input: 1000, output: 500 }), null); // NOT 0

  const absent = await p.resolve("anthropic/claude-does-not-exist-99");
  assert.equal(absent.curated, true);
  assert.equal(absent.priced, false);
  assert.equal(p.costUsd(absent, { input: 1000, output: 500 }), null); // NOT 0
});

test("costUsd: dollar math (per-million) is correct", async () => {
  const p = pricingFrom(MODELSDEV);
  const r = await p.resolve("anthropic/claude-opus-4-7"); // $5/$25 per M
  // 1,000,000 input + 200,000 output => $5 + $5 = $10
  assert.equal(p.costUsd(r, { input: 1_000_000, output: 200_000 }), 10);
});

test("fallback: Models.dev unreachable -> bundled LiteLLM prices, not a crash, not $0.00", async () => {
  const p = createPricing(
    { cachePath: path.join(os.tmpdir(), `tl-nocache-${Math.random().toString(36).slice(2)}.json`) },
    { warn() {} },
    { fetchImpl: async () => { throw new Error("ENETUNREACH (simulated)"); }, now: () => 1_800_000_000_000 }
  );
  const r = await p.resolve("anthropic/claude-opus-4-7");
  assert.equal(r.priced, true, "must resolve from the bundled fallback");
  assert.equal(r.source, "bundled");
  assert.ok(r.inputPerM > 0 && r.outputPerM > 0);
});

test("tally loud line: priced $ and unpriced warning always appear together", () => {
  const t = createTally({ now: () => 1_800_000_000_000 });
  t.record({ ref: "anthropic/claude-opus-4-7", provider: "anthropic", inputTok: 1000, outputTok: 500, priced: true, costUsd: 0.0175 });
  t.record({ ref: "mistral/mistral-large", provider: "mistral", inputTok: 2000, outputTok: 1000, priced: false });
  const line = t.loudLine();
  assert.match(line, /\$0\.0175/);
  assert.match(line, /⚠️ UNPRICED/);
  assert.match(line, /mistral\/mistral-large\(3000t\)/);
});

test("observe-only: handler returns undefined and never throws (even if pricing throws)", async () => {
  const events = [];
  const okObs = createCostObserver({
    config: normalizeConfig({ costVisibility: { log: { enabled: false } } }),
    fallbackLogger: { warn() {} },
    deps: {
      logger: { write: async (r) => events.push(r), path: "(none)" },
      pricing: { resolve: async () => ({ provider: "anthropic", curated: true, priced: true, inputPerM: 5, outputPerM: 25, source: "test" }), costUsd: () => 0.01, ensureIndex: async () => {} },
      now: () => 1_800_000_000_000,
    },
  });
  const ret = await okObs.handler({ provider: "anthropic", model: "claude-opus-4-7", resolvedRef: "anthropic/claude-opus-4-7", usage: { input: 1000, output: 500 } });
  assert.equal(ret, undefined, "llm_output observer must return undefined (observe-only)");
  assert.equal(events.length, 1);
  assert.equal(events[0].costUsd, 0.01);

  const throwObs = createCostObserver({
    config: normalizeConfig({ costVisibility: { log: { enabled: false } } }),
    fallbackLogger: { warn() {} },
    deps: {
      logger: { write: async () => {}, path: "(none)" },
      pricing: { resolve: async () => { throw new Error("boom"); }, costUsd: () => null, ensureIndex: async () => {} },
      now: () => 1_800_000_000_000,
    },
  });
  const ret2 = await throwObs.handler({ model: "x", usage: {} });
  assert.equal(ret2, undefined, "a pricing failure must be swallowed, not thrown into the gateway");
});

test("config: costVisibility defaults + feature toggle normalize", () => {
  const c = normalizeConfig({});
  assert.equal(c.features.costVisibility.enabled, false);
  assert.equal(c.costVisibility.pricing.sourceUrl, "https://models.dev/api.json");
  assert.equal(c.costVisibility.log.path, "~/.openclaw/logs/togglelogic-cost.jsonl");
  const c2 = normalizeConfig({ features: { costVisibility: { enabled: true } }, costVisibility: { pricing: { refreshHours: 6 } } });
  assert.equal(c2.features.costVisibility.enabled, true);
  assert.equal(c2.costVisibility.pricing.refreshHours, 6);
});
