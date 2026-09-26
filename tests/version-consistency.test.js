// Release guard (2.0.4): the runtime version reported in routing/audit records
// must equal the published package and manifest versions.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
test("runtime, package and manifest versions match", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "openclaw.plugin.json"), "utf8")).version;
  const runtime = fs.readFileSync(path.join(root, "src/index.js"), "utf8").match(/PLUGIN_VERSION = "([^"]+)"/)?.[1];
  assert.equal(manifest, pkg); assert.equal(runtime, pkg);
});
