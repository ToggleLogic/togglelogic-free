/*
 * ToggleLogic (Free Tier) — bounded new-session signal tracker.
 * (c) 2026 Motherboard, Inc. Source-available under the ToggleLogic Free-Tier
 * License (see LICENSE); all rights reserved. PATENT PENDING.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_MAX_PENDING = 512;
const DEFAULT_TTL_MS = 5 * 60 * 1000;

function normalize(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function identifiers(value) {
  const ids = [];
  const sessionId = normalize(value?.sessionId);
  const sessionKey = normalize(value?.sessionKey);
  if (sessionId) ids.push(`id:${sessionId}`);
  if (sessionKey) ids.push(`key:${sessionKey}`);
  return ids;
}

function digest(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function defaultStateDir() {
  const stateRoot = normalize(process.env.OPENCLAW_STATE_DIR)
    ?? path.join(os.homedir(), ".openclaw");
  return path.join(stateRoot, "togglelogic", "new-sessions");
}

export function createNewSessionTracker({
  maxPending = DEFAULT_MAX_PENDING,
  ttlMs = DEFAULT_TTL_MS,
  stateDir = defaultStateDir(),
} = {}) {
  const pending = new Map();
  const boundedMax = Number.isFinite(maxPending) && maxPending > 0
    ? Math.floor(maxPending)
    : DEFAULT_MAX_PENDING;
  const boundedTtl = Number.isFinite(ttlMs) && ttlMs > 0
    ? Math.floor(ttlMs)
    : DEFAULT_TTL_MS;

  function markerPath(hash) {
    return path.join(stateDir, `${hash}.json`);
  }

  function pruneDisk(now = Date.now()) {
    try {
      const entries = fs.readdirSync(stateDir, { withFileTypes: true });
      const files = entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map((entry) => {
          const file = path.join(stateDir, entry.name);
          return { file, mtimeMs: fs.statSync(file).mtimeMs };
        })
        .sort((a, b) => a.mtimeMs - b.mtimeMs);
      for (const entry of files) {
        if (now - entry.mtimeMs > boundedTtl) fs.unlinkSync(entry.file);
      }
      const remaining = files.filter((entry) => now - entry.mtimeMs <= boundedTtl);
      for (const entry of remaining.slice(0, Math.max(0, remaining.length - boundedMax))) {
        try { fs.unlinkSync(entry.file); } catch { /* already consumed */ }
      }
    } catch { /* absent or concurrently changing state is harmless */ }
  }

  function persist(ids, now) {
    if (!ids.length) return false;
    const hashes = [...new Set(ids.map(digest))];
    const payload = JSON.stringify({ ids: hashes, createdAt: now });
    try {
      fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
      for (const hash of hashes) {
        const target = markerPath(hash);
        const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
        fs.writeFileSync(temporary, payload, { encoding: "utf8", mode: 0o600 });
        fs.renameSync(temporary, target);
      }
      pruneDisk(now);
      return true;
    } catch {
      return false;
    }
  }

  function consumeDisk(ids) {
    for (const id of ids) {
      const target = markerPath(digest(id));
      try {
        const payload = JSON.parse(fs.readFileSync(target, "utf8"));
        if (!Number.isFinite(payload?.createdAt) || Date.now() - payload.createdAt > boundedTtl) {
          try { fs.unlinkSync(target); } catch { /* already removed */ }
          continue;
        }
        for (const hash of Array.isArray(payload.ids) ? payload.ids : []) {
          try { fs.unlinkSync(markerPath(hash)); } catch { /* alias already removed */ }
        }
        return true;
      } catch { /* no marker for this identifier */ }
    }
    return false;
  }

  function prune() {
    while (pending.size > boundedMax) {
      pending.delete(pending.keys().next().value);
    }
  }

  function mark(value) {
    const now = Date.now();
    const token = Symbol("new-session");
    const ids = identifiers(value);
    const durable = persist(ids, now);
    for (const id of ids) pending.set(id, { at: now, token, durable });
    prune();
  }

  function consume(value) {
    const ids = identifiers(value);
    const matched = ids.map((id) => pending.get(id)).find(Boolean);
    if (matched) {
      for (const [id, entry] of pending) {
        if (entry.token === matched.token) pending.delete(id);
      }
    }
    const diskMatched = consumeDisk(ids);
    return Boolean(diskMatched || (matched && !matched.durable));
  }

  return { mark, consume };
}
