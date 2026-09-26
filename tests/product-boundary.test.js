import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { normalizeConfig } from "../src/config/normalize.js";
import { pickConfiguredRoute } from "../src/routing/modes.js";
import { createEnvelopeValidator, validateExecutionEnvelope } from "../src/enforcement/bounded-executor.js";
import { deliverAuthorizedArtifacts, MANIFEST_BEGIN, MANIFEST_END } from "../src/enforcement/artifact-manifest.js";
import crypto from "node:crypto";
import os from "node:os";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("public manifest exposes no application workflow surface", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "openclaw.plugin.json"), "utf8"));
  assert.equal(manifest.version, "2.0.4");
  assert.equal(manifest.contracts, undefined);
  assert.equal(manifest.configSchema.properties.skillRouting, undefined);
});

test("legacy application configuration is ignored rather than normalized", () => {
  const config = normalizeConfig({ features: { skillRouting: { enabled: true } }, skillRouting: { calendar: { enabled: true } } });
  assert.equal(config.features.skillRouting, undefined);
  assert.equal(config.skillRouting, undefined);
});

test("configured routing never inspects raw prompt text", () => {
  const routes = { finance: "provider/finance", default: "provider/default" };
  assert.deepEqual(pickConfiguredRoute(routes, { prompt: "finance" }, {}), { key: "default", modelId: "provider/default" });
  assert.deepEqual(pickConfiguredRoute(routes, { prompt: "nothing", metadata: { taskType: "finance" } }, {}), { key: "finance", modelId: "provider/finance" });
});

test("neutral execution envelope is session, request, model, expiry, and nonce bound", () => {
  const sessionKey = "agent:main:test";
  const envelope = {
    schema: "togglelogic.execution-envelope/v1",
    expires_at_ms: Date.now() + 30_000,
    session_key_hash: crypto.createHash("sha256").update(sessionKey).digest("hex"),
    request_digest: "request-1",
    nonce: "a".repeat(32),
    selected_model_ref: "provider/model",
    execution_policy: { max_tool_calls: 4, estimated_tokens: 1000, max_estimated_cost_usd: 1, disable_tools: false },
  };
  assert.equal(validateExecutionEnvelope(envelope, { sessionKey, requestDigest: "request-1" }), envelope);
  assert.throws(() => validateExecutionEnvelope(envelope, { sessionKey: "other", requestDigest: "request-1" }), /session mismatch/);
  assert.throws(() => validateExecutionEnvelope({ ...envelope, expires_at_ms: 0 }, { sessionKey, requestDigest: "request-1" }), /expired/);
  const validator = createEnvelopeValidator();
  validator.consume(envelope, { sessionKey, requestDigest: "request-1" });
  assert.throws(() => validator.consume(envelope, { sessionKey, requestDigest: "request-1" }), /replayed/);
});

test("generic artifact delivery requires an exact consumer-authorized destination", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "togglelogic-artifact-"));
  const staging = path.join(rootDir, "staging"); const output = path.join(rootDir, "output.bin");
  fs.mkdirSync(staging); const source = path.join(staging, "source.bin"); fs.writeFileSync(source, "verified bytes");
  const hash = crypto.createHash("sha256").update("verified bytes").digest("hex");
  const body = `${MANIFEST_BEGIN}${JSON.stringify({ schema_version: 1, child_verification: "passed", artifacts: [{ source, destination: output, sha256: hash, verified: true }] })}${MANIFEST_END}`;
  const denied = deliverAuthorizedArtifacts({ text: body, stagingDirectory: staging, authorizedDestinations: [] });
  assert.equal(denied.status, "failed"); assert.equal(fs.existsSync(output), false);
  const delivered = deliverAuthorizedArtifacts({ text: body, stagingDirectory: staging, authorizedDestinations: [output] });
  assert.equal(delivered.status, "complete"); assert.equal(fs.readFileSync(output, "utf8"), "verified bytes");
  fs.rmSync(rootDir, { recursive: true, force: true });
});

test("shipped v2 source and public narrative contain no known application policy", () => {
  const roots = ["src", "README.md", "CHANGELOG.md", "openclaw.plugin.json", "docs/RELEASE-NOTES-2.0.0.md"];
  const files = [];
  const visit = (entry) => {
    const full = path.join(root, entry);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) for (const child of fs.readdirSync(full)) visit(path.join(entry, child));
    else files.push(full);
  };
  roots.forEach(visit);
  const text = files.map((file) => fs.readFileSync(file, "utf8")).join("\n");
  for (const forbidden of ["PowerPoint", "QuickBooks", "Microsoft Graph", "Zoom", "meeting-prep", "clickitcrm", "togglelogic_skill_plan", "togglelogic_skill_run"]) {
    assert.equal(text.includes(forbidden), false, `forbidden application term shipped: ${forbidden}`);
  }
});
