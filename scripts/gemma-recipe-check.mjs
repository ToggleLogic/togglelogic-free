#!/usr/bin/env node
/*
 * ToggleLogic (Free Tier) — REAL local Gemma acceptance check (1.6.1-rc.3, Blocker 6).
 *
 * Evidence tool (not shipped; not in package `files`). Drives the ACTUAL before_agent_reply
 * coordinator/gate with:
 *   - the deterministic platform intent recipes shipped in the SAM-HQ example,
 *   - the real local Gemma classifier over an ambiguity-inducing catalog (a decoy
 *     "gog"/"gmail" alongside microsoft-graph/zoom-meetings), invoked against a live
 *     Ollama model (default gemma4:latest).
 *
 * It prints, for each prompt: the gate resolution + reason, and the REAL number of
 * Gemma classifier invocations. The point of the fix is that explicit-platform prompts
 * resolve deterministically BEFORE the classifier (0 model calls), so Gemma's known
 * misroute of "…in Outlook." can never decide the route. For contrast it also runs the
 * classifier ALONE on the same prompts to reproduce the misroute.
 *
 * Usage: node scripts/gemma-recipe-check.mjs [--model gemma4:latest] [--endpoint http://127.0.0.1:11434]
 * No live OpenClaw/gateway/config is touched; this only calls the local Ollama server.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createSkillRoutingCoordinator } from "../src/skill-routing/coordinator.js";
import { createCanaryScope } from "../src/skill-routing/scope.js";
import { createSkillResolver, createSkillClassifier } from "../src/skill-routing/resolver.js";
import { createSkillContracts } from "../src/skill-routing/skill-contracts.js";
import { createIntentRecipes } from "../src/skill-routing/intent-recipes.js";

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const MODEL = arg("--model", "gemma4:latest");
const ENDPOINT = arg("--endpoint", "http://127.0.0.1:11434");

// Platform recipes EXACTLY as shipped in docs/examples/sam-hq-owner-policy.openclaw.json.
const PLATFORM_RECIPES = [
  { id: "high-precision-meeting-prep", allTerms: ["meeting"], anyTerms: ["prepare", "prep", "brief", "briefing", "get ready", "ready for", "prep me"], skillIds: ["microsoft-graph", "zoom-meetings"] },
  { id: "outlook-mail", allTerms: ["outlook"], anyTerms: ["email", "emails", "mail", "inbox", "message", "messages"], skillIds: ["microsoft-graph"] },
  { id: "zoom-recording", allTerms: ["zoom"], anyTerms: ["transcript", "transcripts", "recording", "recordings", "recorded"], skillIds: ["zoom-meetings"] },
];

// Ambiguity-inducing catalog (decoys next to the platform skills) — mirrors the
// reported Gemma misroute where "…in Outlook." went ambiguous microsoft-graph/gog.
const CATALOG = [
  { id: "microsoft-graph", description: "Microsoft Graph: Outlook email, calendar, and contacts (authoritative Outlook calendar)" },
  { id: "zoom-meetings", description: "Zoom meeting recordings and transcripts" },
  { id: "gog", description: "Google org graph directory: people, groups, org chart lookups" },
  { id: "gmail", description: "Gmail: read and send Google email" },
  { id: "code-review", description: "Review a code diff for correctness" },
  { id: "web-research", description: "Search the web and summarize findings" },
];

const OWNER_CTX = {
  channel: "telegram", accountId: "codex", senderId: "7797183919",
  sessionKey: "agent:main:telegram:codex:7797183919", senderIsOwner: true,
  trigger: "user", inputProvenance: { kind: "external_user" },
};

function educationPlan(id) {
  return {
    schema_version: 1, status: "education_required",
    planned_skills: [{ id, version: "1.0.0", execution_class: "default" }],
    profile_matches: [{ skill_id: id, status: "missing" }],
    required_tier: "tool_calling_strong", required_surface: null, privacy: "cloud_allowed",
    estimated_tokens: 4000,
    choices: [{ kind: "lowest_cost", model_lineage: "l", resolved_child: "p/m", location: "cloud", estimated_cost_usd: 0.001 }],
    economic_policy: { monthly_cloud_budget_usd: 8.33, monthly_headroom_usd: 8.33 },
  };
}

async function ollamaInvoke({ system, prompt }) {
  const res = await fetch(`${ENDPOINT.replace(/\/$/, "")}/api/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, system, prompt, stream: false, format: "json", options: { temperature: 0, num_ctx: 8192 } }),
  });
  if (!res.ok) throw new Error(`ollama ${res.status}`);
  const data = await res.json();
  return data?.response ?? "";
}

const PROMPTS = [
  { label: "Outlook", text: "Find the latest email from Chris in Outlook.", expect: "microsoft-graph" },
  { label: "Zoom", text: "Summarize the Zoom recording transcript for the Q3 launch.", expect: "zoom-meetings" },
  { label: "Poem", text: "Write a limerick about pickles.", expect: "<no-skill fail-safe>" },
];

async function main() {
  // --- classifier ALONE (reproduce the misroute) ---
  console.log(`== Gemma classifier ALONE (${MODEL} @ ${ENDPOINT}) — explicit platform names ==`);
  const soloClassifier = createSkillClassifier({ enabled: true, model: MODEL, endpoint: ENDPOINT, confidenceThreshold: 0.6, numCtx: 8192, timeoutMs: 20000 }, { invoke: ollamaInvoke });
  const eligible = CATALOG.map((e) => ({ id: e.id, description: e.description }));
  for (const p of PROMPTS) {
    let d;
    try { d = await soloClassifier.classify(p.text, { eligible }); } catch (e) { d = { status: "error", error: String(e?.message ?? e) }; }
    console.log(`  ${p.label.padEnd(8)} -> status=${d.status}` +
      (d.skillId ? ` skill=${d.skillId} conf=${d.confidence}` : "") +
      (d.candidates ? ` candidates=[${d.candidates.join(", ")}] conf=${d.confidence}` : ""));
  }

  // --- through the GATE with deterministic recipes IN FRONT of Gemma ---
  console.log(`\n== Through the coordinator/gate WITH deterministic recipes (Gemma still wired) ==`);
  for (const p of PROMPTS) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tl-gemma-"));
    let classifierCalls = 0;
    const seam = {
      status: () => "available",
      planSkillRoute: async (req) => educationPlan(req.plannedSkills[0].id),
      recordSkillChoice: async () => {},
    };
    const runtime = { subagent: {
      run: async () => ({ runId: "r", sessionKey: "s", runtime: {} }),
      waitForRun: async () => ({ status: "ok" }),
      getSessionMessages: async () => ({ messages: [{ role: "assistant", content: [{ type: "text", text: "R" }] }] }),
    } };
    const scope = createCanaryScope({ enabled: true, channels: ["telegram"], accountIds: ["codex"], senderIds: ["7797183919"], ownerSenderIds: ["7797183919"] });
    const resolver = createSkillResolver({ catalog: CATALOG });
    const contracts = createSkillContracts({ ownerTimezone: "America/New_York", now: () => Date.parse("2026-09-15T15:00:00Z"), calendarPort: { findEvent: async () => null } });
    const intentRecipes = createIntentRecipes(PLATFORM_RECIPES);
    const classifier = createSkillClassifier(
      { enabled: true, model: MODEL, endpoint: ENDPOINT, confidenceThreshold: 0.6, numCtx: 8192, timeoutMs: 20000 },
      { invoke: async (req) => { classifierCalls += 1; return ollamaInvoke(req); } },
    );
    const coordinator = createSkillRoutingCoordinator({
      seam, config: { pendingStatePath: path.join(dir, "pending.json"), pendingTtlMinutes: 15, defaultEstimatedTokens: 4000, executionTimeoutSeconds: 60, monthlyCloudSpendUsd: 0, maxChildTokens: 200000, maxChildCostUsd: 5, clarifyOnMultiSkill: false },
      fallbackLogger: null, shadow: false, scope, resolver, contracts, runtime, intentRecipes, classifier,
    });
    const gate = await coordinator.handleGate({ prompt: p.text, cleanedBody: p.text }, OWNER_CTX);
    const planned = (gate?.audit?.planned_skills || []).map((s) => (typeof s === "string" ? s : s.id)).join("+") || "-";
    console.log(`  ${p.label.padEnd(8)} -> reason=${gate?.reason} resolved=${planned} gemmaClassifierCalls=${classifierCalls} (expect ${p.expect})`);
  }
}

main().catch((e) => { console.error("gemma-recipe-check FAILED:", e); process.exit(1); });
