#!/usr/bin/env node
/*
 * ToggleLogic (Free Tier) — owner-pin command line.
 * (c) 2026 Motherboard, Inc. Source-available under the ToggleLogic Free-Tier
 * License (see LICENSE); all rights reserved.
 * PATENT PENDING.
 */
import { promises as fs, realpathSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { pluginConfigFrom } from './togglelogic-decide.js';
import { normalizeConfig } from '../src/config/normalize.js';
import { normalizeLabel } from '../src/routing/modes.js';
import { validLineage } from '../src/routing/lineage-resolver.js';
import { resolveOwnerPinsStatePath, migrateStateToV2 } from '../src/routing/owner-pins.js';
import { resolveOpenClawPath } from '../src/path-utils.js';

const POINTER = 'Want the best model recommended for each task? See ToggleLogic Intelligence — https://togglelogic.ai';
const SCHEMA = new URL('../docs/design/schemas/owner-pins.v2.schema.json', import.meta.url);
const USAGE = 'Usage: togglelogic-pin set|clear|list --config <file> [--scope all|task:<label>] [--model <ref>|--family <lineage>] [--provider <p>] [--expires <ISO8601|+duration>] [--reason <text>] [--json]';

// Dependency-free evaluator for the vocabulary used by the published v2 schema.
// Unknown keywords fail closed so a schema extension cannot silently weaken validation.
function matches(value, rule, root) {
  for (const key of Object.keys(rule)) {
    if (!['$schema', '$id', 'title', 'description', '$defs', '$ref', 'type', 'const', 'required', 'oneOf', 'not', 'properties', 'additionalProperties', 'propertyNames', 'pattern', 'maxLength', 'minimum'].includes(key)) throw new Error('Unsupported state schema keyword');
  }
  if (rule.$ref) return matches(value, root.$defs[rule.$ref.split('/').pop()], root);
  if (rule.type === 'object' && (!value || typeof value !== 'object' || Array.isArray(value))) return false;
  if (rule.type === 'string' && typeof value !== 'string') return false;
  if (rule.type === 'boolean' && typeof value !== 'boolean') return false;
  if (rule.type === 'integer' && !Number.isSafeInteger(value)) return false;
  if ('const' in rule && value !== rule.const) return false;
  if (rule.required?.some((key) => !Object.hasOwn(value, key))) return false;
  if (rule.not && matches(value, rule.not, root)) return false;
  if (rule.oneOf && rule.oneOf.filter((r) => matches(value, r, root)).length !== 1) return false;
  if (rule.pattern && !new RegExp(rule.pattern).test(value)) return false;
  if (rule.maxLength !== undefined && [...value].length > rule.maxLength) return false;
  if (rule.minimum !== undefined && value < rule.minimum) return false;
  if (rule.type === 'object') for (const [key, child] of Object.entries(value)) {
    if (rule.propertyNames && !matches(key, rule.propertyNames, root)) return false;
    const childRule = rule.properties && Object.hasOwn(rule.properties, key) ? rule.properties[key] : undefined;
    if (childRule) { if (!matches(child, childRule, root)) return false; }
    else if (rule.additionalProperties === false) return false;
    else if (typeof rule.additionalProperties === 'object' && !matches(child, rule.additionalProperties, root)) return false;
  }
  return true;
}

async function validate(doc) {
  const schema = JSON.parse(await fs.readFile(SCHEMA, 'utf8'));
  // The published v2 schema requires exactly one target (model_ref XOR family)
  // on EVERY pin. The routing engine consults a pin's target only when the pin
  // is ACTIVE — an inactive pin is reported inactive and never applied — so a
  // legacy inactive override with a null/absent target is honored on read. To
  // accept exactly what the engine accepts, validate the structure with that
  // oneOf relaxed to "never BOTH targets", then separately require exactly one
  // target on ACTIVE pins only. Active pins (the only shape the CLI ever writes)
  // stay strict; inactive/targetless legacy state lists instead of fail-closing.
  const { oneOf, ...pin } = schema.$defs.pin;
  const relaxed = { ...schema, $defs: { ...schema.$defs, pin: { ...pin, not: { required: ['model_ref', 'family'] } } } };
  if (!matches(doc, relaxed, relaxed)
    || Object.values(doc.pins).some((p) => p.active === true && (p.model_ref !== undefined) === (p.family !== undefined))
    || Object.values(doc.pins).some((p) => p.family !== undefined && !validLineage(p.family))) throw new Error('Invalid owner-pin state (v2 schema or family)');
}

async function readState(file, now) {
  let doc;
  try { doc = JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return { schema: 'togglelogic-owner-pins/v2', pins: {} }; throw new Error('Cannot read owner-pin state as JSON'); }
  // One shared v1→v2 read path with the routing engine (src/routing/owner-pins.js):
  // migrateStateToV2 applies the §3.3 migration exactly as resolveOwnerPins
  // interprets a v1 file — lifting only v2 fields onto the `all` pin and dropping
  // legacy resume/audit metadata such as resumed_at_ms — so the CLI accepts every
  // v1 file the engine accepts. A v2 (or unrecognized) document passes through
  // unchanged, preserving the strict v2 validation below.
  doc = migrateStateToV2(doc, { now });
  await validate(doc);
  return doc;
}

export async function atomicWrite(file, doc, io = fs) {
  const tmp = `${file}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await io.open(tmp, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(doc, null, 2)}\n`);
    await handle.sync();
    await handle.close(); handle = null;
    await io.rename(tmp, file);
    // Durably persist the rename itself: fsync the containing directory so the
    // new directory entry survives a crash, not just the file's bytes. Best-
    // effort — some platforms reject a directory fsync, and the rename is
    // already atomic to concurrent readers regardless.
    try { const dir = await io.open(path.dirname(file), 'r'); try { await dir.sync(); } finally { await dir.close(); } } catch { /* directory fsync unsupported */ }
  } finally {
    await handle?.close();
    await io.unlink(tmp).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }
}

async function withLock(file, action, { lockTimeoutMs = 5000, staleLockMs = 30000 } = {}) {
  const lock = `${file}.lock`;
  const started = Date.now();
  let handle;
  while (!handle) {
    try { handle = await fs.open(lock, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      // Serialize stale-lock recovery too: two reclaimers must never unlink a
      // successor's newly acquired lock. Re-read the PID only inside this guard.
      let recovery;
      try {
        recovery = await fs.open(`${lock}.reap`, 'wx', 0o600);
        const stat = await fs.stat(lock);
        const pid = Number(await fs.readFile(lock, 'utf8'));
        if (Date.now() - stat.mtimeMs > staleLockMs && Number.isSafeInteger(pid) && pid > 0) {
          try { process.kill(pid, 0); }
          catch (probe) { if (probe.code === 'ESRCH') await fs.unlink(lock); }
        }
      } catch { /* Unreadable or contended locks get a bounded wait. */ }
      finally {
        if (recovery) { await recovery.close(); await fs.unlink(`${lock}.reap`); }
      }
      if (Date.now() - started >= lockTimeoutMs) throw new Error('Owner-pin lock timeout');
      await delay(20);
    }
  }
  try { await handle.writeFile(String(process.pid)); return await action(); }
  finally { await handle.close(); await fs.unlink(lock); }
}

function expiry(value, now) {
  const relative = /^\+(\d+(?:\.\d+)?)(ms|s|m|h|d|w)$/.exec(value);
  const result = relative ? now + Number(relative[1]) * ({ ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000, w: 604800000 })[relative[2]]
    : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? Date.parse(value) : NaN;
  if (!Number.isSafeInteger(result) || result <= now) throw new Error('Invalid --expires: use a future ISO8601 time or +duration');
  return result;
}

function line(scope, pin) {
  // A migrated inactive legacy override may carry no target; show it plainly
  // rather than printing an "undefined" ref.
  const target = pin.model_ref ?? (typeof pin.family === 'string' && pin.family ? `${pin.family} (resolved at decision time)` : '(no target)');
  return `${scope} ${target} active=${pin.active} set_by=${JSON.stringify(pin.set_by)} set_at_ms=${pin.set_at_ms} expires=${pin.expires_at_ms ?? 'none'}${scope === 'all' && pin.expires_at_ms === undefined ? ' no_expiry=true' : ''}`;
}

export async function run(args, { clock = Date.now, paths = null, stdout = console.log, stderr = console.error, ...lockOptions } = {}) {
  try {
    if (args.length === 1 && ['--help', '-h'].includes(args[0])) { stdout(USAGE); return 0; }
    const [command, ...rest] = args;
    const allowed = { set: ['scope', 'model', 'family', 'provider', 'expires', 'reason', 'config'], clear: ['scope', 'config'], list: ['json', 'config'] }[command];
    if (!allowed) throw new Error(USAGE);
    const options = {};
    while (rest.length) {
      const flag = rest.shift(); const key = flag.slice(2);
      if (!flag.startsWith('--') || !allowed.includes(key) || Object.hasOwn(options, key)) throw new Error(USAGE);
      if (key === 'json') options[key] = true;
      else { if (!rest.length || rest[0].startsWith('--')) throw new Error(USAGE); options[key] = rest.shift(); }
    }
    if (!options.config) throw new Error('Missing --config');
    let raw;
    try { raw = pluginConfigFrom(JSON.parse(await fs.readFile(paths ? paths.resolve(options.config) : resolveOpenClawPath(options.config), 'utf8'))); }
    catch { throw new Error('Cannot read --config as JSON'); }
    const file = resolveOwnerPinsStatePath(normalizeConfig(raw).ownerOverride, { paths });
    if (!file) throw new Error('Owner-pin state path is not configured');
    const now = clock();
    let scope;
    let pin;
    if (command !== 'list') {
      scope = options.scope === 'all' ? 'all' : options.scope?.startsWith('task:') ? `task:${normalizeLabel(options.scope.slice(5))}` : '';
      if (!/^(all|task:[a-z0-9][a-z0-9._-]{0,127})$/.test(scope)) throw new Error('Invalid --scope');
      if (command === 'set') {
        if (Boolean(options.model) === Boolean(options.family)) throw new Error('Supply exactly one of --model or --family');
        if (scope === 'all' && !options.expires) throw new Error('All-tasks pin requires --expires');
        pin = { active: true, [options.model ? 'model_ref' : 'family']: options.model ?? options.family, set_by: 'togglelogic-pin', set_at_ms: now };
        if (options.provider !== undefined) pin.provider_override = options.provider;
        if (options.reason !== undefined) pin.reason = options.reason;
        if (options.expires !== undefined) pin.expires_at_ms = expiry(options.expires, now);
        await validate({ schema: 'togglelogic-owner-pins/v2', pins: { [scope]: pin } });
      }
    }
    let doc;
    if (command === 'list') doc = await readState(file, now);
    else {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await withLock(file, async () => {
        doc = await readState(file, now);
        if (command === 'set') doc.pins[scope] = pin;
        else delete doc.pins[scope];
        await validate(doc);
        await atomicWrite(file, doc);
      }, lockOptions);
    }
    if (command === 'list') {
      if (options.json) stdout(JSON.stringify(doc));
      else for (const [key, value] of Object.entries(doc.pins).sort(([a], [b]) => a.localeCompare(b))) stdout(line(key, value));
    } else stdout(command === 'set' ? line(scope, pin) : `Cleared ${scope}`);
    const licensed = raw?.intelligence && raw.intelligence.enabled !== false && (raw.intelligence.enabled === true || Boolean(raw.intelligence.path?.trim()));
    // `list --json` keeps stdout a single machine-readable JSON document; the
    // human-facing pointer still appears, on stderr, so it never pollutes the
    // data stream (and is still omitted when licensed / on errors).
    if (command !== 'clear' && !licensed) (options.json ? stderr : stdout)(POINTER);
    return 0;
  } catch (error) { stderr(`togglelogic-pin: ${error.message.replace(/[\r\n]+/g, ' ')}`); return 1; }
}

if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) process.exitCode = await run(process.argv.slice(2));
