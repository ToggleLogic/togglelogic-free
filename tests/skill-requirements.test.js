/*
 * ToggleLogic (Free Tier) — tests for deployment-owned per-skill CAPABILITY
 * REQUIREMENTS: fail-closed normalization, the conservative default, valid
 * opt-down, deterministic strictest-wins aggregation across a turn's resolved
 * skills, and the coordinator→seam threading. (gap A / items 1–3.)
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  normalizeSkillRequirements,
  createSkillRequirements,
  CONSERVATIVE_DEFAULT,
} from "../src/skill-routing/skill-requirements.js";
import { normalizeConfig } from "../src/config/normalize.js";
import { createSkillRoutingCoordinator } from "../src/skill-routing/coordinator.js";

test("requirements: absent config yields the conservative default (tool_calling_strong + requiresTools)", () => {
  const { default: def } = normalizeSkillRequirements(undefined);
  assert.equal(def.requiredTier, "tool_calling_strong");
  assert.equal(def.requiresTools, true);
  assert.equal(def.privacy, "cloud_allowed");
  assert.deepEqual(def, CONSERVATIVE_DEFAULT);
});

test("requirements: a resolved skill with no explicit entry inherits the conservative default", () => {
  const req = createSkillRequirements({
    skills: { "some-tool-free": { requiredTier: "general_purpose", requiresTools: false } },
  });
  // microsoft-graph has no entry → conservative default (never a loose general_purpose)
  assert.equal(req.requirementFor("microsoft-graph").requiredTier, "tool_calling_strong");
  assert.equal(req.requirementFor("microsoft-graph").requiresTools, true);
  // the explicitly opted-down skill keeps its relaxed floor
  assert.equal(req.requirementFor("some-tool-free").requiredTier, "general_purpose");
  assert.equal(req.requirementFor("some-tool-free").requiresTools, false);
});

test("requirements: invalid field values fail CLOSED to the (conservative) fallback, never widen", () => {
  const req = createSkillRequirements({
    default: { requiredTier: "banana", privacy: "public", requiresTools: "yes" },
    skills: { "x": { requiredTier: "not-a-tier", minimumBenchmarkScore: -5, maxCostUsdPerRun: -1 } },
  });
  // a malformed deployment default → hard conservative fallback
  assert.equal(req.config.default.requiredTier, "tool_calling_strong");
  assert.equal(req.config.default.privacy, "cloud_allowed");
  assert.equal(req.config.default.requiresTools, true);
  // malformed per-skill fields inherit the (conservative) default; bad numbers dropped
  const x = req.requirementFor("x");
  assert.equal(x.requiredTier, "tool_calling_strong");
  assert.equal(x.minimumBenchmarkScore, null);
  assert.equal(x.maxCostUsdPerRun, null);
});

test("requirements: a valid opt-down to general_purpose survives normalization", () => {
  const req = createSkillRequirements({
    default: { requiredTier: "general_purpose", requiresTools: false, privacy: "local_preferred" },
    skills: {},
  });
  assert.equal(req.config.default.requiredTier, "general_purpose");
  assert.equal(req.config.default.requiresTools, false);
  assert.equal(req.config.default.privacy, "local_preferred");
});

test("aggregate: strictest tier/privacy/benchmark, min cost caps, across mixed skills; deterministic", () => {
  const req = createSkillRequirements({
    skills: {
      "graph": { requiredTier: "tool_calling_strong", requiresTools: true, privacy: "cloud_allowed", minimumBenchmarkScore: 0.7, maxCostUsdPerRun: 0.5 },
      "local-notes": { requiredTier: "general_purpose", requiresTools: false, privacy: "local_only", minimumBenchmarkScore: 0.9, maxCostUsdPerRun: 0.2 },
    },
  });
  const a = req.aggregate([{ id: "graph" }, { id: "local-notes" }]);
  const b = req.aggregate([{ id: "local-notes" }, { id: "graph" }]); // order-independent
  assert.equal(a.requiredTier, "tool_calling_strong"); // strictest tier
  assert.equal(a.privacy, "local_only");               // strictest privacy
  assert.equal(a.requiresTools, true);                 // any skill needing tools
  assert.equal(a.minimumBenchmarkScore, 0.9);          // max (strictest floor)
  assert.equal(a.maxCostUsdPerRun, 0.2);               // min (strictest cap)
  assert.deepEqual(a, b);
});

test("aggregate: an unavailable/unresolved requirement id never widens the constraint", () => {
  const req = createSkillRequirements({
    // a loose entry for a skill that is NOT in the resolved set
    skills: { "not-installed": { requiredTier: "general_purpose", requiresTools: false } },
  });
  const agg = req.aggregate([{ id: "microsoft-graph" }]); // no entry → conservative default
  assert.equal(agg.requiredTier, "tool_calling_strong");
  assert.equal(agg.requiresTools, true);
});

test("aggregate: distinct required surfaces flag a conflict for fail-closed handling", () => {
  const req = createSkillRequirements({
    skills: {
      "a": { requiredSurface: "local_exec" },
      "b": { requiredSurface: "sandbox" },
    },
  });
  const agg = req.aggregate([{ id: "a" }, { id: "b" }]);
  assert.deepEqual(agg.requiredSurfaces, ["local_exec", "sandbox"]);
  assert.equal(agg.surfaceConflict, true);
});

test("normalizeConfig exposes skillRequirements with the conservative default", () => {
  const cfg = normalizeConfig({
    skillRouting: { skillRequirements: { skills: { "zoom-meetings": { requiredTier: "tool_calling_strong" } } } },
  });
  assert.equal(cfg.skillRouting.skillRequirements.default.requiredTier, "tool_calling_strong");
  assert.equal(cfg.skillRouting.skillRequirements.default.requiresTools, true);
  assert.equal(cfg.skillRouting.skillRequirements.skills["zoom-meetings"].requiredTier, "tool_calling_strong");
});

test("coordinator.plan aggregates and threads the requirement across the seam", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tl-free-req-"));
  let captured = null;
  const seam = {
    planSkillRoute: async (request) => {
      captured = request;
      return { status: "no_eligible_model", planned_skills: request.plannedSkills };
    },
  };
  const requirements = createSkillRequirements({
    skills: { "microsoft-graph": { requiredTier: "tool_calling_strong", requiresTools: true } },
  });
  const coordinator = createSkillRoutingCoordinator({
    seam,
    config: { pendingStatePath: path.join(directory, "pending.json"), pendingTtlMinutes: 15, defaultEstimatedTokens: 4000, monthlyCloudSpendUsd: 0 },
    fallbackLogger: null,
    requirements,
  });
  await coordinator.plan(
    { prompt: "send an Outlook email", plannedSkills: [{ id: "microsoft-graph" }], originalTask: "send an Outlook email" },
    {},
  );
  assert.ok(captured.skillRequirements, "skillRequirements is threaded into planSkillRoute");
  assert.equal(captured.skillRequirements.requiredTier, "tool_calling_strong");
  assert.equal(captured.skillRequirements.requiresTools, true);
});
