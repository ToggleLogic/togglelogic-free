/*
 * ToggleLogic (Free Tier) — billing refusal and next-turn routing regressions.
 * (c) 2026 Motherboard, Inc. Source-available under the ToggleLogic Free-Tier
 * License (see LICENSE); all rights reserved.
 * PATENT PENDING.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classifyProviderRefusal, createProviderAvailability } from '../src/usage/provider-refusal.js';
import { createInterceptor } from '../src/routing/interceptor.js';
import { normalizeConfig } from '../src/config/normalize.js';

for (const [message, reason] of [
  ['402 RESOURCE_EXHAUSTED: prepayment required', 'payment_required'],
  ['402 insufficient_quota', 'credits_depleted'],
  ['payment_required: Your credit balance is too low', 'credits_depleted'],
  ['HTTP 402 credits depleted', 'credits_depleted'],
  ['402 billing disabled', 'billing_disabled'],
  ['402 account suspended for billing', 'billing_disabled'],
  ['429 RESOURCE_EXHAUSTED: quota exceeded', null],
  ['RESOURCE_EXHAUSTED', null], ['quota exceeded', null],
  ['429 insufficient_quota', null], ['credit balance is too low', null],
  ['402 request failed', null], ['1402 credits depleted', null],
  ['x'.repeat(1000000) + '402 credits depleted', null],
]) test(`classifier: ${message.slice(0, 80)}`, () => assert.equal(classifyProviderRefusal(message), reason));

const output = (stopReason = 'error') => ({ provider: 'google', model: 'gemini-flash', lastAssistant: {
  role: 'assistant', provider: 'google', model: 'gemini-flash', stopReason, errorMessage: '402 prepayment required',
}, usage: { input: 0, output: 0 } });

test('cooldown suppresses duplicates, expires, and recovery requires success', () => {
  let now = 0; const events = [];
  const a = createProviderAvailability({ now: () => now, emit: (...args) => events.push(args) });
  a.observe(output()); a.observe(output());
  assert.equal(events.length, 1); assert.equal(a.unavailable('google'), true);
  now = 30 * 60000;
  assert.equal(a.unavailable('google'), false);
  a.observe({ ...output(), lastAssistant: undefined }); assert.equal(events.length, 1);
  a.observe(output('stop')); a.observe(output('stop'));
  assert.deepEqual(events.map(([event]) => event), ['provider_unavailable', 'provider_available']);
  a.observe(output()); assert.equal(events.length, 3);
});

test('zero usage and mismatched assistant attribution never prove refusal', () => {
  const a = createProviderAvailability();
  a.observe({ ...output(), lastAssistant: undefined });
  a.observe({ ...output(), lastAssistant: { ...output().lastAssistant, provider: 'other' } });
  assert.equal(a.unavailable('google'), false);
});

test('next-turn reroute and owner override conflict are recorded', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tl-refusal-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const statePath = path.join(dir, 'override.json');
  const availability = createProviderAvailability(); availability.observe(output());
  const rows = [];
  const route = createInterceptor({ config: normalizeConfig({ mode: 'passthrough', ownerOverride: { enabled: true, statePath } }),
    hostConfig: { agents: { defaults: { model: { primary: 'google/gemini-flash', fallbacks: ['google/gemini-pro', 'anthropic/claude-haiku'] } } } },
    availability, logger: { async write(row) { rows.push(row); } }, seam: { status: () => 'unavailable' } });
  assert.deepEqual(await route({}, {}), { providerOverride: 'anthropic', modelOverride: 'claude-haiku' });
  assert.equal(rows[0].selectionReason, 'provider_unavailable');
  await fs.writeFile(statePath, JSON.stringify({ active: true, model_ref: 'google/gemini-flash' }));
  assert.deepEqual(await route({}, {}), { modelOverride: 'gemini-flash', providerOverride: 'google' });
  assert.equal(rows[1].selectionReason, 'owner_override');
  assert.equal(rows[1].selectionDetails.providerUnavailableConflict, true);
});

test('no available fallback fails explicitly', async () => {
  const availability = createProviderAvailability(); availability.observe(output());
  const route = createInterceptor({ config: normalizeConfig({}), hostConfig: { agents: { defaults: { model: 'google/gemini-flash' } } },
    availability, logger: { async write() {} }, seam: { status: () => 'unavailable' } });
  await assert.rejects(route({}, {}), /no available configured fallback/);
});
