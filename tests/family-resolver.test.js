import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { FamilyResolver } from "../src/routing/family-resolver.js";
import {
  buildRuntimeConfigFromApiConfig,
  compareHostFallbackPlan,
  configuredProvidersFromApiConfig,
  hostModelChainFromApiConfig,
} from "../src/capabilities.js";
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

const fallbackProviders = {
  google: { models: {
    "gemini-3.5-flash": { family: "gemini-flash", release_date: "2026-05-19", cost: { input: 1.5, output: 9 } },
    "gemini-3.8-flash": { family: "gemini-flash", release_date: "2026-09-02", cost: { input: 0.75, output: 3.75 } },
  } },
  anthropic: { models: {
    "claude-haiku-4-5": { family: "claude-haiku", release_date: "2025-10-15", cost: { input: 1, output: 5 } },
    "claude-sonnet-4-6": { family: "claude-sonnet", release_date: "2026-02-17", cost: { input: 3, output: 15 } },
    "claude-sonnet-5": { family: "claude-sonnet", release_date: "2026-06-29", cost: { input: 2, output: 10 } },
  } },
  xai: { models: {
    "grok-4.3": { family: "grok", release_date: "2026-04-17", cost: { input: 1.25, output: 2.5 } },
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

test("acceptedModels prevents an unaccepted newer child from entering a family route", () => {
  const { dir, file } = catalog(fallbackProviders);
  try {
    const resolver = new FamilyResolver({ enabled: true, catalogPath: file, aliases: {
      flash: {
        family: "gemini-flash", providers: ["google"], strategy: "newest",
        acceptedModels: ["google/gemini-3.5-flash"],
      },
    } });
    assert.equal(resolver.resolve("flash", ["google"]).modelId, "gemini-3.5-flash");
  } finally { fs.rmSync(dir, { recursive: true }); }
});

test("declared lineage matching excludes adjacent Flash Lite and Pro families", () => {
  const { dir, file } = catalog({ google: { models: {
    "gemini-3.5-flash": { family: "gemini-flash", release_date: "2026-05-19", cost: { input: 1, output: 5 } },
    "gemini-3.5-flash-lite": { family: "gemini-flash-lite", release_date: "2026-06-01", cost: { input: 0.1, output: 0.5 } },
    "gemini-3.5-pro": { family: "gemini-pro", release_date: "2026-06-02", cost: { input: 2, output: 10 } },
  } } });
  try {
    const resolver = new FamilyResolver({ enabled: true, catalogPath: file, aliases: {
      flash: { family: "gemini-flash", providers: ["google"], strategy: "lowest_cost" },
    } });
    assert.equal(resolver.resolve("flash", ["google"]).modelId, "gemini-3.5-flash");
  } finally { fs.rmSync(dir, { recursive: true }); }
});

test("host plan resolves an ordered family ladder to accepted concrete children", () => {
  const { dir, file } = catalog(fallbackProviders);
  try {
    const resolver = new FamilyResolver({
      enabled: true,
      catalogPath: file,
      aliases: {
        flash: { family: "gemini-flash", providers: ["google"], strategy: "newest", acceptedModels: ["google/gemini-3.5-flash"] },
        haiku: { family: "claude-haiku", providers: ["anthropic"], strategy: "newest", acceptedModels: ["anthropic/claude-haiku-4-5"] },
        sonnet: { family: "claude-sonnet", providers: ["anthropic"], strategy: "newest", acceptedModels: ["anthropic/claude-sonnet-4-6"] },
        grok: { family: "grok", providers: ["xai"], strategy: "newest", acceptedModels: ["xai/grok-4.3"] },
      },
      hostPlan: { primary: "flash", fallbacks: ["haiku", "sonnet", "grok"] },
    });
    const plan = resolver.resolveHostPlan(["google", "anthropic", "xai"]);
    assert.equal(plan.status, "resolved");
    assert.equal(plan.primary, "google/gemini-3.5-flash");
    assert.deepEqual(plan.fallbacks, [
      "anthropic/claude-haiku-4-5",
      "anthropic/claude-sonnet-4-6",
      "xai/grok-4.3",
    ]);
    assert.deepEqual(plan.entries.map(({ position, role, family }) => ({ position, role, family })), [
      { position: 0, role: "primary", family: "gemini-flash" },
      { position: 1, role: "fallback", family: "claude-haiku" },
      { position: 2, role: "fallback", family: "claude-sonnet" },
      { position: 3, role: "fallback", family: "grok" },
    ]);
  } finally { fs.rmSync(dir, { recursive: true }); }
});

test("host plan fails closed when any family is unresolved or resolves twice", () => {
  const { dir, file } = catalog(fallbackProviders);
  try {
    let resolver = new FamilyResolver({ enabled: true, catalogPath: file, aliases: {
      flash: { family: "gemini-flash", providers: ["google"], acceptedModels: ["google/gemini-3.5-flash"] },
      missing: { family: "claude-opus", providers: ["anthropic"] },
    }, hostPlan: { primary: "flash", fallbacks: ["missing"] } });
    assert.deepEqual(resolver.resolveHostPlan(["google", "anthropic"]), {
      status: "unresolved", entries: [], primary: null, fallbacks: [], unresolvedAliases: ["missing"],
    });
    resolver = new FamilyResolver({ enabled: true, catalogPath: file, aliases: {
      first: { family: "gemini-flash", providers: ["google"], acceptedModels: ["google/gemini-3.5-flash"] },
      second: { family: "gemini-flash", providers: ["google"], acceptedModels: ["google/gemini-3.5-flash"] },
    }, hostPlan: { primary: "first", fallbacks: ["second"] } });
    assert.equal(resolver.resolveHostPlan(["google"]).status, "invalid_duplicate");
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
  assert.deepEqual(result.override, {
    modelOverride: "grok-fixed",
    providerOverride: "xai",
  });
  assert.equal(result.selectionReason, "cheap_default");
});

test("configured providers come only from OpenClaw provider configuration", () => {
  assert.deepEqual(configuredProvidersFromApiConfig({ models: { providers: { XAI: {}, anthropic: {} } } }), ["anthropic", "xai"]);
  assert.deepEqual(configuredProvidersFromApiConfig({ agents: { defaults: {
    model: { primary: "google/gemini", fallbacks: ["anthropic/haiku", "xai/grok"] },
    models: { "openai/gpt": {} },
  } } }), ["anthropic", "google", "openai", "xai"]);
  assert.deepEqual(configuredProvidersFromApiConfig({}), []);
});

test("host-configured model refs are authoritative routing candidates", () => {
  const runtime = buildRuntimeConfigFromApiConfig({ agents: { defaults: {
    model: { primary: "google/gemini", fallbacks: ["anthropic/haiku"] },
    models: { "ollama/glm4:9b": {}, "openai/gpt": { agentRuntime: { id: "sandboxed" } } },
  } } });
  assert.deepEqual(runtime.acceptedModelRefs.sort(), [
    "anthropic/haiku", "google/gemini", "ollama/glm4:9b", "openai/gpt",
  ]);
  assert.equal(runtime.byModel["openai/gpt"], "sandboxed");
});

test("host plan comparison reports alignment and drift without mutating host config", () => {
  const cfg = { agents: { defaults: { model: {
    primary: "google/gemini-3.5-flash",
    fallbacks: ["anthropic/claude-haiku-4-5", "anthropic/claude-sonnet-4-6", "xai/grok-4.3"],
  } } } };
  const host = hostModelChainFromApiConfig(cfg);
  const resolved = { status: "resolved", primary: host.primary, fallbacks: [...host.fallbacks] };
  assert.equal(compareHostFallbackPlan(resolved, host).status, "aligned");
  assert.equal(compareHostFallbackPlan({ ...resolved, fallbacks: [...host.fallbacks].reverse() }, host).status, "drift");
  assert.deepEqual(host, hostModelChainFromApiConfig(cfg));
});
