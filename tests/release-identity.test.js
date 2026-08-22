import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("public package and OpenClaw manifest share one release identity", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "openclaw.plugin.json"), "utf8"));
  const source = fs.readFileSync(path.join(root, "src", "index.js"), "utf8");
  const match = /const PLUGIN_VERSION = "([^"]+)"/.exec(source);
  assert.ok(match, "src/index.js declares PLUGIN_VERSION");
  assert.equal(pkg.version, manifest.version);
  assert.equal(pkg.version, match[1]);
});
