/*
 * ToggleLogic (Free Tier) — small JSON state store with atomic writes.
 * (c) 2026 Motherboard, Inc. Source-available under the ToggleLogic Free-Tier
 * License (see LICENSE); all rights reserved.
 * PATENT PENDING.
 */
import fsSync from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const KEY = /^[a-z0-9][a-z0-9._-]{0,127}$/;

/**
 * StateStore for small JSON documents (owner-override state, the audit chain
 * head, budget state). Keys are flat names, never paths. write() replaces the
 * document atomically (temp file + rename in the same directory), so a reader
 * never sees a partial document. read() returns null for a missing document
 * and throws on a corrupt one, so corruption is never mistaken for "absent".
 */
export function createStateStore({ dir, fs = fsSync } = {}) {
  if (typeof dir !== "string" || !dir) throw new TypeError("createStateStore: dir is required");
  function file(key) {
    if (typeof key !== "string" || !KEY.test(key)) throw new TypeError(`StateStore: invalid key ${JSON.stringify(key)}`);
    return path.join(dir, `${key}.json`);
  }
  return Object.freeze({
    dir,
    read(key) {
      let text;
      try {
        text = fs.readFileSync(file(key), "utf8");
      } catch (err) {
        if (err && err.code === "ENOENT") return null;
        throw err;
      }
      return JSON.parse(text);
    },
    write(key, value) {
      if (value === null || typeof value !== "object") throw new TypeError("StateStore: value must be an object");
      const target = file(key);
      fs.mkdirSync(dir, { recursive: true });
      const temp = path.join(dir, `.${key}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`);
      try {
        fs.writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
        fs.renameSync(temp, target);
      } catch (err) {
        try { fs.rmSync(temp, { force: true }); } catch {}
        throw err;
      }
    },
  });
}
