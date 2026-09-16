/*
 * ToggleLogic (Free Tier) — deployment-owned skill-inventory SNAPSHOT consumer.
 * (c) 2026 Motherboard, Inc. Source-available under the ToggleLogic Free-Tier
 * License (see LICENSE). PATENT PENDING.
 *
 * WHY THIS EXISTS (2026-09-15 correction, second pass):
 *   The first correction read the OpenClaw workspace `skill_manifest.json`
 *   directly and treated it as "live/authoritative". Independent evidence proved
 *   that file is NOT authoritative: on this host it is stale (dated 2026-05-17)
 *   with only a handful of entries, while `openclaw skills list --json` reports
 *   94 known / 57 eligible skills. A plugin that reads that stale file would
 *   silently route against a fictional catalog — the exact class of error the
 *   whole effort is meant to prevent. So the plugin no longer reads any workspace
 *   file directly, and it NEVER shells out to `openclaw` on a user turn.
 *
 * THE MODEL:
 *   1. A DEPLOYMENT-OWNED generator (scripts/generate-skill-inventory.mjs) runs
 *      `openclaw skills list --json` at deploy time, filters to the ELIGIBLE set,
 *      and writes a versioned + fingerprinted SNAPSHOT to a deployment-owned path.
 *   2. This module CONSUMES that snapshot at plugin startup and verifies, before
 *      trusting a single id:
 *        - source   : snapshot.source === the expected generator source tag
 *        - version  : snapshot.plugin_pair.free/intelligence === the running pair
 *        - freshness: now - generated_at_ms <= maxAgeMs (else STALE)
 *        - integrity: recompute the inventory fingerprint over snapshot.skills and
 *                     require it to equal the embedded fingerprint (tamper/drift)
 *      A missing, malformed, stale, wrong-source, wrong-version, or drifted
 *      snapshot FAILS CLOSED (ok:false, empty catalog) so nothing resolves and the
 *      gate returns the no-skill fail-safe rather than trusting fiction.
 *
 * `buildSnapshotFromSkillsList` is the single pure builder shared by the generator
 * and the tests, so the snapshot shape has exactly one definition. NEVER throws
 * from the consumer path.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { resolveOpenClawPath } from "../path-utils.js";

// schema_version 3 (1.6.1-rc.2): the snapshot now PRESERVES a sanitized, bounded
// per-skill description AND binds it into the inventory fingerprint, so the
// bounded local classifier can be given real skill descriptions (not opaque ids)
// while any tamper of a stored description fails the deployment closed. A v2
// snapshot is rejected loudly (regenerate with scripts/generate-skill-inventory.mjs).
export const SNAPSHOT_SCHEMA_VERSION = 3;
export const SNAPSHOT_KIND = "togglelogic-skill-inventory-snapshot";
export const SNAPSHOT_SOURCE = "openclaw skills list --json";
export const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h default freshness window

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,127}$/;
const MAX_SKILLS = 1024;
const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;
// Hard bound on the sanitized description stored per skill. Bounds the classifier
// prompt (no token bloat) and gives a size ceiling the consumer enforces: a stored
// description longer than this is treated as tamper and fails the snapshot closed.
export const MAX_DESCRIPTION_CHARS = 400;

function cleanString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Sanitize a host-reported skill description into a bounded, single-line,
 * control-character-free string that is safe to (a) store in the snapshot,
 * (b) bind into the inventory fingerprint, and (c) feed to the bounded local
 * classifier. Idempotent, so recomputing over an already-sanitized stored value
 * yields the same bytes (fingerprint stability). Never throws.
 */
export function sanitizeDescription(value) {
  if (typeof value !== "string") return "";
  let out = "";
  for (const ch of value) {
    const code = ch.codePointAt(0);
    // Drop C0/DEL control characters (newlines, NUL, etc.) to a single space so a
    // multi-line or control-laden description cannot smuggle structure into the
    // classifier prompt; whitespace runs collapse below.
    out += (code < 0x20 || code === 0x7f) ? " " : ch;
  }
  return out.replace(/\s+/g, " ").trim().slice(0, MAX_DESCRIPTION_CHARS);
}

// Normalize a term to a comparison token stream: lowercase, non-alphanumerics
// collapse to single spaces. Mirrors resolver.normalizeTerms so ids/aliases are
// matched identically by both the inventory producer and the resolver consumer.
function normalizeTerms(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

/**
 * Stable per-skill fingerprint over the identity + eligibility-relevant fields of
 * a single `openclaw skills list --json` entry. Any change to what the host
 * reports about the skill (description, eligibility, source, missing deps) changes
 * the fingerprint, so drift is detectable.
 */
export function skillFingerprint(entry) {
  const canonical = {
    name: cleanString(entry?.name),
    description: cleanString(entry?.description) || "",
    eligible: entry?.eligible === true,
    disabled: entry?.disabled === true,
    source: cleanString(entry?.source) || "",
    bundled: entry?.bundled === true,
    userInvocable: entry?.userInvocable === true,
    modelVisible: entry?.modelVisible === true,
    missing: entry?.missing && typeof entry.missing === "object" ? entry.missing : {},
  };
  return sha256(JSON.stringify(canonical));
}

/**
 * Deterministic inventory fingerprint over the snapshot's skills. Order- and
 * formatting-independent: sorted "id@fingerprint@sha256(description)" lines. The
 * sanitized, bounded description is bound in so a hand-edit of a stored
 * description (e.g. to inject text into the classifier prompt) changes the
 * recomputed fingerprint and fails the snapshot closed — descriptions PARTICIPATE
 * in tamper/drift validation, they are not merely carried alongside it.
 */
export function computeInventoryFingerprint(skills) {
  return sha256(
    (Array.isArray(skills) ? skills : [])
      .map((s) => `${s.id}@${s.fingerprint}@${sha256(sanitizeDescription(s.description))}`)
      .sort()
      .join("\n"),
  );
}

/**
 * buildSnapshotFromSkillsList — PURE. Turn a parsed `openclaw skills list --json`
 * object into the deployment snapshot. Filters to the ELIGIBLE set only (an
 * ineligible/disabled skill must never be routable). Used by the generator and by
 * tests; does no I/O and stamps time only from the supplied `generatedAtMs`.
 *
 *   listJson = { workspaceDir, managedSkillsDir, skills:[ { name, description,
 *               eligible, disabled, source, bundled, missing, ... }, ... ] }
 */
export function buildSnapshotFromSkillsList(listJson, options = {}) {
  const generatedAtMs = Number.isFinite(options.generatedAtMs) ? options.generatedAtMs : 0;
  const pluginFree = cleanString(options.pluginFree);
  const pluginIntelligence = cleanString(options.pluginIntelligence);
  const rawSkills = Array.isArray(listJson?.skills) ? listJson.skills : [];

  const skills = [];
  const seen = new Set();
  let known = 0;
  for (const raw of rawSkills) {
    known += 1;
    const id = cleanString(raw?.name);
    if (!id || !ID_RE.test(id) || seen.has(id)) continue;
    if (raw?.eligible !== true) continue; // ELIGIBLE set only — the routable universe
    seen.add(id);
    const fingerprint = skillFingerprint(raw);
    skills.push({
      id,
      name: cleanString(raw?.name) || id,
      version: cleanString(raw?.version) || `fp-${fingerprint.slice(0, 12)}`,
      fingerprint,
      source: cleanString(raw?.source) || "unknown",
      execution_class: cleanString(raw?.execution_class) || "default",
      // Sanitized + bounded; bound into the inventory fingerprint above so the
      // classifier receives a real (but tamper-checked) description, not an opaque id.
      description: sanitizeDescription(raw?.description),
    });
    if (skills.length >= MAX_SKILLS) break;
  }
  skills.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  return {
    schema_version: SNAPSHOT_SCHEMA_VERSION,
    kind: SNAPSHOT_KIND,
    source: SNAPSHOT_SOURCE,
    generator: "scripts/generate-skill-inventory.mjs",
    generated_at: generatedAtMs ? new Date(generatedAtMs).toISOString() : null,
    generated_at_ms: generatedAtMs,
    plugin_pair: {
      ...(pluginFree ? { free: pluginFree } : {}),
      ...(pluginIntelligence ? { intelligence: pluginIntelligence } : {}),
    },
    host: {
      workspaceDir: cleanString(listJson?.workspaceDir) || null,
      managedSkillsDir: cleanString(listJson?.managedSkillsDir) || null,
    },
    counts: { known, eligible: skills.length },
    skills,
    inventory_fingerprint: computeInventoryFingerprint(skills),
  };
}

/**
 * loadSkillInventory — CONSUME + VERIFY a deployment-owned snapshot.
 *
 * Options:
 *   snapshotPath          path to the deployment snapshot (read if `snapshot` absent)
 *   snapshot              pre-parsed snapshot object (tests / host-provided)
 *   expectedSource        required snapshot.source (default SNAPSHOT_SOURCE)
 *   expectedPluginFree    required snapshot.plugin_pair.free (running Free version)
 *   expectedPluginIntelligence  required snapshot.plugin_pair.intelligence when set
 *   maxAgeMs              freshness window (default DEFAULT_MAX_AGE_MS)
 *   nowMs                 clock (default Date.now())
 *   aliases               { id:[alias,...] } deployment aliases MERGED onto a live id
 *   deps                  { readFile, statSync } injectable fs for tests
 *
 * Returns { ok, source, catalog, skills, inventoryFingerprint, counts,
 *           generatedAtMs, ageMs, stale, drifted, verified, errors }.
 * FAILS CLOSED (ok:false, empty catalog) on ANY of: missing/unreadable/oversized
 * snapshot, wrong schema/kind, wrong source, wrong version pair, stale (too old),
 * or fingerprint drift (recompute != embedded). NEVER throws.
 */
export function loadSkillInventory(options = {}) {
  const deps = options.deps || {};
  const aliases = options.aliases && typeof options.aliases === "object" ? options.aliases : {};
  const expectedSource = cleanString(options.expectedSource) || SNAPSHOT_SOURCE;
  const expectedFree = cleanString(options.expectedPluginFree);
  const expectedIntelligence = cleanString(options.expectedPluginIntelligence);
  const maxAgeMs = Number.isFinite(options.maxAgeMs) && options.maxAgeMs > 0 ? options.maxAgeMs : DEFAULT_MAX_AGE_MS;
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();

  const fail = (errors, extra = {}) => ({
    ok: false, source: extra.source || "none", catalog: [], skills: [],
    inventoryFingerprint: null, counts: { known: 0, eligible: 0 },
    generatedAtMs: extra.generatedAtMs ?? null, ageMs: extra.ageMs ?? null,
    stale: extra.stale === true, drifted: extra.drifted === true, verified: false,
    errors,
  });

  let snapshot = options.snapshot;
  let sourcePath = snapshot ? "provided-snapshot" : null;
  if (!snapshot) {
    const snapshotPath = cleanString(options.snapshotPath);
    if (!snapshotPath) return fail(["no snapshot path or snapshot object supplied"]);
    try {
      const readFileImpl = deps.readFile || fs.readFileSync;
      const statImpl = deps.statSync || fs.statSync;
      const stat = statImpl(snapshotPath);
      if (stat.size > MAX_SNAPSHOT_BYTES) throw new Error(`snapshot exceeds ${MAX_SNAPSHOT_BYTES} bytes`);
      snapshot = JSON.parse(String(readFileImpl(snapshotPath, "utf8")));
      sourcePath = snapshotPath;
    } catch (error) {
      // ENOENT included: a deployment that never ran the generator gets fail-closed.
      return fail([`could not read skill-inventory snapshot: ${error.message}`], { source: snapshotPath });
    }
  }

  if (!snapshot || typeof snapshot !== "object") return fail(["snapshot is not an object"], { source: sourcePath });
  const errors = [];
  if (snapshot.schema_version !== SNAPSHOT_SCHEMA_VERSION) errors.push(`unsupported snapshot schema_version ${snapshot.schema_version} (need ${SNAPSHOT_SCHEMA_VERSION})`);
  if (snapshot.kind !== SNAPSHOT_KIND) errors.push(`unexpected snapshot kind ${JSON.stringify(snapshot.kind)}`);
  if (cleanString(snapshot.source) !== expectedSource) errors.push(`snapshot source ${JSON.stringify(snapshot.source)} != expected ${JSON.stringify(expectedSource)} (not from the authoritative generator)`);

  const pair = snapshot.plugin_pair && typeof snapshot.plugin_pair === "object" ? snapshot.plugin_pair : {};
  if (expectedFree && cleanString(pair.free) !== expectedFree) errors.push(`snapshot Free version ${JSON.stringify(pair.free)} != running ${JSON.stringify(expectedFree)}`);
  if (expectedIntelligence && cleanString(pair.intelligence) !== expectedIntelligence) errors.push(`snapshot Intelligence version ${JSON.stringify(pair.intelligence)} != expected ${JSON.stringify(expectedIntelligence)}`);

  const generatedAtMs = Number.isFinite(snapshot.generated_at_ms) ? snapshot.generated_at_ms : null;
  const ageMs = generatedAtMs != null ? nowMs - generatedAtMs : null;
  let stale = false;
  if (generatedAtMs == null) errors.push("snapshot is missing generated_at_ms (cannot verify freshness)");
  else if (ageMs < 0) errors.push(`snapshot generated_at_ms is in the future by ${-ageMs}ms (clock/tamper)`);
  else if (ageMs > maxAgeMs) { stale = true; errors.push(`snapshot is stale: age ${Math.round(ageMs / 3_600_000)}h exceeds max ${Math.round(maxAgeMs / 3_600_000)}h`); }

  const rawSkills = Array.isArray(snapshot.skills) ? snapshot.skills : null;
  if (!rawSkills) errors.push("snapshot has no skills array");

  // Integrity: recompute the fingerprint over the embedded skills and require a
  // match. A drifted/tampered snapshot (or one whose skills were edited by hand)
  // fails closed.
  let drifted = false;
  const normalizedSkills = [];
  if (rawSkills) {
    for (const s of rawSkills) {
      const id = cleanString(s?.id);
      const fingerprint = cleanString(s?.fingerprint);
      if (!id || !ID_RE.test(id) || !fingerprint) continue;
      // SIZE BOUND (fail closed): a stored description longer than the bound the
      // generator enforces can only be tamper — reject the snapshot loudly rather
      // than truncate-and-trust. (The fingerprint check below also catches it, but
      // this gives a precise, auditable reason.)
      const rawDescription = typeof s?.description === "string" ? s.description : "";
      if (rawDescription.length > MAX_DESCRIPTION_CHARS) {
        errors.push(`snapshot skill ${JSON.stringify(id)} description exceeds the ${MAX_DESCRIPTION_CHARS}-char bound (${rawDescription.length}) — failing closed`);
      }
      normalizedSkills.push({
        id,
        name: cleanString(s?.name) || id,
        version: cleanString(s?.version) || `fp-${fingerprint.slice(0, 12)}`,
        fingerprint,
        execution_class: cleanString(s?.execution_class) || "default",
        source: cleanString(s?.source) || "unknown",
        description: sanitizeDescription(rawDescription),
      });
    }
    const recomputed = computeInventoryFingerprint(normalizedSkills);
    if (recomputed !== cleanString(snapshot.inventory_fingerprint)) {
      drifted = true;
      errors.push("snapshot inventory_fingerprint does not match its skills (drift/tamper) — failing closed");
    }
    if (normalizedSkills.length === 0) errors.push("snapshot lists no eligible skills");
  }

  if (errors.length > 0) {
    return fail(errors, { source: sourcePath, generatedAtMs, ageMs, stale, drifted });
  }

  const catalog = normalizedSkills.map((s) => {
    const declaredAliases = Array.isArray(aliases[s.id]) ? aliases[s.id].map(cleanString).filter(Boolean) : [];
    const terms = [...new Set(
      [s.id, s.name, ...declaredAliases]
        .filter(Boolean)
        .map(normalizeTerms)
        .filter((term) => term.length >= 2),
    )];
    return { id: s.id, terms, version: s.version, fingerprint: s.fingerprint, execution_class: s.execution_class, description: s.description || "" };
  });

  return {
    ok: true,
    source: cleanString(snapshot.source),
    catalog,
    skills: normalizedSkills,
    inventoryFingerprint: cleanString(snapshot.inventory_fingerprint),
    counts: snapshot.counts && typeof snapshot.counts === "object"
      ? { known: Number(snapshot.counts.known) || normalizedSkills.length, eligible: Number(snapshot.counts.eligible) || normalizedSkills.length }
      : { known: normalizedSkills.length, eligible: normalizedSkills.length },
    generatedAtMs,
    ageMs,
    stale: false,
    drifted: false,
    verified: true,
    errors: [],
  };
}

/**
 * detectInventoryDrift — compare the accepted snapshot's inventory fingerprint
 * against the plugin's own "last accepted" marker (NOT the deployment snapshot,
 * which the plugin never writes). Reports added/removed/changed and, by default,
 * updates the plugin marker atomically. Never throws.
 */
export function detectInventoryDrift(inventory, options = {}) {
  const deps = options.deps || {};
  const markerPath = cleanString(options.markerPath || options.snapshotPath);
  const persist = options.persist !== false;
  const current = new Map((inventory?.skills || []).map((s) => [s.id, s.fingerprint]));
  const currentFingerprint = inventory?.inventoryFingerprint || null;

  let previous = null;
  if (markerPath) {
    try {
      const readFileImpl = deps.readFile || fs.readFileSync;
      const parsed = JSON.parse(String(readFileImpl(markerPath, "utf8")));
      if (parsed && parsed.schema_version === 1 && parsed.skills && typeof parsed.skills === "object") previous = parsed;
    } catch (error) {
      if (error?.code !== "ENOENT") { /* corrupt marker → treat as first run */ }
    }
  }

  const added = [];
  const removed = [];
  const changed = [];
  if (previous) {
    const prevSkills = new Map(Object.entries(previous.skills));
    for (const [id, fp] of current) {
      if (!prevSkills.has(id)) added.push(id);
      else if (prevSkills.get(id) !== fp) changed.push({ id, from: prevSkills.get(id), to: fp });
    }
    for (const id of prevSkills.keys()) if (!current.has(id)) removed.push(id);
  }

  const firstRun = !previous;
  const drifted = !firstRun && (added.length > 0 || removed.length > 0 || changed.length > 0);

  let markerWritten = false;
  if (persist && markerPath && currentFingerprint && inventory?.ok) {
    try {
      const writeFileImpl = deps.writeFile || fs.writeFileSync;
      const mkdirImpl = deps.mkdir || fs.mkdirSync;
      const renameImpl = deps.rename || fs.renameSync;
      mkdirImpl(path.dirname(markerPath), { recursive: true, mode: 0o700 });
      const marker = { schema_version: 1, inventory_fingerprint: currentFingerprint, skills: Object.fromEntries(current) };
      const temp = `${markerPath}.tmp-${process.pid}`;
      writeFileImpl(temp, JSON.stringify(marker, null, 2) + "\n", { mode: 0o600 });
      renameImpl(temp, markerPath);
      markerWritten = true;
    } catch {
      /* marker persistence is best-effort; drift is still reported */
    }
  }

  return {
    firstRun,
    drifted,
    added,
    removed,
    changed,
    previousFingerprint: previous?.inventory_fingerprint || null,
    currentFingerprint,
    snapshotWritten: markerWritten, // retained key name for callers/audit
    markerWritten,
  };
}

/**
 * Default deployment-owned inventory locations. The plugin reads ONLY the
 * snapshot the deployment generator produced; it does not read the workspace
 * skill_manifest.json (proven stale) and never shells out to `openclaw`.
 */
export function defaultInventoryPaths(config = {}) {
  const sr = config.skillRouting || {};
  return {
    snapshotPath: resolveOpenClawPath(cleanString(sr.inventorySnapshotPath) || "~/.openclaw/togglelogic/skill-inventory.snapshot.json"),
    markerPath: resolveOpenClawPath(cleanString(sr.inventoryMarkerPath) || "~/.openclaw/togglelogic/skill-inventory-accepted.json"),
  };
}

/**
 * aliasesFromCatalogConfig — { id:[alias,...] } from the deployment's config
 * skillCatalog so declared aliases SUPPLEMENT a live id's match terms. A config
 * entry whose id is NOT in the snapshot contributes nothing.
 */
export function aliasesFromCatalogConfig(skillCatalog) {
  const out = {};
  for (const item of Array.isArray(skillCatalog) ? skillCatalog : []) {
    const entry = typeof item === "string" ? { id: item } : (item && typeof item === "object" ? item : null);
    const id = cleanString(entry?.id);
    if (!id) continue;
    const aliases = Array.isArray(entry.aliases) ? entry.aliases.map(cleanString).filter(Boolean) : [];
    out[id] = aliases;
  }
  return out;
}

/**
 * Which configured catalog ids are NOT present in the verified snapshot — i.e.
 * manual catalog fiction / stale references the deployment should remove.
 */
export function configuredButNotInstalled(skillCatalog, inventory) {
  const live = new Set((inventory?.catalog || []).map((c) => c.id));
  const out = [];
  for (const item of Array.isArray(skillCatalog) ? skillCatalog : []) {
    const id = cleanString(typeof item === "string" ? item : item?.id);
    if (id && !live.has(id) && !out.includes(id)) out.push(id);
  }
  return out;
}
