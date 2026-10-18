/*
 * ToggleLogic (Free Tier) — M1 step 2: injected paths, clock and StateStore; host-neutral core.
 * (c) 2026 Motherboard, Inc. Source-available under the ToggleLogic Free-Tier
 * License (see LICENSE); all rights reserved.
 * PATENT PENDING.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPaths } from "../src/core/paths.js";
import { createStateStore } from "../src/core/state-store.js";
import { systemClock } from "../src/core/clock.js";
import { openClawPaths } from "../src/adapters/openclaw/paths.js";
import { resolveOpenClawPath, resolvePath } from "../src/path-utils.js";
import { createAuditLogger } from "../src/audit/audit-logger.js";
import { createLogger } from "../src/observability/logger.js";

// Reference copy of the Free 2.1.6 resolver, kept verbatim to prove parity.
function legacyResolve(value, env) {
  if (typeof value !== "string") return value;
  const home = typeof env.HOME === "string" && env.HOME.trim() ? env.HOME.trim() : os.homedir();
  const rawState = typeof env.OPENCLAW_STATE_DIR === "string" ? env.OPENCLAW_STATE_DIR.trim() : "";
  const stateDir = rawState
    ? path.resolve(rawState === "~" ? home : rawState.startsWith("~/") ? path.join(home, rawState.slice(2)) : rawState)
    : path.join(home, ".openclaw");
  if (value === "~/.openclaw") return stateDir;
  if (value.startsWith("~/.openclaw/")) return path.join(stateDir, value.slice(12));
  if (value === "~") return home;
  if (value.startsWith("~/")) return path.join(home, value.slice(2));
  return value;
}

const tmp = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tl-core-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test("OpenClaw adapter paths resolve exactly as Free 2.1.6 for every env shape", () => {
  const envs = [
    {}, { HOME: "/h/al" }, { HOME: "  /h/al  " }, { HOME: "" },
    { HOME: "/h/al", OPENCLAW_STATE_DIR: "/srv/state" },
    { HOME: "/h/al", OPENCLAW_STATE_DIR: "~" },
    { HOME: "/h/al", OPENCLAW_STATE_DIR: "~/profiles/hq" },
    { HOME: "/h/al", OPENCLAW_STATE_DIR: "relative/state" },
    { HOME: "/h/al", OPENCLAW_STATE_DIR: "   " },
  ];
  const values = ["~/.openclaw", "~/.openclaw/logs/a.jsonl", "~", "~/togglelogic-intelligence", "/abs/x", "rel/x", "", undefined, 7, "~user/x"];
  for (const env of envs) for (const value of values) {
    assert.deepEqual(resolveOpenClawPath(value, env), legacyResolve(value, env), JSON.stringify({ env, value }));
    assert.deepEqual(openClawPaths(env).resolve(value), legacyResolve(value, env));
  }
});

test("createPaths requires explicit locations and never consults the environment", () => {
  assert.throws(() => createPaths({ stateDir: "/s" }), /home is required/);
  assert.throws(() => createPaths({ home: "/h" }), /stateDir is required/);
  const before = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = "/should/not/be/used";
  try {
    const paths = createPaths({ home: "/h", stateDir: "/s" });
    assert.equal(paths.resolve("~/.openclaw/logs/x"), path.join("/s", "logs/x"));
    assert.equal(paths.resolve("~/y"), path.join("/h", "y"));
    assert.equal(paths.resolve("/abs"), "/abs");
    assert.equal(resolvePath("~/.openclaw/z", paths), path.join("/s", "z"));
  } finally {
    if (before === undefined) delete process.env.OPENCLAW_STATE_DIR; else process.env.OPENCLAW_STATE_DIR = before;
  }
});

test("StateStore: atomic round trip, missing is null, corrupt is loud, keys are names not paths", (t) => {
  const dir = path.join(tmp(t), "state");
  const store = createStateStore({ dir });
  assert.equal(store.read("owner-override"), null);
  store.write("owner-override", { model: "example/model", n: 1 });
  store.write("owner-override", { model: "example/model", n: 2 });
  assert.deepEqual(store.read("owner-override"), { model: "example/model", n: 2 });
  assert.deepEqual(fs.readdirSync(dir), ["owner-override.json"], "no temp files left behind");
  if (process.platform !== "win32") assert.equal(fs.statSync(path.join(dir, "owner-override.json")).mode & 0o777, 0o600);
  fs.writeFileSync(path.join(dir, "broken.json"), "{not json");
  assert.throws(() => store.read("broken"), SyntaxError);
  for (const key of ["../escape", "a/b", "", "A", ".hidden", "x".repeat(129)]) {
    assert.throws(() => store.read(key), /invalid key/, key);
    assert.throws(() => store.write(key, {}), /invalid key/, key);
  }
  assert.throws(() => store.write("ok", null), /must be an object/);
});

test("injected paths redirect audit and routing logs regardless of OPENCLAW_STATE_DIR", async (t) => {
  const stateDir = tmp(t);
  const decoy = tmp(t);
  const before = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = decoy;
  try {
    const paths = createPaths({ home: stateDir, stateDir });
    const audit = createAuditLogger({ enabled: true }, null, { pluginId: "t", pluginVersion: "0" }, { paths });
    audit.emit({ event: "config.load", outcome: "success", principal: { source: "test" } });
    await audit.flush();
    const routing = createLogger({ enabled: true }, null, { paths });
    assert.equal(routing.path, path.join(stateDir, "logs", "togglelogic-routing.log"));
    routing.write({ requestId: "r1" });
    await routing.flush();
    const written = await fsp.readdir(path.join(stateDir, "logs"));
    assert.ok(written.includes("togglelogic-audit.jsonl"), `audit under injected stateDir: ${written}`);
    assert.ok(written.includes("togglelogic-routing.log"), `routing log under injected stateDir: ${written}`);
    assert.deepEqual(await fsp.readdir(decoy), [], "nothing written to the environment's state dir");
  } finally {
    if (before === undefined) delete process.env.OPENCLAW_STATE_DIR; else process.env.OPENCLAW_STATE_DIR = before;
  }
});

test("system clock is epoch milliseconds", () => {
  const a = Date.now(); const b = systemClock(); const c = Date.now();
  assert.ok(b >= a && b <= c);
});

test("src/core is host-neutral: no environment, OS home or host SDK access", () => {
  const coreDir = fileURLToPath(new URL("../src/core/", import.meta.url));
  for (const name of fs.readdirSync(coreDir).filter((file) => file.endsWith(".js"))) {
    const source = fs.readFileSync(path.join(coreDir, name), "utf8");
    assert.doesNotMatch(source, /process\.env/, `${name} reads process.env`);
    assert.doesNotMatch(source, /from ["']node:os["']|homedir\(/, `${name} reads the OS home`);
    assert.doesNotMatch(source, /openclaw\/plugin-sdk|from ["']openclaw/, `${name} imports the host SDK`);
    assert.doesNotMatch(source, /from ["']\.\.\/adapters\//, `${name} imports an adapter`);
  }
});
