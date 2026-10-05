/*
 * ToggleLogic (Free Tier) — resilient registration and shared event writer regressions.
 * (c) 2026 Motherboard, Inc. Source-available under the ToggleLogic Free-Tier
 * License (see LICENSE); all rights reserved.
 * PATENT PENDING.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { registerHooks } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { normalizeConfig } from '../src/config/normalize.js';
import { registerCapabilities } from '../src/capabilities.js';
import { createLineageResolver } from '../src/routing/lineage-resolver.js';

async function fixture(t, costEnabled = true) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tl-integration-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const hooks = new Map(), audit = [], warnings = [];
  const raw = { mode: 'passthrough', intelligence: { enabled: false },
    features: { routing: { enabled: true }, costVisibility: { enabled: costEnabled } },
    logging: { enabled: false, path: path.join(dir, 'routing.jsonl') },
    audit: { path: path.join(dir, 'audit.jsonl') },
    costVisibility: { attribution: { deploymentId: 'test', costCenter: 'team' },
      log: { enabled: false, path: path.join(dir, 'cost.jsonl') },
      events: { path: path.join(dir, 'events.jsonl'), rotateSizeMb: 1 } } };
  const api = { config: { agents: { defaults: { model: 'vendor/model' } } },
    logger: { warn: (message) => warnings.push(message) },
    on(name, handler) { hooks.set(name, [...(hooks.get(name) ?? []), handler]); } };
  const start = () => registerCapabilities({ api, config: normalizeConfig(raw), version: 'test', fallbackLogger: api.logger,
    audit: { emit(row) { audit.push(row); } } });
  return { dir, hooks, audit, warnings, raw, api, start };
}

// Exercise the real entry register() without an installed host or any install.
// Only the host's declarative entry wrapper is stubbed; all plugin code runs.
test('invalid lineage does not disable plugin registration, audit, routing or cost visibility', async (t) => {
  const f = await fixture(t);
  f.raw.routing = { fallbackLineages: ['google/gemini-3.5-flash', 'ollama/*', 'openai/gpt-5.5', 'google/gemini-flash'] };
  const loader = registerHooks({ resolve(specifier, context, next) {
    if (specifier === 'openclaw/plugin-sdk/plugin-entry') return {
      url: 'data:text/javascript,export const definePluginEntry = value => value;', shortCircuit: true,
    };
    return next(specifier, context);
  } });
  let plugin;
  try { plugin = (await import('../src/index.js')).default; } finally { loader.deregister(); }
  plugin.register({ ...f.api, pluginConfig: f.raw });
  assert.ok(f.hooks.has('before_model_resolve')); assert.equal(f.hooks.get('llm_output').length, 2);
  let rows = [];
  for (let i = 0; i < 100; i++) {
    try { rows = (await fs.readFile(f.raw.audit.path, 'utf8')).trim().split('\n').map(JSON.parse); } catch {}
    if (rows.some((row) => row.event === 'plugin.register')) break;
    await delay(10);
  }
  const registered = rows.find((row) => row.event === 'plugin.register');
  assert.ok(registered);
  assert.ok(registered.details.registeredCapabilities.includes('routing'));
  assert.ok(registered.details.registeredCapabilities.includes('costVisibility'));
  const plan = rows.find((row) => row.event === 'fallback.plan.check');
  assert.equal(plan.outcome, 'failure');
  assert.deepEqual(plan.details.invalidLineages, ['google/gemini-3.5-flash', 'openai/gpt-5.5']);
  assert.equal(f.warnings.filter((text) => text.includes('FALLBACK_PLAN_CHECK')).length, 1);
  const config = normalizeConfig(f.raw);
  assert.deepEqual(config.routing.fallbackLineages, ['ollama/*', 'google/gemini-flash']);
  const resolve = createLineageResolver({ lineages: config.routing.fallbackLineages,
    hostConfig: { agents: { defaults: { models: { 'google/gemini-flash': {}, 'ollama/local': {} } } } },
    pricing: { catalog: async () => [] } });
  assert.equal((await resolve()).child, 'ollama/local');
});

test('malformed plans remain auditable while omitted plans have no rejected entries', async (t) => {
  assert.deepEqual(normalizeConfig({}).routing.invalidFallbackLineages, []);
  for (const value of [null, 42, 'ollama/*', { invalid: true }]) {
    const routing = normalizeConfig({ routing: { fallbackLineages: value } }).routing;
    assert.deepEqual(routing.fallbackLineages, []);
    assert.deepEqual(routing.invalidFallbackLineages, [value]);
  }
  const f = await fixture(t);
  f.raw.features.routing.enabled = false;
  f.raw.routing = { fallbackLineages: ['google/gemini-3.5-flash'] };
  const runtime = f.start();
  assert.ok(runtime.registered.includes('costVisibility'));
  assert.deepEqual(f.audit[0].details.invalidLineages, ['google/gemini-3.5-flash']);
  assert.equal(f.warnings.length, 1);
});

const refusal = (provider) => ({ provider, model: 'model', lastAssistant: {
  role: 'assistant', provider, model: 'model', stopReason: 'error', errorMessage: '402 prepayment required',
} });

test('observer, availability and interceptor share one queue across concurrent emission and rotation', async (t) => {
  const f = await fixture(t);
  const target = f.raw.costVisibility.events.path;
  await fs.writeFile(target, JSON.stringify({ seed: 'x'.repeat(1024 * 1024 - 100) }) + '\n');
  const runtime = f.start();
  assert.strictEqual(runtime.costObserver.events, runtime.usageEvents);
  const seen = [];
  const emit = runtime.usageEvents.emit;
  runtime.usageEvents.emit = (event, data) => { seen.push(event); return emit(event, data); };
  const [availability, observer] = f.hooks.get('llm_output');
  const [route] = f.hooks.get('before_model_resolve');
  availability(refusal('vendor'));
  const count = 1800;
  await Promise.all(Array.from({ length: count }, async (_, i) => {
    availability(refusal(`vendor-${i}`));
    await Promise.all([observer({ provider: `vendor-${i}`, model: 'model' }), route({}, {})]);
  }));
  await runtime.costObserver.flushBalances(); await runtime.usageEvents.flush();
  const files = (await fs.readdir(f.dir)).filter((name) => /^events\.jsonl(?:\.\d+)?$/.test(name));
  assert.ok(files.length >= 3, 'exercise multiple rotations');
  const rows = [];
  for (const file of files) {
    const text = await fs.readFile(path.join(f.dir, file), 'utf8');
    assert.ok(text.endsWith('\n'));
    rows.push(...text.trim().split('\n').map(JSON.parse));
  }
  assert.equal(rows.filter((row) => row.seed).length, 1);
  assert.equal(rows.length, 3 * count + 2);
  assert.equal(new Set(rows.filter((row) => row.event === 'provider_unavailable').map((row) => row.provider)).size, count + 1);
  assert.equal(new Set(rows.filter((row) => row.event === 'model_unpriced').map((row) => row.resolvedRef)).size, count);
  assert.equal(new Set(rows.filter((row) => row.event === 'fallback_unresolved').map((row) => row.requestId)).size, count);
  for (const [event, expected] of [['provider_unavailable', count + 1], ['model_unpriced', count], ['fallback_unresolved', count]]) {
    assert.equal(seen.filter((type) => type === event).length, expected, `${event} reaches shared instance`);
    assert.equal(rows.filter((row) => row.event === event).length, expected, `${event} survives rotation`);
  }
});

test('routing emits through the shared writer when cost visibility is disabled', async (t) => {
  const f = await fixture(t, false);
  const runtime = f.start();
  assert.equal(runtime.costObserver, null);
  assert.ok(runtime.usageEvents);
  const seen = [], emit = runtime.usageEvents.emit;
  runtime.usageEvents.emit = (event, data) => { seen.push(event); return emit(event, data); };
  // Force a hook dependency failure; the safe routing boundary must still report it.
  const event = { get prompt() { throw new Error('synthetic routing failure'); } };
  assert.deepEqual(await f.hooks.get('before_model_resolve')[0](event, {}), {});
  await runtime.usageEvents.flush();
  assert.deepEqual(seen, ['fallback_unresolved']);
  const row = JSON.parse((await fs.readFile(f.raw.costVisibility.events.path, 'utf8')).trim());
  assert.equal(row.event, 'fallback_unresolved');
});
