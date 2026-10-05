/*
 * ToggleLogic (Free Tier) — configured lineage resolution and failover regressions.
 * (c) 2026 Motherboard, Inc. Source-available under the ToggleLogic Free-Tier
 * License (see LICENSE); all rights reserved.
 * PATENT PENDING.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveLineage, configuredModels, createLineageResolver, auditFallbackPlan, validLineage } from '../src/routing/lineage-resolver.js';
import { createPricing } from '../src/usage/pricing.js';
import { createProviderAvailability } from '../src/usage/provider-refusal.js';
import { createInterceptor } from '../src/routing/interceptor.js';
import { normalizeConfig } from '../src/config/normalize.js';
import { registerCapabilities } from '../src/capabilities.js';

const catalog = [
  { ref: 'google/gemini-2-flash', releaseDate: '2025-01-01' },
  { ref: 'google/gemini-3.5-flash', releaseDate: '2026-06-01' },
  { ref: 'google/gemini-4-flash', releaseDate: '2026-09-01' },
  { ref: 'anthropic/claude-haiku-4-5', releaseDate: '2026-05-01' },
  { ref: 'ollama/example-2', releaseDate: '2026-02-01' },
];
const allowedModels = catalog.map((row) => row.ref);
const hostConfig = { agents: { defaults: { models: Object.fromEntries(allowedModels.map((ref) => [ref, {}])), model: {
  primary: 'google/gemini-3.5-flash', fallbacks: ['anthropic/claude-haiku-4-5'],
} } } };

test('newest dated child among host allowlist only, independent of version lexicography', () => {
  const result = resolveLineage({ lineage: 'google/gemini-flash', allowedModels: allowedModels.slice(0, 2), catalog });
  assert.deepEqual(result, { lineage: 'google/gemini-flash', child: 'google/gemini-3.5-flash', reason: 'newest-configured-release' });
  assert.equal(resolveLineage({ lineage: 'ollama/*', allowedModels, catalog }).child, 'ollama/example-2');
  const ties = [{ ref: 'example/model-9', releaseDate: '2026-01-01' }, { ref: 'example/model-10', releaseDate: '2026-01-01' }];
  for (const order of [ties, [...ties].reverse()]) {
    assert.equal(resolveLineage({ lineage: 'example/model', allowedModels: ties.map((r) => r.ref), catalog: order }).child, 'example/model-10');
  }
});

test('configured model collection respects restrictive allowlist and agent fallbacks', () => {
  assert.deepEqual(configuredModels({ ...hostConfig, models: { providers: { other: { models: [{ id: 'unallowed' }] } } } }), allowedModels);
  assert.deepEqual(configuredModels({ models: { providers: { example: { models: [{ id: 'model-2' }] } } }, agents: {
    defaults: { model: { primary: 'example/model-1', fallbacks: ['example/model-3'] } }, list: [{ id: 'worker', model: { primary: 'example/model-4', fallbacks: ['example/model-5'] } }],
  } }, 'worker'), ['example/model-2', 'example/model-4', 'example/model-5']);
});

test('public catalog refresh picks a newly appeared allowed child without changing lineage plan', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tl-lineage-price-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  let now = 100000000, feed = { google: { models: { 'gemini-2-flash': { release_date: '2025-01-01' } } } };
  const pricing = createPricing({ cachePath: path.join(dir, 'prices.json'), refreshHours: 1 }, null, {
    now: () => now, fetchImpl: async () => ({ ok: true, json: async () => feed }),
  });
  const resolve = createLineageResolver({ lineages: ['google/gemini-flash'], hostConfig, pricing });
  assert.equal((await resolve()).child, 'google/gemini-2-flash');
  feed = { google: { models: { ...feed.google.models, 'gemini-4-flash': { release_date: '2026-09-01' } } } };
  now += 3600001;
  assert.equal((await resolve()).child, 'google/gemini-4-flash');
  const restarted = createPricing({ cachePath: path.join(dir, 'prices.json') }, null, { now: () => now, fetchImpl: () => { throw new Error('offline'); } });
  assert.equal((await createLineageResolver({ lineages: ['google/gemini-flash'], hostConfig, pricing: restarted })()).child, 'google/gemini-4-flash');
});

test('cooldown skips a lineage and missing dates use explicit configured order', async () => {
  const resolve = createLineageResolver({ lineages: ['google/gemini-flash', 'anthropic/claude-haiku'], hostConfig,
    pricing: { catalog: async () => catalog }, availability: { unavailable: (p) => p === 'google' } });
  const result = await resolve(); assert.equal(result.child, 'anthropic/claude-haiku-4-5');
  assert.equal(result.skipped[0].reason, 'provider-unavailable');
  for (const value of [[], [{ ref: 'google/gemini-4-flash', releaseDate: null }], [{ ref: 'google/gemini-4-flash', releaseDate: '2026-02-30' }]]) {
    const fail = createLineageResolver({ lineages: ['google/gemini-flash'], hostConfig, pricing: { catalog: async () => value } });
    assert.equal((await fail()).reason, 'configured-order-no-release-date');
  }
  assert.equal(validLineage('google/gemini-3.5-flash'), false);
  assert.equal(validLineage('anthropic/claude-haiku'), true);
  assert.equal(resolveLineage({ lineage: 'google/gemini-4-flash', allowedModels, catalog }).reason, 'invalid-lineage');
});

test('startup audit warns only for numbered host fallbacks lacking matching lineages', () => {
  const events = [], warnings = [];
  const options = { hostConfig, audit: { emit: (row) => events.push(row) }, logger: { warn: (text) => warnings.push(text) } };
  assert.deepEqual(auditFallbackPlan({ ...options }).missing, ['anthropic/claude-haiku-4-5']);
  assert.equal(events[0].event, 'fallback.plan.check'); assert.equal(events[0].details.status, 'warning');
  assert.equal(warnings.length, 1);
  assert.deepEqual(auditFallbackPlan({ ...options, lineages: ['anthropic/claude-haiku'] }).missing, []);
  assert.deepEqual(auditFallbackPlan({ ...options, lineages: ['anthropic/*'] }).missing, []);
});

test('next-turn cooldown failover audits lineage and resolved child; empty plan uses host fallbacks', async () => {
  const availability = createProviderAvailability();
  availability.observe({ provider: 'google', model: 'gemini-3.5-flash', lastAssistant: { role: 'assistant', provider: 'google', model: 'gemini-3.5-flash', stopReason: 'error', errorMessage: '402 prepayment required' } });
  const config = normalizeConfig({ routing: { fallbackLineages: ['google/gemini-flash', 'anthropic/claude-haiku'] } });
  const events = [], rows = [];
  const options = { config, hostConfig, availability, audit: { emit: (row) => events.push(row) }, logger: { async write(row) { rows.push(row); } }, seam: { status: () => 'unavailable' } };
  const route = createInterceptor({ ...options, lineageResolver: createLineageResolver({ lineages: config.routing.fallbackLineages, hostConfig, availability, pricing: { catalog: async () => catalog } }) });
  assert.deepEqual(await route({}, {}), { providerOverride: 'anthropic', modelOverride: 'claude-haiku-4-5' });
  assert.equal(rows[0].selectionDetails.lineage, 'anthropic/claude-haiku');
  assert.equal(events.find((row) => row.details?.resolvedChild)?.details.resolvedChild, 'anthropic/claude-haiku-4-5');
  const fail = createInterceptor({ ...options, lineageResolver: createLineageResolver({ lineages: [], hostConfig, availability, pricing: { catalog: async () => [] } }) });
  assert.deepEqual(await fail({}, {}), { providerOverride: 'anthropic', modelOverride: 'claude-haiku-4-5' });
  assert.ok(events.some((row) => row.details?.resolutionReason === 'host-configured-fallback'));
});

test('registered llm_output refusal feeds registered routing using cached public release dates', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tl-lineage-hooks-'));
  const cachePath = path.join(dir, 'pricing.json');
  await fs.writeFile(cachePath, JSON.stringify({ fetchedAt: Date.now(), data: { anthropic: { models: { 'claude-haiku-4-5': { release_date: '2026-05-01' } } } } }));
  const hooks = new Map(), events = [];
  const config = normalizeConfig({ mode: 'passthrough', intelligence: { enabled: false },
    features: { routing: { enabled: true }, costVisibility: { enabled: true } }, routing: { fallbackLineages: ['anthropic/claude-haiku'] },
    logging: { path: path.join(dir, 'routing.jsonl') }, costVisibility: { pricing: { cachePath }, log: { path: path.join(dir, 'cost.jsonl') },
      balances: { path: path.join(dir, 'balances.jsonl') }, events: { path: path.join(dir, 'events.jsonl') } },
  });
  registerCapabilities({ config, version: 'test', audit: { emit: (row) => events.push(row) }, api: { config: hostConfig, on(name, handler) { hooks.set(name, [...hooks.get(name) ?? [], handler]); } } });
  const refusal = { provider: 'google', model: 'gemini-3.5-flash', lastAssistant: { role: 'assistant', provider: 'google', model: 'gemini-3.5-flash', stopReason: 'error', errorMessage: '402 prepayment required' } };
  // The high-priority availability observer is synchronous and independent of pricing.
  await hooks.get('llm_output')[0](refusal);
  assert.deepEqual(await hooks.get('before_model_resolve')[0]({}, {}), { providerOverride: 'anthropic', modelOverride: 'claude-haiku-4-5' });
  assert.ok(events.some((row) => row.details?.lineage === 'anthropic/claude-haiku'));
  // Writers are intentionally background sinks; clean up after queued work drains.
  t.after(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); await fs.rm(dir, { recursive: true, force: true }); });
});


test('configuration retains invalid fallback entries for audit without throwing', () => {
  for (const fallbackLineages of [['google/gemini-3.5-flash'], ['openai/gpt-5.5'], ['anthropic/claude-haiku-4-5'], [42], 'google/gemini-flash']) {
    const routing = normalizeConfig({ routing: { fallbackLineages } }).routing;
    assert.deepEqual(routing.fallbackLineages, []);
    assert.deepEqual(routing.invalidFallbackLineages, Array.isArray(fallbackLineages) ? fallbackLineages : [fallbackLineages]);
  }
  assert.deepEqual(normalizeConfig({ routing: { fallbackLineages: ['google/gemini-flash', 'ollama/*'] } }).routing.fallbackLineages,
    ['google/gemini-flash', 'ollama/*']);
});

test('a cached passthrough decision is invalidated by a new provider cooldown', async () => {
  const availability = createProviderAvailability();
  const rows = [];
  const config = normalizeConfig({ mode: 'passthrough' });
  const route = createInterceptor({ config, hostConfig, availability,
    lineageResolver: createLineageResolver({ lineages: ['anthropic/claude-haiku'], hostConfig, availability, pricing: { catalog: async () => catalog } }),
    logger: { async write(row) { rows.push(row); } }, seam: { status: () => 'unavailable' } });
  const event = { prompt: 'hello' }, context = { sessionKey: 'example-session' };
  await route.preflight(event, context);
  availability.observe({ provider: 'google', model: 'gemini-3.5-flash', lastAssistant: {
    role: 'assistant', provider: 'google', model: 'gemini-3.5-flash', stopReason: 'error', errorMessage: '402 prepayment required',
  } });
  assert.deepEqual(await route(event, context), { providerOverride: 'anthropic', modelOverride: 'claude-haiku-4-5' });
  assert.equal(rows.at(-1).selectionReason, 'provider_unavailable');
});

test('undated wildcard and local lineage resolve in host order without inventing dates', () => {
  const models = ['ollama/qwen2.5:7b', 'ollama/qwen2.5:14b'];
  assert.deepEqual(resolveLineage({ lineage: 'ollama/*', allowedModels: models, catalog: [] }),
    { lineage: 'ollama/*', child: models[0], reason: 'configured-order-no-release-date' });
  assert.deepEqual(resolveLineage({ lineage: 'ollama/qwen2.5:7b', allowedModels: models, catalog: [] }),
    { lineage: 'ollama/qwen2.5:7b', child: models[0], reason: 'configured-order-no-release-date' });
  assert.equal(resolveLineage({ lineage: 'ollama/*', allowedModels: [...models].reverse(), catalog: [] }).child, models[1]);
  assert.equal(resolveLineage({ lineage: 'ollama/*', allowedModels: models, catalog: [], unavailable: () => true }).child, null);
});

test('exhausted and throwing lineage plans pass through with event, warning and FAILURE audit', async () => {
  const { createUsageEvents } = await import('../src/usage/events.js');
  for (const lineageResolver of [async () => ({ child: null }), async () => { throw new Error('source unavailable'); }]) {
    const audit = [], rows = [], warnings = [], events = [];
    const usageEvents = createUsageEvents({ deploymentId: 'test', costCenter: 'team', logger: { async write(row) { events.push(row); } } });
    const route = createInterceptor({ config: normalizeConfig({ mode: 'passthrough' }),
      hostConfig: { agents: { defaults: { model: { primary: 'google/gemini-flash', fallbacks: ['google/gemini-pro'] } } } },
      availability: { unavailable: () => true }, lineageResolver, usageEvents,
      fallbackLogger: { warn: (text) => warnings.push(text) }, audit: { emit: (row) => audit.push(row) },
      logger: { async write(row) { rows.push(row); } }, seam: { status: () => 'unavailable' } });
    assert.deepEqual(await route({}, {}), {}); await usageEvents.flush();
    assert.equal(rows[0].selectionReason, 'fallback_unresolved');
    assert.equal(rows[0].selectedModel, 'google/gemini-flash');
    assert.ok(audit.some((row) => row.outcome === 'failure' && row.details.reason === 'no_available_fallback'));
    assert.match(warnings[0], /fallback_unresolved/);
    assert.equal(events[0].event, 'fallback_unresolved'); assert.equal(events[0].deploymentId, 'test');
    assert.equal(events[0].requestId, rows[0].requestId);
  }
});

test('empty lineage plan uses the first available permitted host fallback without fetching metadata', async () => {
  const localHost = { agents: { defaults: { model: { primary: 'google/gemini-flash',
    fallbacks: ['google/gemini-pro', 'ollama/local-small', 'ollama/local-large'] } } } };
  const availability = { unavailable: (provider) => provider === 'google' };
  const lineageResolver = createLineageResolver({ lineages: [], hostConfig: localHost, availability,
    pricing: { catalog() { assert.fail('empty plan must not fetch metadata'); } } });
  const route = createInterceptor({ config: normalizeConfig({}), hostConfig: localHost, availability, lineageResolver,
    logger: { async write() {} }, seam: { status: () => 'unavailable' } });
  assert.deepEqual(await route({}, {}), { providerOverride: 'ollama', modelOverride: 'local-small' });
});

test('unresolved plugin-selected model keeps its override unchanged', async () => {
  const config = normalizeConfig({ mode: 'configured', configuredRoutes: { default: 'google/gemini-flash' } });
  const route = createInterceptor({ config, availability: { unavailable: (provider) => provider === 'google' },
    hostConfig: { agents: { defaults: { model: 'ollama/local' } } }, lineageResolver: async () => ({ child: null }),
    logger: { async write() {} }, seam: { status: () => 'unavailable' } });
  assert.deepEqual(await route({}, {}), { providerOverride: 'google', modelOverride: 'gemini-flash' });
});
