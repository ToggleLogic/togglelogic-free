import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  DELIVERY_MANIFEST_BEGIN,
  DELIVERY_MANIFEST_END,
  deliverArtifactManifest,
  isArtifactDestinationAuthorized,
} from "../src/skill-routing/artifact-delivery.js";
import { createSkillRoutingCoordinator } from "../src/skill-routing/coordinator.js";
import { createCanaryScope } from "../src/skill-routing/scope.js";
import { createSkillResolver } from "../src/skill-routing/resolver.js";
import { createSkillContracts } from "../src/skill-routing/skill-contracts.js";

function hash(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function manifest(entries, verification = "passed") {
  return `Child staged and verified the artifact.\n${DELIVERY_MANIFEST_BEGIN}${JSON.stringify({ schema_version: 1, child_verification: verification, artifacts: entries })}${DELIVERY_MANIFEST_END}`;
}

test("artifact delivery copies verified staged bytes without mutating the source", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tl-artifact-"));
  const staging = path.join(root, "stage");
  fs.mkdirSync(staging);
  const source = path.join(staging, "deck.pptx");
  const destination = path.join(root, "final.pptx");
  const bytes = Buffer.from("verified deck bytes");
  fs.writeFileSync(source, bytes);
  const sha256 = hash(bytes);
  const result = deliverArtifactManifest({
    text: manifest([{ source, destination, sha256, verified: true }]),
    ownerPrompt: `Deliver the final presentation to ${destination}`,
    stagingDir: staging,
  });
  assert.equal(result.status, "complete");
  assert.deepEqual(fs.readFileSync(destination), bytes);
  assert.deepEqual(fs.readFileSync(source), bytes, "staged source is retained unchanged");
  assert.equal(result.entries[0].verified_sha256, sha256);
  assert.doesNotMatch(result.cleanText, /togglelogic_delivery_manifest/);
});

test("artifact delivery refuses overwrite and never changes an existing destination", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tl-artifact-"));
  const staging = path.join(root, "stage");
  fs.mkdirSync(staging);
  const source = path.join(staging, "deck.pptx");
  const destination = path.join(root, "final.pptx");
  fs.writeFileSync(source, "new bytes");
  fs.writeFileSync(destination, "owner bytes");
  const result = deliverArtifactManifest({
    text: manifest([{ source, destination, sha256: hash("new bytes"), verified: true }]),
    ownerPrompt: destination,
    stagingDir: staging,
  });
  assert.equal(result.status, "failed");
  assert.match(result.entries[0].error, /overwrite refused/);
  assert.equal(fs.readFileSync(destination, "utf8"), "owner bytes");
});

test("artifact delivery rejects unprompted destinations, outside-stage sources, and hash drift", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tl-artifact-"));
  const staging = path.join(root, "stage");
  fs.mkdirSync(staging);
  const inside = path.join(staging, "inside.pptx");
  const outside = path.join(root, "outside.pptx");
  fs.writeFileSync(inside, "inside");
  fs.writeFileSync(outside, "outside");
  const prompted = path.join(root, "prompted.pptx");
  const injected = path.join(root, "injected.pptx");
  const result = deliverArtifactManifest({
    text: manifest([
      { source: inside, destination: injected, sha256: hash("inside"), verified: true },
      { source: outside, destination: prompted, sha256: hash("outside"), verified: true },
      { source: inside, destination: prompted, sha256: "0".repeat(64), verified: true },
    ]),
    ownerPrompt: `Only deliver to ${prompted}`,
    stagingDir: staging,
  });
  assert.equal(result.status, "failed");
  assert.match(result.entries[0].error, /not authorized/);
  assert.match(result.entries[1].error, /outside this run's staging/);
  assert.match(result.entries[2].error, /does not match/);
  assert.equal(fs.existsSync(injected), false);
  assert.equal(fs.existsSync(prompted), false);
});

test("real owner prompt authorizes exactly three new artifacts beside its explicitly named source deck", () => {
  const prompt = String.raw`Sam, I need you to take this presentation found here: /Users/openclaw/Library/Mobile\ Documents/com\~apple\~CloudDocs/5.\ PRESENTATIONS/MASTER-Click\ IT\ Pitch\ Deck\ v3.pptx
 and place into the notes this script found here: /Users/openclaw/Library/Mobile\ Documents/com\~apple\~CloudDocs/5.\ PRESENTATIONS/New\ Script\ 09-16-2026.txt`;
  const parent = "/Users/openclaw/Library/Mobile Documents/com~apple~CloudDocs/5. PRESENTATIONS";
  const destinations = [
    `${parent}/MASTER-Click IT Pitch Deck v3 - Scripted.pptx`,
    `${parent}/Teleprompter Script - 3 Minute.txt`,
    `${parent}/Teleprompter Script - 6 Minute.txt`,
  ];
  for (const destination of destinations) {
    assert.equal(isArtifactDestinationAuthorized(prompt, destination, { allowBesidePromptedPptx: true }), true, destination);
  }
  assert.equal(isArtifactDestinationAuthorized(prompt, `${parent}/exports/hidden.pptx`, { allowBesidePromptedPptx: true }), false, "descendant directory is not authorized");
  assert.equal(isArtifactDestinationAuthorized(prompt, "/Users/openclaw/Desktop/hidden.pptx", { allowBesidePromptedPptx: true }), false, "unmentioned directory is not authorized");
});

test("manifest parsing rejects duplicate end markers and trailing text", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tl-artifact-"));
  const staging = path.join(root, "stage");
  fs.mkdirSync(staging);
  const source = path.join(staging, "a.txt");
  const destination = path.join(root, "a.txt");
  fs.writeFileSync(source, "a");
  const body = manifest([{ source, destination, sha256: hash("a"), verified: true }]);
  const duplicate = deliverArtifactManifest({ text: `${body}${DELIVERY_MANIFEST_END}`, ownerPrompt: destination, stagingDir: staging });
  assert.equal(duplicate.status, "failed");
  assert.match(duplicate.error, /ambiguous/);
  const trailing = deliverArtifactManifest({ text: `${body}\nI also did something else`, ownerPrompt: destination, stagingDir: staging });
  assert.equal(trailing.status, "failed");
  assert.match(trailing.error, /ambiguous/);
});

test("multi-entry manifest is prevalidated atomically before any copy", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tl-artifact-"));
  const staging = path.join(root, "stage");
  fs.mkdirSync(staging);
  const sourceA = path.join(staging, "a.txt");
  const sourceB = path.join(staging, "b.txt");
  const destinationA = path.join(root, "a-final.txt");
  const destinationB = path.join(root, "b-final.txt");
  fs.writeFileSync(sourceA, "a");
  fs.writeFileSync(sourceB, "b");
  const result = deliverArtifactManifest({
    text: manifest([
      { source: sourceA, destination: destinationA, sha256: hash("a"), verified: true },
      { source: sourceB, destination: destinationB, sha256: "0".repeat(64), verified: true },
    ]),
    ownerPrompt: `Deliver to ${destinationA} and ${destinationB}`,
    stagingDir: staging,
  });
  assert.equal(result.status, "failed");
  assert.equal(fs.existsSync(destinationA), false, "valid first entry was not copied before later validation failed");
  assert.equal(fs.existsSync(destinationB), false);
});

test("PowerPoint bounded child stages, manifests, and parent performs verified delivery", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tl-artifact-e2e-"));
  const stagingRoot = path.join(root, "staging");
  const destination = path.join(root, "owner-final.pptx");
  let assistantResult = "";
  let runInput;
  const runtime = { subagent: {
    run: async (input) => {
      runInput = input;
      const match = input.extraSystemPrompt.match(/run's staging directory: (.+)/);
      assert.ok(match, "child received its unique staging directory");
      const source = path.join(match[1].trim(), "staged.pptx");
      fs.writeFileSync(source, "pptx payload");
      assistantResult = manifest([{ source, destination, sha256: hash("pptx payload"), verified: true }]);
      return { runId: "artifact-run", sessionKey: input.sessionKey, runtime: { provider: input.provider, model: input.model } };
    },
    waitForRun: async () => ({ status: "ok" }),
    getSessionMessages: async () => ({ messages: [{ role: "assistant", content: assistantResult }] }),
  } };
  const coordinator = createSkillRoutingCoordinator({
    seam: {
      status: () => "available",
      planSkillRoute: async (request) => ({
        status: "selected", planned_skills: request.plannedSkills, strategy: "lowest_cost",
        selected_lineage: "openai/gpt", selected_model_ref: "openai/gpt-5.5", estimated_tokens: 4000,
        choices: [{ kind: "lowest_cost", estimated_cost_usd: 0.01 }],
      }),
      recordSkillChoice: async () => {},
    },
    config: {
      pendingStatePath: path.join(root, "pending.json"), artifactStagingRoot: stagingRoot,
      pendingTtlMinutes: 15, defaultEstimatedTokens: 4000, executionTimeoutSeconds: 120,
      monthlyCloudSpendUsd: 0, maxChildTokens: 200000, maxChildCostUsd: 5,
    },
    scope: createCanaryScope({ enabled: true, channels: ["telegram"], accountIds: ["codex"], senderIds: ["owner"], ownerSenderIds: ["owner"] }),
    resolver: createSkillResolver({ catalog: [{ id: "powerpoint-editor", version: "1", fingerprint: "fp", execution_class: "artifact" }] }),
    contracts: createSkillContracts({ ownerTimezone: "America/New_York" }),
    runtime,
  });
  const ctx = { channel: "telegram", accountId: "codex", senderId: "owner", sessionKey: "parent", trigger: "user", inputProvenance: { kind: "external_user" } };
  const prompt = `Use powerpoint-editor skill. Deliver the new file to ${destination}`;
  const gate = await coordinator.handleGate({ prompt, cleanedBody: prompt }, ctx);
  assert.equal(gate.reason, "skill_selected_executed");
  assert.equal(fs.readFileSync(destination, "utf8"), "pptx payload");
  assert.match(gate.reply.text, /Artifact delivery verified/);
  assert.doesNotMatch(gate.reply.text, /togglelogic_delivery_manifest/);
  assert.match(runInput.extraSystemPrompt, /Do not attempt to copy, move, or write an artifact to the requested final destination/);
});

test("PowerPoint delivery failure is reported as incomplete, never successful completion", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tl-artifact-e2e-"));
  const destination = path.join(root, "not-mentioned-final.pptx");
  let response;
  const runtime = { subagent: {
    run: async (input) => {
      const staging = input.extraSystemPrompt.match(/run's staging directory: (.+)/)[1].trim();
      const source = path.join(staging, "staged.pptx");
      fs.writeFileSync(source, "payload");
      response = manifest([{ source, destination, sha256: hash("payload"), verified: true }]);
      return { runId: "r", sessionKey: input.sessionKey };
    },
    waitForRun: async () => ({ status: "ok" }),
    getSessionMessages: async () => ({ messages: [{ role: "assistant", content: response }] }),
  } };
  const coordinator = createSkillRoutingCoordinator({
    seam: { status: () => "available", planSkillRoute: async (r) => ({ status: "selected", planned_skills: r.plannedSkills, strategy: "lowest_cost", selected_lineage: "openai/gpt", selected_model_ref: "openai/gpt-5.5", estimated_tokens: 1, choices: [{ kind: "lowest_cost", estimated_cost_usd: 0 }] }), recordSkillChoice: async () => {} },
    config: { pendingStatePath: path.join(root, "p.json"), artifactStagingRoot: path.join(root, "staging"), pendingTtlMinutes: 15, defaultEstimatedTokens: 4000, executionTimeoutSeconds: 120, monthlyCloudSpendUsd: 0, maxChildTokens: 200000, maxChildCostUsd: 5 },
    scope: createCanaryScope({ enabled: true, channels: ["telegram"], accountIds: ["codex"], senderIds: ["owner"], ownerSenderIds: ["owner"] }),
    resolver: createSkillResolver({ catalog: [{ id: "powerpoint-editor", version: "1", fingerprint: "fp" }] }),
    contracts: createSkillContracts({ ownerTimezone: "America/New_York" }), runtime,
  });
  const ctx = { channel: "telegram", accountId: "codex", senderId: "owner", sessionKey: "p", trigger: "user", inputProvenance: { kind: "external_user" } };
  const prompt = "Use powerpoint-editor skill and make a deck, but I did not specify a destination.";
  const gate = await coordinator.handleGate({ prompt, cleanedBody: prompt }, ctx);
  assert.equal(gate.reason, "skill_selected_artifact_delivery_incomplete");
  assert.equal(gate.audit.completion_verified, false);
  assert.match(gate.reply.text, /ARTIFACT DELIVERY INCOMPLETE/);
  assert.equal(fs.existsSync(destination), false);
});
