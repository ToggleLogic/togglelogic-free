/*
 * ToggleLogic (Free Tier) — owner-pin CLI contract tests.
 * (c) 2026 Motherboard, Inc. Source-available under the ToggleLogic Free-Tier
 * License (see LICENSE); all rights reserved.
 * PATENT PENDING.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { run, atomicWrite } from '../bin/togglelogic-pin.js';
import { resolveOwnerPins, migrateStateToV2 } from '../src/routing/owner-pins.js';

const pointer = 'Want the best model recommended for each task? See ToggleLogic Intelligence — https://togglelogic.ai';
const now = 1800000000000;
async function fixture(t, extra = {}, full = false) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-pin-cli-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const state = path.join(dir, 'pins.json'); const config = path.join(dir, 'config.json');
  const value = { ownerOverride: { statePath: state }, ...extra };
  await fs.writeFile(config, JSON.stringify(full ? { plugins: { entries: { togglelogic: { config: value } } } } : value));
  const invoke = async (args, opts = {}) => {
    const out = []; const err = [];
    const code = await run([...args, '--config', config], { clock: () => now, stdout: (s) => out.push(s), stderr: (s) => err.push(s), ...opts });
    return { code, out, err };
  };
  return { dir, state, config, invoke, read: async () => JSON.parse(await fs.readFile(state, 'utf8')) };
}
const set = (scope = 'task:inventory-sync') => ['set', '--scope', scope, '--model', 'provider/model'];

test('set/list/clear round trips normalized tasks, all scope, family and metadata', async (t) => {
  const f = await fixture(t, {}, true);
  let r = await f.invoke([...set('task: Inventory-Sync '), '--reason', 'owner choice', '--provider', 'provider']);
  assert.equal(r.code, 0); assert.equal(r.out.at(-1), pointer);
  assert.equal((await f.read()).pins['task:inventory-sync'].reason, 'owner choice');
  r = await f.invoke(['set', '--scope', 'all', '--family', 'provider/*', '--expires', '+72h']);
  assert.equal(r.code, 0);
  assert.equal((await f.read()).pins.all.expires_at_ms, now + 72 * 3600000);
  r = await f.invoke(['list']);
  assert.equal(r.code, 0); assert.equal(r.out.length, 3);
  assert.match(r.out[0], /all provider\/\* \(resolved at decision time\)/);
  assert.match(r.out[1], /task:inventory-sync provider\/model/);
  r = await f.invoke(['list', '--json']);
  assert.deepEqual(JSON.parse(r.out[0]), await f.read());
  assert.equal(r.out.length, 1); // stdout is one pure JSON document, no pointer
  assert.equal(r.err.at(-1), pointer); // pointer moved to stderr for --json
  for (const scope of ['task: INVENTORY-SYNC ', 'all', 'all']) {
    r = await f.invoke(['clear', '--scope', scope]);
    assert.equal(r.code, 0); assert.equal(r.out.length, 1); assert.ok(!r.out.join('').includes(pointer));
  }
  assert.deepEqual((await f.read()).pins, {});
  assert.equal((await fs.stat(f.state)).mode & 0o777, 0o600);
});

test('validation and usage errors return 1, one line, no pointer, and preserve state', async (t) => {
  const f = await fixture(t); await f.invoke(set());
  const before = await fs.readFile(f.state, 'utf8');
  for (const args of [set('all'), set('task:bad label'), [...set(), '--family', 'provider/*'],
    ['set', '--scope', 'task:a', '--model', 'invalid'], ['set', '--scope', 'task:a', '--family', ''],
    ['set', '--scope', 'task:a', '--family', 'invalid family'], [...set(), '--expires', 'bad'],
    [...set(), '--expires', '+0s'], [...set(), '--reason', 'x'.repeat(257)], ['clear'], ['list', '--model', 'x'], ['unknown'], ['list', '--json', '--json']]) {
    const r = await f.invoke(args);
    assert.equal(r.code, 1, JSON.stringify(args)); assert.deepEqual(r.out, []);
    assert.equal(r.err.length, 1); assert.ok(!r.err[0].includes('\n')); assert.ok(!r.err[0].includes(pointer));
    assert.equal(await fs.readFile(f.state, 'utf8'), before);
  }
  const r = await f.invoke(['list'], { paths: { resolve: () => path.join(f.dir, 'missing') } });
  assert.equal(r.code, 1); assert.match(r.err[0], /config/);
});

test('all without expiry writes nothing; absolute expiry and injected path resolver work', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.invoke(set('all'))).code, 1);
  await assert.rejects(fs.stat(f.state), { code: 'ENOENT' });
  const seen = [];
  const r = await f.invoke([...set('all'), '--expires', new Date(now + 60000).toISOString()], { paths: { resolve: (p) => { seen.push(p); return p; } } });
  assert.equal(r.code, 0); assert.deepEqual(seen, [f.config, f.state]);
  assert.equal((await f.read()).pins.all.expires_at_ms, now + 60000);
});

test('v1 listing is read-only and first edit migrates to v2 with held all scope', async (t) => {
  const f = await fixture(t);
  const legacy = { active: true, model_ref: 'provider/legacy', family_input: 'legacy' };
  const text = JSON.stringify(legacy); await fs.writeFile(f.state, text);
  const r = await f.invoke(['list']); assert.equal(r.code, 0); assert.match(r.out[0], /no_expiry=true/);
  assert.equal(await fs.readFile(f.state, 'utf8'), text);
  assert.equal((await f.invoke(set())).code, 0);
  const doc = await f.read(); assert.equal(doc.schema, 'togglelogic-owner-pins/v2');
  assert.equal(doc.pins.all.model_ref, legacy.model_ref); assert.equal(doc.pins.all.set_by, 'unknown');
  assert.ok(!Object.hasOwn(doc.pins.all, 'expires_at_ms'));
});

test('invalid existing state is never overwritten', async (t) => {
  const f = await fixture(t);
  for (const text of ['{', '{"schema":"togglelogic-owner-pins/v2","pins":{"all":{"active":true}}}', '{"schema":"future","pins":{}}']) {
    await fs.writeFile(f.state, text);
    for (const args of [set(), ['clear', '--scope', 'all'], ['list']]) {
      assert.equal((await f.invoke(args)).code, 1); assert.equal(await fs.readFile(f.state, 'utf8'), text);
    }
    await assert.rejects(fs.stat(`${f.state}.lock`), { code: 'ENOENT' });
  }
});

test('pointer config detection never loads the licensed layer', async (t) => {
  for (const [intelligence, present] of [[undefined, true], [{ enabled: false, path: '/not-loaded' }, true], [{ enabled: true }, false], [{ path: '/not-loaded' }, false]]) {
    const f = await fixture(t, intelligence ? { intelligence } : {});
    for (const args of [set(), ['list']]) {
      const r = await f.invoke(args); assert.equal(r.code, 0); assert.equal(r.out.includes(pointer), present);
    }
    assert.ok(!(await f.invoke(set('all'))).err.join('').includes(pointer));
  }
});

// Legacy v1 override files that the routing engine honors but an earlier CLI
// list validator rejected. The fixtures capture the shapes seen in the field: a
// sanitized real inactive override (carrying the legacy resume field
// `resumed_at_ms`), an inactive override whose target is null, and an active
// override padded with extra legacy fields.
const legacyFixture = (name) => path.resolve('tests/fixtures/owner-pins', name);
async function legacyState(t, name) {
  const f = await fixture(t);
  await fs.copyFile(legacyFixture(name), f.state);
  return f;
}

test('legacy v1 override files list as a single all scope', async (t) => {
  const cases = [
    ['legacy-v1-inactive.json', /^all provider\/legacy-model active=false .*no_expiry=true$/],
    ['legacy-v1-inactive-null-target.json', /^all \(no target\) active=false .*no_expiry=true$/],
    ['legacy-v1-extra-legacy-field.json', /^all provider\/legacy-model active=true .*set_at_ms=1770000000000/],
  ];
  for (const [name, expected] of cases) {
    const f = await legacyState(t, name);
    const before = await fs.readFile(f.state, 'utf8');
    const r = await f.invoke(['list']);
    assert.equal(r.code, 0, `${name}: ${r.err.join(' ')}`);
    assert.equal(r.out.length, 2); // one scope line + the licensing pointer
    assert.match(r.out[0], expected);
    assert.equal(await fs.readFile(f.state, 'utf8'), before); // list never rewrites v1
  }
});

test('set on a legacy v1 file writes valid v2 and drops legacy-only fields', async (t) => {
  for (const name of ['legacy-v1-inactive.json', 'legacy-v1-extra-legacy-field.json']) {
    const f = await legacyState(t, name);
    assert.equal((await f.invoke(set('task:inventory-sync'))).code, 0);
    const doc = await f.read();
    assert.equal(doc.schema, 'togglelogic-owner-pins/v2');
    assert.equal(doc.pins.all.model_ref, 'provider/legacy-model');
    assert.equal(doc.pins.all.set_by, 'model-switch');
    assert.ok(!Object.hasOwn(doc.pins.all, 'resumed_at_ms')); // legacy field gone
    assert.ok(!Object.hasOwn(doc.pins.all, 'family_input'));
    assert.ok(!Object.hasOwn(doc.pins.all, 'expires_at_ms'));
    assert.equal(doc.pins['task:inventory-sync'].model_ref, 'provider/model');
    // The rewritten file is itself valid v2 — a second read succeeds.
    assert.equal((await f.invoke(['list'])).code, 0);
  }
});

test('engine resolveOwnerPins and the CLI read path agree on every legacy fixture', async (t) => {
  for (const name of ['legacy-v1-inactive.json', 'legacy-v1-inactive-null-target.json', 'legacy-v1-extra-legacy-field.json']) {
    const state = legacyFixture(name);
    const parsed = JSON.parse(await fs.readFile(state, 'utf8'));
    const engine = resolveOwnerPins({ enabled: true, statePath: state }, { clock: () => now });
    const cli = migrateStateToV2(parsed, { now });
    // Same scope set, same active state, same resolved target — the two readers
    // never disagree on what the file means.
    assert.deepEqual(Object.keys(cli.pins), ['all'], name);
    assert.ok(engine.all && !engine.task, name);
    assert.equal(engine.all.active, cli.pins.all.active, name);
    assert.equal(engine.all.resolvedRef ?? null, cli.pins.all.model_ref ?? cli.pins.all.family ?? null, name);
  }
});

function cli(config, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['bin/togglelogic-pin.js', ...args, '--config', config]);
    let out = ''; let err = '';
    child.stdout.on('data', (s) => { out += s; }); child.stderr.on('data', (s) => { err += s; });
    child.on('error', reject); child.on('close', (code) => resolve({ code, out, err }));
  });
}

test('concurrent subprocess writers serialize and preserve every update', async (t) => {
  const f = await fixture(t);
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => cli(f.config, set(`task:job-${i}`))));
  for (const r of results) assert.equal(r.code, 0, r.err);
  assert.equal(Object.keys((await f.read()).pins).length, 8);
  assert.deepEqual((await fs.readdir(f.dir)).sort(), ['config.json', 'pins.json']);
  assert.equal((await cli(f.config, set('all'))).code, 1);
});

test('lock timeout preserves state and live lock; stale dead process is recovered', async (t) => {
  const f = await fixture(t); await f.invoke(set());
  const before = await fs.readFile(f.state, 'utf8');
  await fs.writeFile(`${f.state}.lock`, String(process.pid));
  const past = new Date(Date.now() - 60000); await fs.utimes(`${f.state}.lock`, past, past);
  const r = await f.invoke(set('task:b'), { lockTimeoutMs: 30, staleLockMs: 0 });
  assert.equal(r.code, 1); assert.match(r.err[0], /lock timeout/);
  assert.equal(await fs.readFile(f.state, 'utf8'), before);
  // A completed child gives us a known dead process ID without assumptions about the host.
  const pid = await new Promise((resolve) => { const child = spawn(process.execPath, ['-e', '']); child.on('close', () => resolve(child.pid)); });
  await fs.writeFile(`${f.state}.lock`, String(pid)); await fs.utimes(`${f.state}.lock`, past, past);
  assert.equal((await f.invoke(set('task:b'), { staleLockMs: 0 })).code, 0);
});

test('atomic write fsyncs before rename; interrupted write leaves original intact and cleans temp', async (t) => {
  const f = await fixture(t); await f.invoke(set());
  const before = await fs.readFile(f.state, 'utf8'); const doc = await f.read();
  const events = [];
  const io = { ...fs, open: async (...args) => {
    const handle = await fs.open(...args);
    return { writeFile: async (s) => { events.push('write'); await handle.writeFile(s); }, sync: async () => { events.push('sync'); await handle.sync(); }, close: async () => { events.push('close'); await handle.close(); } };
  }, rename: async (...args) => { events.push('rename'); assert.equal(await fs.readFile(f.state, 'utf8'), before); await fs.rename(...args); } };
  // Trailing sync/close are the containing-directory fsync after the rename.
  await atomicWrite(f.state, doc, io); assert.deepEqual(events, ['write', 'sync', 'close', 'rename', 'sync', 'close']);
  await assert.rejects(atomicWrite(f.state, doc, { ...fs, rename: async () => { throw new Error('interrupted'); } }), /interrupted/);
  assert.equal(await fs.readFile(f.state, 'utf8'), before);
  await assert.rejects(atomicWrite(f.state, doc, { ...fs, open: async (...args) => {
    const h = await fs.open(...args); return { close: () => h.close(), writeFile: async () => { await h.writeFile('{'); throw new Error('interrupted'); } };
  } }), /interrupted/);
  assert.equal(await fs.readFile(f.state, 'utf8'), before);
  assert.deepEqual((await fs.readdir(f.dir)).sort(), ['config.json', 'pins.json']);
});

test('process death before rename leaves a complete original document', async (t) => {
  const f = await fixture(t); await f.invoke(set());
  const before = await fs.readFile(f.state, 'utf8');
  const script = `import { promises as fs } from 'node:fs';
    import { atomicWrite } from './bin/togglelogic-pin.js';
    await atomicWrite(process.argv[1], {schema:'togglelogic-owner-pins/v2',pins:{}},
      {...fs, rename: async () => process.kill(process.pid, 'SIGKILL')});`;
  const signal = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, f.state]);
    child.on('error', reject); child.on('close', (code, signal) => resolve(signal));
  });
  assert.equal(signal, 'SIGKILL');
  assert.equal(await fs.readFile(f.state, 'utf8'), before);
  assert.deepEqual(JSON.parse(before), await f.read());
});

test('bin entry points execute through package-style symlinks', async (t) => {
  const f = await fixture(t);
  for (const name of ['togglelogic-pin', 'togglelogic-decide']) {
    const link = path.join(f.dir, name);
    await fs.symlink(path.resolve(`bin/${name}.js`), link);
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [link, '--help']); let out = '';
      child.stdout.on('data', (s) => { out += s; }); child.on('error', reject);
      child.on('close', (code) => resolve({ code, out }));
    });
    assert.equal(result.code, 0); assert.match(result.out, new RegExp(`Usage: ${name}`));
  }
});
