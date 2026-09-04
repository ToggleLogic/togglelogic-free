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

test("marks and consumes a genuinely new session exactly once", (t) => {
  const tracker = createNewSessionTracker({ stateDir: temporaryStateDir(t) });
  tracker.mark({ sessionId: "session-1", sessionKey: "agent:main:new" });

  assert.equal(tracker.consume({ sessionId: "session-1" }), true);
  assert.equal(tracker.consume({ sessionKey: "agent:main:new" }), false);
});

test("does not classify an unmarked resumed session as new", (t) => {
  const tracker = createNewSessionTracker({ stateDir: temporaryStateDir(t) });
  assert.equal(
    tracker.consume({ sessionId: "resumed-1", sessionKey: "agent:main:existing" }),
    false,
  );
});

test("accepts session-key-only hooks", (t) => {
  const tracker = createNewSessionTracker({ stateDir: temporaryStateDir(t) });
  tracker.mark({ sessionKey: "agent:main:key-only" });
  assert.equal(tracker.consume({ sessionKey: "agent:main:key-only" }), true);
  assert.equal(tracker.consume({ sessionKey: "agent:main:key-only" }), false);
});

test("hands a one-shot marker across plugin processes without storing raw identifiers", (t) => {
  const stateDir = temporaryStateDir(t);
  const gatewayTracker = createNewSessionTracker({ stateDir });
  const workerTracker = createNewSessionTracker({ stateDir });
  gatewayTracker.mark({ sessionId: "session-secret", sessionKey: "agent:main:secret" });

  const serialized = fs.readdirSync(stateDir)
    .map((name) => `${name}\n${fs.readFileSync(path.join(stateDir, name), "utf8")}`)
    .join("\n");
  assert.equal(serialized.includes("session-secret"), false);
  assert.equal(serialized.includes("agent:main:secret"), false);
  assert.equal(workerTracker.consume({ sessionKey: "agent:main:secret" }), true);
  assert.equal(gatewayTracker.consume({ sessionId: "session-secret" }), false);
});
