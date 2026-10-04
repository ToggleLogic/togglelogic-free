/*
 * ToggleLogic (Free Tier) — balance persistence, arithmetic and CLI regressions.
 * (c) 2026 Motherboard, Inc. Source-available under the ToggleLogic Free-Tier
 * License (see LICENSE); all rights reserved.
 * PATENT PENDING.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { createBalances } from '../src/usage/balances.js';
import { createCostObserver } from '../src/usage/cost-observer.js';
import { normalizeConfig } from '../src/config/normalize.js';

async function fixture(t, config = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tl-balances-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const ledgerPath = path.join(dir, 'cost.jsonl'), balancePath = path.join(dir, 'balances.jsonl');
  const events = [];
  const opts = { config: { path: balancePath, ...config }, ledgerPath,
    now: () => Date.parse('2026-10-04T12:00:00Z'), events: { async emit(event, data) { events.push({ event, ...data }); } } };
  const append = (rows, file = ledgerPath) => fs.appendFile(file, rows.map((row) => JSON.stringify({ kind: 'call', provider: 'example', ts: '2026-10-04T00:00:00Z', ...row })).join('\n') + '\n');
  return { dir, ledgerPath, balancePath, events, opts, append, balances: createBalances(opts) };
}

test('estimate math includes priced spend and missing-cost counts only since first top-up', async (t) => {
  const f = await fixture(t);
  await f.balances.topup({ provider: 'example', amount: 100, date: '2026-10-02' });
  await f.balances.topup({ provider: 'example', amount: 20, date: '2026-10-03' });
  await f.append([{ costUsd: 2, ts: '2026-10-01T00:00:00Z' }, { costUsd: 30 }, { costUsd: null, unpriced: true },
    { costUsd: null, usageMissing: true }, { costUsd: 10, provider: 'other' }]);
  const [value] = await f.balances.balance('example');
  assert.equal(value.estimatedRemainingUsd, 90); assert.equal(value.pricedSpendUsd, 30);
  assert.equal(value.unpricedCalls, 1); assert.equal(value.usageMissingCalls, 1);
  assert.equal(value.basis, 'estimate'); assert.match(value.notice, /floor on spend/);
  assert.deepEqual(await createBalances(f.opts).balance(), [value]);
  assert.deepEqual(await f.balances.balance('unknown'), []);
});

test('threshold once-only persists across restart and resets on a new top-up', async (t) => {
  const f = await fixture(t);
  await f.balances.topup({ provider: 'example', amount: 100, date: '2026-10-01' });
  await f.append([{ costUsd: 91 }]);
  await Promise.all([f.balances.check(), createBalances(f.opts).check()]);
  await createBalances(f.opts).check();
  assert.equal(f.events.length, 1); assert.deepEqual(f.events[0].threshold, { kind: 'usd', value: 10 });
  await f.balances.topup({ provider: 'example', amount: 1, date: '2026-10-04' });
  await f.balances.check(); assert.equal(f.events.length, 2);
  assert.notEqual(f.events[0].period, f.events[1].period);
});

test('percentage threshold and negative balance are estimates, never clamped', async (t) => {
  const f = await fixture(t, { lowBalanceUsd: 0, lowBalancePct: 20 });
  await f.balances.topup({ provider: 'example', amount: 100, date: '2026-10-01' });
  await f.append([{ costUsd: 80 }]); await f.balances.check();
  assert.deepEqual(f.events[0].threshold, { kind: 'pct', value: 20 });
  await f.append([{ costUsd: 30 }]);
  assert.equal((await f.balances.balance())[0].estimatedRemainingUsd, -10);
});

test('reject invalid entries, preserve corrupt history and flag incomplete ledgers', async (t) => {
  const f = await fixture(t);
  for (const values of [{ amount: -1 }, { amount: NaN }, { date: '2026-02-30' }, { date: '2099-01-01' }, { provider: 'https://invalid' }]) {
    await assert.rejects(f.balances.topup({ provider: 'example', amount: 1, date: '2026-10-01', ...values }));
  }
  await f.balances.topup({ provider: 'example', amount: 1, date: '2026-10-01' });
  assert.equal((await f.balances.balance())[0].historyIncomplete, true);
  await fs.appendFile(f.balancePath, '{broken');
  await assert.rejects(f.balances.topup({ provider: 'example', amount: 1, date: '2026-10-01' }), /Invalid balance history/);
});

test('CLI honors configured paths and persists between invocations', async (t) => {
  const f = await fixture(t);
  const configPath = path.join(f.dir, 'config.json');
  await fs.writeFile(configPath, JSON.stringify({ plugins: { entries: { togglelogic: { config: {
    costVisibility: { balances: { path: f.balancePath }, log: { path: f.ledgerPath } },
  } } } } }));
  const cli = (...args) => execFileSync(process.execPath, ['bin/togglelogic-cost.js', ...args, '--config', configPath], { encoding: 'utf8' });
  assert.match(cli('topup', '--provider', 'example', '--amount', '12.50', '--date', '2026-10-01', '--note', 'initial top-up'), /Recorded top-up/);
  const report = JSON.parse(cli('balance', '--provider', 'example'));
  assert.equal(report.providers[0].estimatedRemainingUsd, 12.5);
  assert.equal(report.basis, 'estimate');
});

test('cost observer checks threshold after its priced row is persisted', async (t) => {
  const f = await fixture(t);
  await f.balances.topup({ provider: 'example', amount: 11, date: '2026-10-01' });
  const config = normalizeConfig({ costVisibility: { balances: { path: f.balancePath }, log: { path: f.ledgerPath }, events: { path: path.join(f.dir, 'events.jsonl') } } });
  const observer = createCostObserver({ config, deps: { now: f.opts.now, pricing: { async resolve() { return { priced: true }; }, costUsd() { return 2; } } } });
  await observer.handler({ provider: 'example', model: 'model', usage: { input: 1, output: 1 } });
  await observer.flushBalances(); await observer.events.flush();
  const rows = (await fs.readFile(f.balancePath, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(rows[1].event, 'provider_balance_low');
  assert.equal(rows[1].estimatedRemainingUsd, 9);
});
