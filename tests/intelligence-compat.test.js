import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { detectIntelligenceLayer, INTELLIGENCE_SEAM_ABI } from "../src/intelligence/detector.js";

async function fixture(overrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tl-intel-"));
  await fs.mkdir(path.join(root, "src"));
  const classifier = "export function classify() { return null; }\n";
  await fs.writeFile(path.join(root, "src", "classifier.js"), classifier);
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ version: "1.2.0-rc.1" }));
  await fs.writeFile(path.join(root, "normalized.json"), "{}");
  await fs.writeFile(path.join(root, "release-manifest.json"), JSON.stringify({
    product: "togglelogic-intelligence", version: "1.2.0-rc.1", release_state: "released",
    seam_abi: INTELLIGENCE_SEAM_ABI,
    entrypoint: "src/classifier.js",
    entrypoint_sha256: crypto.createHash("sha256").update(classifier).digest("hex"),
    plugin_compatibility: { minimum: "1.1.2", maximum_exclusive: "1.4.0" }, ...overrides,
  }));
  return root;
}

test("pairwise release contract accepts exact compatible pair", async () => {
  const root = await fixture();
  assert.equal((await detectIntelligenceLayer(root, "", "1.1.2")).present, true);
  assert.equal((await detectIntelligenceLayer(root, "", "1.2.0")).present, true);
  assert.equal((await detectIntelligenceLayer(root, "", "1.3.0")).present, true);
  assert.equal((await detectIntelligenceLayer(root, "", "1.3.0")).present, true);
});

test("pairwise release contract fails closed on ABI, version, and development state", async () => {
  for (const overrides of [{ seam_abi: 99 }, { release_state: "development" }, { plugin_compatibility: { minimum: "1.2.0", maximum_exclusive: "2.0.0" } }]) {
    const root = await fixture(overrides);
    assert.equal((await detectIntelligenceLayer(root, "", "1.1.2")).present, false);
  }
});

test("pairwise release contract fails closed when classifier bytes do not match manifest", async () => {
  const root = await fixture({ entrypoint_sha256: "0".repeat(64) });
  const result = await detectIntelligenceLayer(root, "", "1.3.0");
  assert.equal(result.present, false);
  assert.equal(result.reason, "classifier entrypoint hash mismatch");
});
