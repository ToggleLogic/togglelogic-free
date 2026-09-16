/*
 * ToggleLogic (Free Tier) — deterministic intent-recipe engine tests.
 *
 * Recipes are declarative normalized-token rules the DEPLOYMENT declares to compose
 * a natural-language request to one-or-more INSTALLED skills, evaluated AFTER exact
 * resolution returns none and BEFORE the bounded classifier. A recipe resolves ONLY
 * when every target skill is in the fresh verified inventory; conflicting recipes
 * fail closed. These tests pin the resolve() contract and the fail-safe bounds.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { createIntentRecipes, normalizeIntentRecipes } from "../src/skill-routing/intent-recipes.js";

const MEETING_RECIPE = {
  id: "meeting-prep-compose",
  anyTerms: ["meeting", "calendar", "appointment", "agenda"],
  skillIds: ["microsoft-graph", "zoom-meetings"],
};
const INSTALLED = ["microsoft-graph", "zoom-meetings", "code-review"];

test("recipe: a multi-skill intent recipe resolves to ALL its installed skills", () => {
  const recipes = createIntentRecipes([MEETING_RECIPE]);
  const r = recipes.resolve("Prepare me for my 2 PM meeting today", { installedIds: INSTALLED });
  assert.equal(r.status, "resolved");
  assert.equal(r.ruleId, "meeting-prep-compose");
  assert.deepEqual(r.skills.sort(), ["microsoft-graph", "zoom-meetings"]);
});

test("recipe: allTerms require EVERY term; anyTerms require at least one", () => {
  const recipes = createIntentRecipes([
    { id: "brief", allTerms: ["prepare"], anyTerms: ["meeting", "call"], skillIds: ["microsoft-graph"] },
  ]);
  // allTerms present + one anyTerm present → match
  assert.equal(recipes.resolve("prepare for the meeting", { installedIds: INSTALLED }).status, "resolved");
  // allTerms missing ("prepare") → no match even though an anyTerm is present
  assert.equal(recipes.resolve("what is on the meeting agenda", { installedIds: INSTALLED }).status, "none");
  // allTerms present but no anyTerm present → no match
  assert.equal(recipes.resolve("prepare the quarterly numbers", { installedIds: INSTALLED }).status, "none");
});

test("recipe: FAILS SAFE when a required skill is absent from the verified inventory", () => {
  const recipes = createIntentRecipes([MEETING_RECIPE]);
  // zoom-meetings not installed → the recipe cannot resolve; it is inert, not partial.
  const r = recipes.resolve("prepare for my meeting", { installedIds: ["microsoft-graph", "code-review"] });
  assert.equal(r.status, "none");
  assert.equal(r.reason, "recipe_skills_absent");
  assert.deepEqual(r.unavailable, [{ ruleId: "meeting-prep-compose", missing: ["zoom-meetings"] }]);
});

test("recipe: CONFLICTING matching recipes (different skill sets) fail closed as ambiguous", () => {
  const recipes = createIntentRecipes([
    { id: "r-graph", anyTerms: ["report"], skillIds: ["microsoft-graph"] },
    { id: "r-review", anyTerms: ["report"], skillIds: ["code-review"] },
  ]);
  const r = recipes.resolve("generate the report", { installedIds: INSTALLED });
  assert.equal(r.status, "ambiguous");
  assert.equal(r.reason, "conflicting_recipes");
  assert.deepEqual(r.candidates.map((c) => c.ruleId).sort(), ["r-graph", "r-review"]);
});

test("recipe: multiple matching recipes that resolve to the SAME skill set are not a conflict", () => {
  const recipes = createIntentRecipes([
    { id: "r1", anyTerms: ["meeting"], skillIds: ["microsoft-graph", "zoom-meetings"] },
    { id: "r2", anyTerms: ["standup"], skillIds: ["zoom-meetings", "microsoft-graph"] }, // same set, different order
  ]);
  const r = recipes.resolve("prep my meeting standup", { installedIds: INSTALLED });
  assert.equal(r.status, "resolved");
  assert.deepEqual(r.skills.sort(), ["microsoft-graph", "zoom-meetings"]);
  assert.deepEqual(r.matchedRuleIds.sort(), ["r1", "r2"]);
});

test("recipe: no match → none; empty recipe set → none", () => {
  const recipes = createIntentRecipes([MEETING_RECIPE]);
  assert.equal(recipes.resolve("write me a poem about the sea", { installedIds: INSTALLED }).reason, "no_recipe_match");
  assert.equal(createIntentRecipes([]).resolve("anything", { installedIds: INSTALLED }).reason, "no_recipes");
});

test("normalize: drops rules with no discriminating term, no skill id, or duplicate id; bounds terms/skills", () => {
  const rules = normalizeIntentRecipes([
    { id: "ok", anyTerms: ["Meeting-Time!"], skillIds: ["microsoft-graph"] }, // normalized to "meeting time"
    { id: "no-terms", skillIds: ["microsoft-graph"] },                          // dropped: matches everything
    { id: "no-skill", anyTerms: ["x"], skillIds: [] },                          // dropped: never resolves
    { id: "bad-skill-id", anyTerms: ["y"], skillIds: ["../etc/passwd"] },       // dropped: invalid id filtered → no skills
    { id: "ok", anyTerms: ["dupe"], skillIds: ["code-review"] },                // dropped: duplicate id
  ]);
  assert.deepEqual(rules.map((r) => r.id), ["ok"]);
  assert.deepEqual(rules[0].anyTerms, ["meeting time"]);
  assert.deepEqual(rules[0].skillIds, ["microsoft-graph"]);
});

test("normalize: non-array / garbage input yields an empty rule set (never throws)", () => {
  assert.deepEqual(normalizeIntentRecipes(null), []);
  assert.deepEqual(normalizeIntentRecipes("nope"), []);
  assert.deepEqual(normalizeIntentRecipes([null, 42, "x"]), []);
  assert.equal(createIntentRecipes(undefined).size, 0);
});
