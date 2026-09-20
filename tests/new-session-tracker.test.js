import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createNewSessionTracker } from "../src/routing/new-session-tracker.js";

function temporaryStateDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "togglelogic-new-session-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("marks and consumes a genuinely new session exactly once", async (t) => {
  const tracker = createNewSessionTracker({ stateDir: temporaryStateDir(t) });
  tracker.mark({ sessionId: "session-1", sessionKey: "agent:main:new" });

  assert.equal(await tracker.consume({ sessionId: "session-1" }), true);
  assert.equal(await tracker.consume({ sessionKey: "agent:main:new" }), false);
});

test("does not classify an unmarked resumed session as new", async (t) => {
  const tracker = createNewSessionTracker({ stateDir: temporaryStateDir(t), settleMs: 0 });
  assert.equal(
    await tracker.consume({ sessionId: "resumed-1", sessionKey: "agent:main:existing" }),
    false,
  );
});

test("accepts session-key-only hooks", async (t) => {
  const tracker = createNewSessionTracker({ stateDir: temporaryStateDir(t) });
  tracker.mark({ sessionKey: "agent:main:key-only" });
  assert.equal(await tracker.consume({ sessionKey: "agent:main:key-only" }), true);
  assert.equal(await tracker.consume({ sessionKey: "agent:main:key-only" }), false);
});

test("hands a one-shot marker across plugin processes without storing raw identifiers", async (t) => {
  const stateDir = temporaryStateDir(t);
  const gatewayTracker = createNewSessionTracker({ stateDir });
  const workerTracker = createNewSessionTracker({ stateDir });
  gatewayTracker.mark({ sessionId: "session-secret", sessionKey: "agent:main:secret" });

  const serialized = fs.readdirSync(stateDir)
    .map((name) => `${name}\n${fs.readFileSync(path.join(stateDir, name), "utf8")}`)
    .join("\n");
  assert.equal(serialized.includes("session-secret"), false);
  assert.equal(serialized.includes("agent:main:secret"), false);
  assert.equal(await workerTracker.consume({ sessionKey: "agent:main:secret" }), true);
  assert.equal(await gatewayTracker.consume({ sessionId: "session-secret" }), false);
});

test("settles a session_start marker that arrives just after model resolution begins", async (t) => {
  const tracker = createNewSessionTracker({
    stateDir: temporaryStateDir(t),
    settleMs: 100,
    pollMs: 5,
  });
  setTimeout(() => tracker.mark({ sessionKey: "agent:main:racing-new" }), 20);

  assert.equal(await tracker.consume({ sessionKey: "agent:main:racing-new" }), true);
  assert.equal(await tracker.consume({ sessionKey: "agent:main:racing-new" }), false);
});

test("discards a marker that arrives after a session was already observed", async (t) => {
  const tracker = createNewSessionTracker({
    stateDir: temporaryStateDir(t),
    settleMs: 0,
  });
  assert.equal(await tracker.consume({ sessionKey: "agent:main:observed" }), false);
  tracker.mark({ sessionKey: "agent:main:observed" });
  assert.equal(await tracker.consume({ sessionKey: "agent:main:observed" }), false);
});
