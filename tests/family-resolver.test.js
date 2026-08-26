import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { FamilyResolver } from "../src/routing/family-resolver.js";
import { configuredProvidersFromApiConfig } from "../src/capabilities.js";
import { dispatchByMode } from "../src/routing/modes.js";

function catalog(data) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tl-family-"));
  const file = path.join(dir, "models.json");
  fs.writeFileSync(file, JSON.stringify({ data }));
  return { dir, file };
}

const providers = {
  xai: { models: {
    "grok-4.3": { family: "grok", release_date: "2026-07-01", cost: { input: 2, output: 10 } },
    "grok-4.5": { family: "grok", release_date: "2026-08-01", cost: { input: 3, output: 15 } },
    "grok-free-preview": { family: "grok", release_date: "2026-09-01", cost: { input: 0, output: 0 } },
  } },
  openrouter: { models: {
    "grok-4.6": { family: "grok", release_date: "2026-08-20", cost: { input: 1, output: 5 } },
  } },
};

test("family resolution uses explicit alias, approved configured providers, and complete prices", () => {
  const { dir, file } = catalog(providers);
  try {
    const resolver = new FamilyResolver({ enabled: true, catalogPath: file, aliases: {
      grok: { family: "grok", providers: ["xai"], strategy: "lowest_cost" },
    } });
    assert.deepEqual(resolver.resolve("grok", ["xai", "openrouter"]), {
      provider: "xai", modelId: "grok-4.3", inputPerM: 2, outputPerM: 10,
      blendedCost: 12, releaseDate: "2026-07-01",
    });
  } finally { fs.rmSync(dir, { recursive: true }); }
});

test("newest strategy remains inside price ceilings and configured providers", () => {
  const { dir, file } = catalog(providers);
  try {
    const resolver = new FamilyResolver({ enabled: true, catalogPath: file, aliases: {
      grok: { family: "grok", providers: ["xai", "openrouter"], strategy: "newest", maxInputPerM: 3, maxOutputPerM: 15 },
    } });
    assert.equal(resolver.resolve("grok", ["xai"]).modelId, "grok-4.5");
    assert.equal(resolver.resolve("grok", []), null);
  } finally { fs.rmSync(dir, { recursive: true }); }
});

test("missing, corrupt, stale, or unconfigured family data fails to null", () => {
  const { dir, file } = catalog(providers);
  try {
    let resolver = new FamilyResolver({ enabled: true, catalogPath: file, maxAgeHours: 1, aliases: { grok: { family: "grok", providers: ["xai"] } } });
    fs.utimesSync(file, new Date(0), new Date(0));
    assert.equal(resolver.resolve("grok", ["xai"]), null);
    fs.writeFileSync(file, "not-json");
    fs.utimesSync(file, new Date(), new Date());
    assert.equal(resolver.resolve("grok", ["xai"]), null);
    resolver = new FamilyResolver({ enabled: false, catalogPath: file, aliases: {} });
    assert.equal(resolver.resolve("grok", ["xai"]), null);
  } finally { fs.rmSync(dir, { recursive: true }); }
});

test("configured family route passes through safely when resolution fails", async () => {
  const result = await dispatchByMode({
    mode: "configured", event: {}, hookContext: {}, seam: {}, configuredProviders: [],
    config: { configuredRoutes: { default: "family:grok" }, familyResolution: { aliases: {} } },
    familyResolver: { resolve: () => null },
  });
  assert.deepEqual(result.override, {});
  assert.equal(result.selectionDetails.reason, "family route unresolved");
});

test("configured family route emits split provider and model overrides", async () => {
  const result = await dispatchByMode({
    mode: "configured", event: {}, hookContext: {}, seam: {}, configuredProviders: ["xai"],
    config: { configuredRoutes: { default: "family:grok" }, familyResolution: { aliases: { grok: { strategy: "lowest_cost" } } } },
    familyResolver: { resolve: () => ({ provider: "xai", modelId: "grok-4.3" }) },
  });
  assert.deepEqual(result.override, { providerOverride: "xai", modelOverride: "grok-4.3" });
  assert.equal(result.selectedModel, "xai/grok-4.3");
});

test("cheap mode remains static and never calls the family resolver", async () => {
  const result = await dispatchByMode({
    mode: "cheap", event: {}, hookContext: {}, seam: {}, configuredProviders: ["xai"],
    config: { cheapHeuristic: { default: "xai/grok-fixed", order: [] } },
    familyResolver: { resolve: () => { throw new Error("must not run"); } },
  });
  assert.deepEqual(result.override, { modelOverride: "xai/grok-fixed" });
  assert.equal(result.selectionReason, "cheap_default");
});

test("configured providers come only from OpenClaw provider configuration", () => {
  assert.deepEqual(configuredProvidersFromApiConfig({ models: { providers: { XAI: {}, anthropic: {} } } }), ["anthropic", "xai"]);
  assert.deepEqual(configuredProvidersFromApiConfig({}), []);
});
