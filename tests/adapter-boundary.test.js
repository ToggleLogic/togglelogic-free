/*
 * ToggleLogic (Free Tier) — M1 step 4: OpenClaw coupling lives only in src/adapters/openclaw/.
 * (c) 2026 Motherboard, Inc. Source-available under the ToggleLogic Free-Tier
 * License (see LICENSE); all rights reserved.
 * PATENT PENDING.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const src = fileURLToPath(new URL("../src/", import.meta.url));
const adapter = path.join(src, "adapters", "openclaw") + path.sep;
const files = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? files(path.join(dir, e.name)) : e.name.endsWith(".js") ? [path.join(dir, e.name)] : []);
const code = (file) => fs.readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

// Design M1 §2: C1 plugin entry, C2 hook registration, C5 session-store accessor,
// C13 notification interpreter. (C3/C4 host config and hook context are read by
// adapter-built services; C11 seam ABI 2 is Free 2.3.0; C12 is deprecated in step 8.)
const HOST_ONLY = [
  [/openclaw\/plugin-sdk|from ["']openclaw/, "imports the OpenClaw SDK (C1)"],
  [/\bdefinePluginEntry\b/, "defines the plugin entry (C1)"],
  [/\bapi\.on\(/, "registers OpenClaw hooks (C2)"],
  [/\bgetSessionEntry\b/, "reads the OpenClaw session store (C5)"],
  [/\/usr\/bin\/python3/, "hardcodes the notification interpreter (C13)"],
];

test("OpenClaw-only code appears only under src/adapters/openclaw/", () => {
  for (const file of files(src)) {
    if (file.startsWith(adapter)) continue;
    const body = code(file);
    for (const [re, what] of HOST_ONLY) assert.doesNotMatch(body, re, `${path.relative(src, file)} ${what}`);
  }
});

test("moved modules leave only a re-export at their old path", () => {
  const shims = { "routing/interceptor.js": "interceptor.js", "routing/session-store.js": "session-store.js",
    "hooks/conversation-access.js": "conversation-access.js", "capture/owner-override-ask.js": "owner-override-ask.js",
    "capabilities.js": "register.js" };
  for (const [old, now] of Object.entries(shims)) {
    const body = code(path.join(src, old)).trim();
    assert.match(body, new RegExp(`^export \\* from "[./]+adapters/openclaw/${now.replace(".", "\\.")}";$`), `${old} is a pure re-export`);
  }
});

test("the package entry only wires the OpenClaw adapter and carries the version label", () => {
  const body = code(path.join(src, "index.js"));
  assert.match(body, /from "\.\/adapters\/openclaw\/entry\.js"/);
  assert.match(body, /const PLUGIN_VERSION = "[^"]+";/);
  assert.doesNotMatch(body, /\bapi\b/);
});
