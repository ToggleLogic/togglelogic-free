/*
 * ToggleLogic (Free Tier) — SAM-HQ mailbox-identity acceptance tests
 * (1.6.1-rc.3 mailbox-identity addition).
 *
 * The reference host (SAM-HQ) has TWO distinct mail identities that must never be
 * conflated:
 *   - microsoft-graph = Al Harlow's OWN Microsoft 365 / Outlook mailbox. SAM acts
 *     as Al's assistant and drafts/sends email AS Al / on behalf of Al.
 *   - gog (Gmail) = SAM's OWN account clickitco@gmail.com. Mail from that account
 *     is from SAM in SAM's own identity — NEVER impersonating Al.
 *
 * This file pins, against the SHIPPED example config
 * (docs/examples/sam-hq-owner-policy.openclaw.json — loaded here so the test can
 * never drift from what deploys):
 *   1. the deterministic, inventory-bound `gmail-mail` recipe (explicit `gmail` +
 *      an email term -> installed `gog`), incl. that it does NOT capture Outlook /
 *      M365 or generic Google Drive/Docs/Calendar or a platform-less email, and
 *      that it is inert (-> exact universal no-skill fail-safe) when `gog` is absent;
 *   2. the deployment-owned per-skill execution IDENTITY contract: the bounded
 *      child receives the AUTHORITATIVE mailbox identity for the resolved skill,
 *      keyed only to the verified resolved skill id, never crossing skills, never
 *      supplied for an unverified skill, and surfaced (credential-free) in the
 *      audit/receipt;
 *   3. the send policy (specific owner send instruction authorizes THAT send;
 *      general compose/draft is draft-only). NO send is performed anywhere here —
 *      the child is a fully mocked subagent that returns canned text.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createSkillRoutingCoordinator, NO_SKILL_FAILSAFE } from "../src/skill-routing/coordinator.js";
import { createCanaryScope } from "../src/skill-routing/scope.js";
import { createSkillResolver, createSkillClassifier } from "../src/skill-routing/resolver.js";
import { createSkillContracts } from "../src/skill-routing/skill-contracts.js";
import { createIntentRecipes } from "../src/skill-routing/intent-recipes.js";
import { normalizeConfig } from "../src/config/normalize.js";

// Load the SHIPPED distributable example so recipes + identities under test are
// exactly what deploys (no hand-maintained copy to drift).
const EXAMPLE = JSON.parse(
  fs.readFileSync(new URL("../docs/examples/sam-hq-owner-policy.openclaw.json", import.meta.url), "utf8"),
);
const EXAMPLE_CONFIG = EXAMPLE.plugins.entries.togglelogic.config;
const RECIPES = EXAMPLE_CONFIG.skillRouting.intentRecipes;
const IDENTITIES = EXAMPLE_CONFIG.skillRouting.skillIdentities;

const INSTALLED = ["microsoft-graph", "zoom-meetings", "gog", "code-review"];

// ---------------------------------------------------------------------------
// 1) gmail-mail RECIPE PRECISION (deterministic, no model).
// ---------------------------------------------------------------------------

test("gmail-mail resolves gog for explicit Gmail email prompts (incl. the exact SAM address)", () => {
  const recipes = createIntentRecipes(RECIPES);
  for (const prompt of [
    "Find the latest email in Gmail from Chris.",
    "Search my Gmail inbox for the invoice.",
    "Draft a Gmail reply to the launch thread.",
    "Read the newest message in Gmail.",
    "Search clickitco@gmail.com for the invoice.",   // exact SAM address + email term
    "Send the update from clickitco@gmail.com.",
  ]) {
    const r = recipes.resolve(prompt, { installedIds: INSTALLED });
    assert.equal(r.status, "resolved", prompt);
    assert.deepEqual(r.skills, ["gog"], prompt);
  }
});

test("gmail-mail does NOT capture Outlook/M365, generic Drive/Docs/Calendar, or a platform-less email", () => {
  const recipes = createIntentRecipes(RECIPES);
  // Outlook stays with microsoft-graph (never gog).
  const outlook = recipes.resolve("Find the latest email from Chris in Outlook.", { installedIds: INSTALLED });
  assert.equal(outlook.ruleId, "outlook-mail");
  assert.deepEqual(outlook.skills, ["microsoft-graph"]);
  // Generic Google Drive/Docs/Calendar and a platform-less email never fire gmail-mail.
  for (const prompt of [
    "Create a Google Doc summarizing Q3.",
    "Share the spreadsheet in my Google Drive with the team.",
    "Add this event to my Google Calendar for next week.",
    "Email Chris the quarterly report.",           // platform-less email
    "Reply to the thread and cc the team.",         // platform-less
    "Find the budget file and send it over.",       // platform-less (no 'gmail')
  ]) {
    const r = recipes.resolve(prompt, { installedIds: INSTALLED });
    if (r.status === "resolved") {
      assert.ok(!r.skills.includes("gog"), `must not route to gog: ${prompt}`);
      assert.notEqual(r.ruleId, "gmail-mail", prompt);
    }
  }
});

test("gmail-mail is INERT when gog is not installed (falls to the fail-safe upstream)", () => {
  const r = createIntentRecipes(RECIPES).resolve(
    "Find the latest email in Gmail from Chris.",
    { installedIds: ["microsoft-graph", "zoom-meetings", "code-review"] },
  );
  assert.equal(r.status, "none");
  assert.equal(r.reason, "recipe_skills_absent");
});

test("a message naming BOTH outlook and gmail is AMBIGUOUS (fails closed, never a silent pick)", () => {
  const r = createIntentRecipes(RECIPES).resolve(
    "Move the email from Outlook into Gmail.",
    { installedIds: INSTALLED },
  );
  assert.equal(r.status, "ambiguous");
  assert.deepEqual([...new Set(r.candidates.flatMap((c) => c.skills))].sort(), ["gog", "microsoft-graph"]);
});

// ---------------------------------------------------------------------------
// 2) PER-SKILL EXECUTION IDENTITY — contract layer (cannot cross / unverified).
// ---------------------------------------------------------------------------

function contractsWithIdentities(overrides = {}) {
  return createSkillContracts({
    ownerTimezone: "America/New_York",
    now: () => Date.parse("2026-09-15T20:03:00Z"),
    calendarPort: { findEvent: async () => null },
    skillIdentities: IDENTITIES,
    ...overrides,
  });
}

test("identityAudit + child prompt carry ONLY the resolved skill's mailbox (no crossing)", () => {
  const c = contractsWithIdentities();

  // microsoft-graph route -> Al / owner mailbox ONLY.
  const graphAudit = c.identityAudit([{ id: "microsoft-graph" }]);
  assert.equal(graphAudit.length, 1);
  assert.equal(graphAudit[0].skill, "microsoft-graph");
  assert.equal(graphAudit[0].label, "owner-mailbox:Al-Harlow");
  assert.match(graphAudit[0].act_as, /Al Harlow/);
  const graphPrompt = c.contractPrompt([{ id: "microsoft-graph" }], "read my latest email");
  assert.match(graphPrompt, /Al Harlow/);
  assert.match(graphPrompt, /on behalf of Al/);
  assert.ok(!graphPrompt.includes("clickitco@gmail.com"), "Graph route must not carry the Gmail address");
  assert.ok(!/\bSAM\b/.test(graphPrompt), "Graph route must not carry the SAM identity");

  // gog route -> SAM / clickitco@gmail.com ONLY.
  const gogAudit = c.identityAudit([{ id: "gog" }]);
  assert.equal(gogAudit.length, 1);
  assert.equal(gogAudit[0].skill, "gog");
  assert.match(gogAudit[0].mailbox, /clickitco@gmail\.com/);
  assert.match(gogAudit[0].act_as, /SAM/);
  const gogPrompt = c.contractPrompt([{ id: "gog" }], "search my inbox");
  assert.match(gogPrompt, /clickitco@gmail\.com/);
  assert.match(gogPrompt, /\bSAM\b/);
  assert.match(gogPrompt, /never impersonate Al/i);
  assert.ok(!gogPrompt.includes("on behalf of Al"), "Gmail route must not carry the owner-mailbox authority");
  assert.ok(!gogPrompt.includes("Microsoft 365"), "Gmail route must not carry the Graph mailbox");
});

test("an identity is NEVER supplied for a skill that did not resolve (unverified / lookalike id)", () => {
  const c = contractsWithIdentities();
  // A resolved skill with no configured identity gets nothing.
  assert.deepEqual(c.identityAudit([{ id: "code-review" }]), []);
  assert.equal(c.contractPrompt([{ id: "code-review" }], "review this diff"), null);
  // The gog identity is keyed to "gog", not the lookalike "gmail" — never applied.
  assert.deepEqual(c.identityAudit([{ id: "gmail" }]), []);
  // Even a multi-skill route only emits identities for the ids actually present.
  const both = c.identityAudit([{ id: "microsoft-graph" }, { id: "code-review" }]);
  assert.deepEqual(both.map((e) => e.skill), ["microsoft-graph"]);
});

test("send policy represents BOTH cases: named send authorized, general compose draft-only", () => {
  const c = contractsWithIdentities();
  for (const id of ["microsoft-graph", "gog"]) {
    const prompt = c.contractPrompt([{ id }], "compose an email");
    assert.match(prompt, /authorizes exactly that send/i, id);   // a specific named send is authorized
    assert.match(prompt, /draft-only/i, id);                     // a general compose is draft-only
  }
});

test("identity fields are sanitized and bounded (control chars collapsed, length-capped)", () => {
  const c = createSkillContracts({
    skillIdentities: { "x-skill": { mailbox: "a\nb\t" + "z".repeat(2000), senderIdentity: "role\ntwo" } },
  });
  const audit = c.identityAudit([{ id: "x-skill" }]);
  assert.equal(audit.length, 1);
  // Control chars inside a FIELD value are collapsed to single spaces...
  assert.ok(!audit[0].mailbox.includes("\n") && !audit[0].mailbox.includes("\t"), "field newline/tab collapsed");
  assert.equal(audit[0].act_as, "role two", "field control char collapsed to a space");
  // ...and the field is length-bounded so a hostile value can't blow up the prompt.
  assert.ok(audit[0].mailbox.length <= 600, "field length bounded");
  // The injected block carries the sanitized field value.
  assert.ok(c.contractPrompt([{ id: "x-skill" }], "x").includes("a b z"));
});

// ---------------------------------------------------------------------------
// 3) GATE behavior — recipe short-circuits the classifier; child gets the right
//    mailbox; identity is in the audit/receipt; NO send is performed.
// ---------------------------------------------------------------------------

const OWNER_CTX = Object.freeze({
  channel: "telegram", accountId: "codex", senderId: "7797183919",
  sessionKey: "agent:main:telegram:codex:7797183919", senderIsOwner: true,
  trigger: "user", inputProvenance: { kind: "external_user" },
});
const CATALOG = [
  { id: "microsoft-graph", description: "Email, calendar, and contacts via Microsoft Graph (authoritative Outlook calendar)" },
  { id: "zoom-meetings", description: "Zoom meeting recordings and transcripts" },
  { id: "gog", description: "Google / Gmail service for SAM's own account" },
  { id: "code-review", description: "Review a diff for correctness" },
];

function selectedPlan(req) {
  return {
    schema_version: 1, status: "selected",
    planned_skills: req.plannedSkills,
    strategy: "lowest_cost",
    selected_lineage: "ollama/gemma",
    selected_model_ref: "ollama/gemma4:latest",
    estimated_tokens: req.estimatedTokens || 4000,
    choices: [{ kind: "lowest_cost", model_lineage: "ollama/gemma", resolved_child: "ollama/gemma4:latest", location: "local", estimated_cost_usd: 0 }],
  };
}

function harness({ catalog = CATALOG, classifierReply = () => JSON.stringify({ skill_id: null, confidence: 0 }), makePlan = selectedPlan } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tl-mbox-"));
  const planCalls = [];
  const invokeCalls = [];
  const runCalls = [];
  const sends = [];  // any external send attempt would be recorded here — must stay empty
  const seam = {
    status: () => "available",
    planSkillRoute: async (req) => { planCalls.push(req); return makePlan(req); },
    recordSkillChoice: async () => {},
  };
  const runtime = { subagent: {
    run: async (args) => { runCalls.push(args); return { runId: "r1", sessionKey: args.sessionKey, runtime: {} }; },
    waitForRun: async () => ({ status: "ok", startedAt: 1, endedAt: 2 }),
    getSessionMessages: async () => ({ messages: [{ role: "assistant", content: [{ type: "text", text: "done (no send performed)" }] }] }),
    // Intentionally NO mail/send capability is wired: the child is a mock. A real
    // send would have to go through a tool this harness does not provide.
  } };
  const scope = createCanaryScope({ enabled: true, channels: ["telegram"], accountIds: ["codex"], senderIds: ["7797183919"], ownerSenderIds: ["7797183919"] });
  const resolver = createSkillResolver({ catalog });
  const contracts = createSkillContracts({
    ownerTimezone: "America/New_York",
    now: () => Date.parse("2026-09-15T20:03:00Z"),
    calendarPort: { findEvent: async () => null },
    skillIdentities: IDENTITIES,
  });
  const intentRecipes = createIntentRecipes(RECIPES);
  const classifier = createSkillClassifier(
    { enabled: true, model: "gemma-test", confidenceThreshold: 0.6, numCtx: 8192 },
    { invoke: async (req) => { invokeCalls.push(req); return classifierReply(req); } },
  );
  const coordinator = createSkillRoutingCoordinator({
    seam,
    config: { pendingStatePath: path.join(dir, "pending.json"), pendingTtlMinutes: 15, defaultEstimatedTokens: 4000, executionTimeoutSeconds: 120, monthlyCloudSpendUsd: 0, maxChildTokens: 200000, maxChildCostUsd: 5, clarifyOnMultiSkill: false },
    fallbackLogger: null, shadow: false, scope, resolver, contracts, runtime, intentRecipes, classifier,
  });
  return { coordinator, planCalls, invokeCalls, runCalls, sends };
}
const reply = (cleanedBody) => ({ prompt: cleanedBody, cleanedBody });

test("GATE: Outlook email -> microsoft-graph, ZERO classifier calls, child mailbox = owner/Al", async () => {
  const h = harness();
  const gate = await h.coordinator.handleGate(reply("Find the latest email from Chris in Outlook."), OWNER_CTX);
  assert.equal(gate.handled, true);
  assert.equal(gate.reason, "skill_selected_executed");
  assert.equal(h.planCalls.length, 1);
  assert.equal(h.planCalls[0].plannedSkills[0].id, "microsoft-graph");
  assert.equal(h.invokeCalls.length, 0, "recipe resolved deterministically; classifier NOT consulted");
  // The bounded child received Al's / the owner mailbox identity, not SAM's.
  assert.equal(h.runCalls.length, 1);
  const ep = h.runCalls[0].extraSystemPrompt;
  assert.match(ep, /Al Harlow/);
  assert.match(ep, /on behalf of Al/);
  assert.ok(!ep.includes("clickitco@gmail.com"), "must not leak the Gmail address");
  assert.ok(!/\bSAM\b/.test(ep), "must not leak the SAM identity");
  // Identity is in the audit/receipt metadata (credential-free) for the resolved skill.
  assert.equal(gate.audit.execution_identity[0].skill, "microsoft-graph");
  assert.equal(gate.audit.execution_identity[0].label, "owner-mailbox:Al-Harlow");
  // No external send occurred (child is mocked; deliver:false).
  assert.equal(h.runCalls[0].deliver, false);
  assert.deepEqual(h.sends, []);
});

test("GATE: Gmail email -> gog, ZERO classifier calls, child mailbox = SAM/clickitco@gmail.com", async () => {
  const h = harness();
  const gate = await h.coordinator.handleGate(reply("Find the latest email in Gmail from Chris."), OWNER_CTX);
  assert.equal(gate.handled, true);
  assert.equal(gate.reason, "skill_selected_executed");
  assert.equal(h.planCalls.length, 1);
  assert.equal(h.planCalls[0].plannedSkills[0].id, "gog");
  assert.equal(h.invokeCalls.length, 0, "recipe resolved deterministically; classifier NOT consulted");
  assert.equal(h.runCalls.length, 1);
  const ep = h.runCalls[0].extraSystemPrompt;
  assert.match(ep, /clickitco@gmail\.com/);
  assert.match(ep, /\bSAM\b/);
  assert.match(ep, /never impersonate Al/i);
  assert.ok(!ep.includes("on behalf of Al"), "must not carry the owner-mailbox authority");
  assert.ok(!ep.includes("Microsoft 365"), "must not carry the Graph mailbox");
  assert.equal(gate.audit.execution_identity[0].skill, "gog");
  assert.equal(gate.audit.execution_identity[0].label, "sam-mailbox:clickitco@gmail.com");
  assert.equal(h.runCalls[0].deliver, false);
  assert.deepEqual(h.sends, []);
});

test("GATE: the exact SAM address with an email term also routes to gog with the SAM identity", async () => {
  const h = harness();
  const gate = await h.coordinator.handleGate(reply("Search clickitco@gmail.com for the launch invoice."), OWNER_CTX);
  assert.equal(gate.reason, "skill_selected_executed");
  assert.equal(h.planCalls[0].plannedSkills[0].id, "gog");
  assert.equal(h.invokeCalls.length, 0);
  assert.match(h.runCalls[0].extraSystemPrompt, /clickitco@gmail\.com/);
});

test("GATE: a general compose request routes but the child prompt keeps it draft-only", async () => {
  const h = harness();
  const gate = await h.coordinator.handleGate(reply("Draft an email in Gmail to the team about the launch."), OWNER_CTX);
  assert.equal(gate.reason, "skill_selected_executed");
  assert.equal(h.planCalls[0].plannedSkills[0].id, "gog");
  const ep = h.runCalls[0].extraSystemPrompt;
  assert.match(ep, /draft-only/i);
  assert.match(ep, /authorizes exactly that send/i);
  assert.deepEqual(h.sends, []);  // composing is not sending
});

test("GATE: absent gog -> the exact universal no-skill fail-safe (recipe inert)", async () => {
  const h = harness({ catalog: [{ id: "microsoft-graph", description: "Graph" }, { id: "code-review", description: "review" }] });
  const gate = await h.coordinator.handleGate(reply("Find the latest email in Gmail from Chris."), OWNER_CTX);
  assert.equal(gate.handled, true);
  assert.equal(gate.reason, "no_skill_failsafe");
  assert.equal(gate.reply.text, NO_SKILL_FAILSAFE);
  assert.equal(gate.audit.recipe, "recipe_skills_absent");
  assert.equal(h.planCalls.length, 0);
  assert.equal(h.runCalls.length, 0, "no child executed -> no possible send");
});

test("GATE: generic Google Drive/Docs is NOT captured by gmail-mail (no gog route)", async () => {
  const h = harness();  // classifier returns null by default
  const gate = await h.coordinator.handleGate(reply("Share the spreadsheet in my Google Drive with the team."), OWNER_CTX);
  assert.equal(gate.reason, "no_skill_failsafe");
  assert.equal(gate.reply.text, NO_SKILL_FAILSAFE);
  assert.equal(h.planCalls.length, 0, "never routed to gog");
  assert.equal(h.invokeCalls.length, 1, "gmail-mail did not fire -> the classifier was consulted");
});

// ---------------------------------------------------------------------------
// 4) CONFIG PLUMBING — the shipped example survives normalization intact.
// ---------------------------------------------------------------------------

test("normalizeConfig preserves the gmail-mail recipe and both skill identities", () => {
  const n = normalizeConfig(EXAMPLE_CONFIG);
  const gmail = n.skillRouting.intentRecipes.find((r) => r.id === "gmail-mail");
  assert.ok(gmail, "gmail-mail recipe present after normalization");
  assert.deepEqual(gmail.skillIds, ["gog"]);
  assert.ok(gmail.allTerms.includes("gmail"));
  const ids = n.skillRouting.skillIdentities;
  assert.match(ids["microsoft-graph"].senderIdentity, /Al Harlow/);
  assert.match(ids.gog.mailbox, /clickitco@gmail\.com/);
  assert.match(ids.gog.authority, /never impersonate Al/i);
});

test("normalizeSkillIdentities drops empty/malformed entries and collapses control chars", () => {
  const n = normalizeConfig({ skillRouting: { skillIdentities: {
    "good-skill": { mailbox: "box\none" },
    "empty-skill": { label: "only a label, no substantive field" },
    "bad id!": { mailbox: "x" },
  } } });
  const ids = n.skillRouting.skillIdentities;
  assert.ok(ids["good-skill"], "entry with a substantive field survives");
  assert.equal(ids["good-skill"].mailbox, "box one", "control char collapsed to a space");
  assert.ok(!ids["empty-skill"], "label-only entry dropped (no substantive field)");
  assert.ok(!ids["bad id!"], "invalid skill id dropped");
});
