/*
 * ToggleLogic (Free Tier) — IN-PROCESS FAITHFUL gateway harness test.
 *
 * HONEST SCOPE (correcting the prior "real-gateway" overstatement): this is NOT
 * an isolated OpenClaw gateway OS process nor a real network/message round trip.
 * It is an in-process harness that registers the plugin's capabilities EXACTLY as
 * the host does (registerCapabilities → api.on), then delivers a genuine
 * before_agent_reply payload ({ cleanedBody }) with a real-shaped
 * PluginHookAgentContext (NO skill fields) to the CAPTURED hook. The full
 * in-process chain runs — interceptor.preflight → coordinator.handleGate →
 * snapshot-inventory resolver → scope → seam → detector → adapter — with a
 * minimal but detector-valid paired Intelligence fixture. No planner is called
 * directly. This is NOT an isolated OpenClaw gateway OS process nor a real
 * network/message round trip: a true isolated-gateway round trip would require
 * standing up the OpenClaw gateway process, which the plugin's public test surface
 * does not expose; that remains a deployment-side observation step (see report).
 *
 * The skill membership set comes from a deployment-owned, versioned +
 * fingerprinted SNAPSHOT (the authoritative inventory), NOT a hand-written config
 * catalog and NOT the workspace skill_manifest.json. It deliberately mirrors
 * reality: `meeting-prep` is NOT installed but `zoom-meetings` IS, so the
 * 2026-09-15 incident prompt now reports the named skill unavailable and offers
 * the applicable installed skill instead of fabricating — and an INSTALLED skill
 * resolves.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { normalizeConfig } from "../src/config/normalize.js";
import { registerCapabilities } from "../src/capabilities.js";
import { NO_SKILL_FAILSAFE } from "../src/skill-routing/coordinator.js";
import { buildSnapshotFromSkillsList } from "../src/skill-routing/skill-inventory.js";

const FREE_VERSION = "1.6.1-rc.2";
const INTEL_VERSION = "1.4.1-rc.2";
const INCIDENT_PROMPT = "Prepare me for my 2 pm meeting using the meeting-prep skill.";
const INSTALLED_SKILL_PROMPT = "run the code-review skill on this diff";
const OWNER_CTX = Object.freeze({
  channel: "telegram", accountId: "codex", senderId: "7797183919",
  sessionKey: "agent:main:telegram:codex:7797183919", senderIsOwner: true,
  trigger: "user", inputProvenance: { kind: "external_user" },
});

// A minimal Intelligence layer the REAL detector accepts (valid manifest,
// matching entrypoint hash, paired compat interval) — so the real seam+adapter
// load it. Its planSkills returns an education plan; no model is ever called.
function buildIntelligenceFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tl-intel-fixture-"));
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  const classifier = `
export async function waitForReachability() { return true; }
export function classify() { return { required_tier: null, recommended_model_ref: null, confidence: 0, matched_rule: "no_decision", reasoning: "stub", required_surface: null, pin_matched: null, pin_resolution: null, family_routing: null }; }
export function planSkills(prompt, context) {
  const skills = (context && context.plannedSkills) || [];
  const id = skills[0] ? (skills[0].id || skills[0]) : "unknown";
  return {
    schema_version: 1, status: "education_required",
    planned_skills: skills.map((s) => (typeof s === "string" ? { id: s, execution_class: "default" } : s)),
    profile_matches: [{ skill_id: id, status: "missing" }],
    required_tier: "tool_calling_strong", required_surface: null, privacy: "cloud_allowed", estimated_tokens: 4000,
    choices: [
      { kind: "lowest_cost", model_lineage: "google/gemini-flash", resolved_child: "google/gemini-3.5-flash", location: "cloud", estimated_cost_usd: 0.002 },
      { kind: "benchmark_best", model_lineage: "anthropic/claude-sonnet", resolved_child: "anthropic/claude-sonnet-4.6", location: "cloud", estimated_cost_usd: 0.02 },
      { kind: "intelligence", model_lineage: "google/gemini-flash", resolved_child: "google/gemini-3.5-flash", location: "cloud", estimated_cost_usd: 0.002 },
    ],
    choices_converged: false, selected_model_ref: null, selected_lineage: null, strategy: null,
    economic_policy: { monthly_cloud_budget_usd: 8.33, monthly_headroom_usd: 8.33 },
  };
}
export function recordSkillChoice() { return { ok: true }; }
`;
  const entrypointRel = "src/classifier.js";
  fs.writeFileSync(path.join(dir, entrypointRel), classifier);
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "togglelogic-intelligence", version: INTEL_VERSION, type: "module", main: "src/classifier.js" }));
  fs.writeFileSync(path.join(dir, "normalized.json"), JSON.stringify({ models: [] }));
  const hash = crypto.createHash("sha256").update(fs.readFileSync(path.join(dir, entrypointRel))).digest("hex");
  fs.writeFileSync(path.join(dir, "release-manifest.json"), JSON.stringify({
    schema_version: 2, product: "togglelogic-intelligence", version: INTEL_VERSION,
    release_state: "release_candidate", seam_abi: 1, classifier_api: 1,
    plugin_compatibility: { minimum: "1.6.0", maximum_exclusive: "1.7.0", validated_versions: [FREE_VERSION] },
    entrypoint: entrypointRel, entrypoint_sha256: hash, quality_gate: "scripts/quality_gate.sh", bom: "release/bom.json",
  }));
  return dir;
}

// A deployment-owned, versioned + fingerprinted SNAPSHOT (the authoritative
// inventory) written exactly as scripts/generate-skill-inventory.mjs would from
// `openclaw skills list --json`. Mirrors reality: meeting-prep ABSENT,
// identity-eraser INELIGIBLE, zoom-meetings + microsoft-graph ELIGIBLE.
function buildLiveInventory() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tl-inv-"));
  const snapshotPath = path.join(root, "skill-inventory.snapshot.json");
  const listJson = {
    workspaceDir: root,
    managedSkillsDir: path.join(root, "skills"),
    skills: [
      { name: "code-review", description: "Review a diff", eligible: true, disabled: false, source: "clawhub" },
      { name: "microsoft-graph", description: "Email, calendar, contacts", eligible: true, disabled: false, source: "openclaw-bundled" },
      { name: "zoom-meetings", description: "Zoom recordings & transcripts", eligible: true, disabled: false, source: "clawhub" },
      { name: "identity-eraser", description: "erase data", eligible: false, disabled: true, source: "clawhub" }, // INELIGIBLE
    ],
  };
  const snapshot = buildSnapshotFromSkillsList(listJson, { generatedAtMs: Date.now(), pluginFree: FREE_VERSION, pluginIntelligence: INTEL_VERSION });
  fs.writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2));
  return { root, snapshotPath, markerPath: path.join(root, "accepted.json") };
}

// Faithful in-process gateway: registers hooks and can deliver a turn to them.
function makeGateway(config) {
  const hooks = new Map();
  const registeredTools = [];
  const runCalls = [];
  const auditEvents = [];
  const api = {
    pluginConfig: config,
    config: { models: { providers: { google: {}, anthropic: {} } }, agents: { defaults: { model: { primary: "google/gemini-3.5-flash", fallbacks: [] } } } },
    logger: { info() {}, warn() {} },
    on: (name, fn, opts) => { hooks.set(name, { fn, opts }); },
    registerTool: (factory, meta) => registeredTools.push(meta?.name),
    runtime: { subagent: {
      run: async (i) => { runCalls.push(i); return { runId: "r1", sessionKey: i.sessionKey }; },
      waitForRun: async () => ({ status: "ok" }),
      getSessionMessages: async () => ({ messages: [{ role: "assistant", content: "child result" }] }),
    } },
  };
  const audit = { emit: (e) => auditEvents.push(e), path: "(mem)", sessionId: "s", enabled: true };
  registerCapabilities({ api, audit, fallbackLogger: api.logger, version: FREE_VERSION, config: normalizeConfig(config) });
  return { hooks, registeredTools, runCalls, auditEvents,
    async deliver(cleanedBody, ctx) {
      const hook = hooks.get("before_agent_reply");
      assert.ok(hook, "before_agent_reply must be registered");
      return hook.fn({ cleanedBody }, ctx);
    } };
}

function scopedConfig(intel, inv) {
  return {
    mode: "intelligence",
    intelligence: { enabled: true, path: intel, registryPath: path.join(intel, "normalized.json"), shadow: false, allowReleaseCandidate: true },
    features: { routing: { enabled: true }, skillRouting: { enabled: true } },
    skillRouting: {
      inventorySnapshotPath: inv.snapshotPath, inventoryMarkerPath: inv.markerPath,
      pendingStatePath: path.join(inv.root, "skill-routing-pending.json"),
      scope: { enabled: true, channels: ["telegram"], accountIds: ["codex"], senderIds: ["7797183919"], ownerSenderIds: ["7797183919"] },
    },
  };
}

test("E2E: the 2026-09-15 incident prompt (naming the UNINSTALLED meeting-prep skill) reports it unavailable and OFFERS the applicable installed skill, no model call", async () => {
  const intel = buildIntelligenceFixture();
  const inv = buildLiveInventory();
  try {
    const gw = makeGateway(scopedConfig(intel, inv));
    // Host-enforced trigger gating is declared.
    assert.deepEqual(gw.hooks.get("before_agent_reply").opts.eligibleTriggers, ["user"]);
    // The verified snapshot was consumed and audited, and meeting-prep is NOT in it.
    const invCheck = gw.auditEvents.find((e) => e.subject?.check === "skill-inventory-snapshot");
    assert.ok(invCheck, "a skill-inventory-snapshot audit line is emitted");
    assert.equal(invCheck.details.verified, true, "snapshot verified (fresh, right source + pair, fingerprint intact)");
    assert.equal(invCheck.details.eligibleSkillCount, 3, "3 ELIGIBLE skills (identity-eraser is ineligible)");

    const result = await gw.deliver(INCIDENT_PROMPT, OWNER_CTX);
    assert.equal(result.handled, true, "the gate claimed the turn");
    // Owner rule: named skill unavailable, but an installed skill relates → OFFER
    // it (do not fabricate, do not falsely claim no related skill, do not execute).
    assert.equal(result.reason, "skill_named_unavailable_alternatives");
    assert.match(result.reply.text, /meeting prep skill isn't installed/);
    assert.match(result.reply.text, /zoom-meetings/, "offers the applicable installed skill");
    assert.notEqual(result.reply.text, NO_SKILL_FAILSAFE);
    assert.equal(gw.runCalls.length, 0, "no bounded child / model call happened");
  } finally {
    fs.rmSync(intel, { recursive: true, force: true });
    fs.rmSync(inv.root, { recursive: true, force: true });
  }
});

test("E2E: a message naming an INSTALLED active skill resolves to the 3-choice education preflight, no model call", async () => {
  const intel = buildIntelligenceFixture();
  const inv = buildLiveInventory();
  try {
    const gw = makeGateway(scopedConfig(intel, inv));
    const result = await gw.deliver(INSTALLED_SKILL_PROMPT, OWNER_CTX);
    assert.equal(result.handled, true);
    assert.equal(result.reason, "skill_education_required");
    assert.match(result.reply.text, /use these skills: code-review/);
    assert.match(result.reply.text, /Reply 1, 2, or 3/);
    assert.equal(gw.runCalls.length, 0, "education preflight runs no model");
  } finally {
    fs.rmSync(intel, { recursive: true, force: true });
    fs.rmSync(inv.root, { recursive: true, force: true });
  }
});

test("E2E: the same installed-skill message from Slack stays passthrough (out of canary scope)", async () => {
  const intel = buildIntelligenceFixture();
  const inv = buildLiveInventory();
  try {
    const gw = makeGateway(scopedConfig(intel, inv));
    const slackCtx = { channel: "slack", accountId: "clickitco", senderId: "U045ZTBPB33", sessionKey: "slack-1", trigger: "user", inputProvenance: { kind: "external_user" } };
    const result = await gw.deliver(INSTALLED_SKILL_PROMPT, slackCtx);
    assert.equal(result.handled, false, "out-of-scope turn is not gated");
    assert.equal(gw.runCalls.length, 0);
  } finally {
    fs.rmSync(intel, { recursive: true, force: true });
    fs.rmSync(inv.root, { recursive: true, force: true });
  }
});

test("E2E: startup fails LOUD (forced shadow) when the canary scope is unconfigured", async () => {
  const intel = buildIntelligenceFixture();
  const inv = buildLiveInventory();
  try {
    const rawConfig = {
      mode: "intelligence",
      intelligence: { enabled: true, path: intel, registryPath: path.join(intel, "normalized.json"), shadow: false, allowReleaseCandidate: true },
      features: { routing: { enabled: true }, skillRouting: { enabled: true } },
      // scope omitted → unconstrained → must NOT become a global active canary
      skillRouting: { inventorySnapshotPath: inv.snapshotPath, inventoryMarkerPath: inv.markerPath },
    };
    const gw = makeGateway(rawConfig);
    const check = gw.auditEvents.find((e) => e.subject?.check === "host-affordances");
    assert.ok(check, "a host-affordance self-check audit line is emitted");
    assert.ok(check.details.warnings.some((w) => /INERT|scope/i.test(w)), "warns that active gating is inert without scope");
    // In-scope-looking owner turn still does not actively gate (shadow).
    const result = await gw.deliver(INSTALLED_SKILL_PROMPT, OWNER_CTX);
    assert.equal(result.handled, false, "unscoped skill routing stays shadow/passthrough");
    assert.equal(gw.runCalls.length, 0);
  } finally {
    fs.rmSync(intel, { recursive: true, force: true });
    fs.rmSync(inv.root, { recursive: true, force: true });
  }
});
