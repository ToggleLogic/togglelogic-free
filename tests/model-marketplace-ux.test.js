import test from "node:test";
import assert from "node:assert/strict";

import {
  formatSkillExecutionReceipt,
  formatSkillPlan,
  observedAssistantModelRef,
  skillPlanPresentationChoices,
} from "../src/skill-routing/coordinator.js";

test("1.7 presents distinct Economy, Recommended, and Premium evidence", () => {
  const plan = {
    status: "education_required",
    teaching_authorized: true,
    planned_skills: [{ id: "powerpoint-editor" }],
    intelligence_recommendation: {
      choice_id: "recommended", role: "recommended",
      reason: "Best balance of editorial reasoning, tool reliability, and workflow cost.",
    },
    choices: [
      {
        choice_id: "economy", role: "economy", strategy: "lowest_cost",
        model_lineage: "xai/grok", resolved_child: "xai/grok-4.3", location: "cloud",
        estimated_cost_range_usd: { low_usd: 0.04, high_usd: 0.09 },
        advantage: "Lowest modeled workflow cost.", tradeoff: "Lower editorial reasoning evidence.",
      },
      {
        choice_id: "recommended", role: "recommended", strategy: "intelligence",
        model_lineage: "google/gemini-flash", resolved_child: "google/gemini-3.5-flash", location: "cloud",
        estimated_cost_range_usd: { low_usd: 0.08, high_usd: 0.18 },
        advantage: "Balanced editorial and tool-use evidence.", tradeoff: "Costs more than Economy.",
        recommendation_reason: "Best balance of editorial reasoning, tool reliability, and workflow cost.",
      },
      {
        choice_id: "premium", role: "premium", strategy: "benchmark_best",
        model_lineage: "anthropic/claude-opus", resolved_child: "anthropic/claude-opus-4.7", location: "cloud",
        estimated_cost_range_usd: { low_usd: 0.30, high_usd: 0.70 },
        advantage: "Strongest weighted skill evidence.", tradeoff: "Highest workflow cost.",
      },
    ],
    economic_policy: { effective_monthly_budget_usd: 50, monthly_headroom_usd: 25 },
  };
  const text = formatSkillPlan(plan);
  assert.match(text, /1\. Economy/);
  assert.match(text, /2\. Recommended — ToggleLogic recommends this/);
  assert.match(text, /3\. Premium/);
  assert.match(text, /Advantage: Balanced editorial and tool-use evidence/);
  assert.match(text, /Trade-off: Costs more than Economy/);
  assert.match(text, /Why recommended: Best balance/);
  assert.match(text, /Reply 1, 2, or 3/);
});

test("three repeated policy rows for one lineage collapse to one honest option", () => {
  const plan = {
    status: "education_required", teaching_authorized: true,
    planned_skills: [{ id: "quickbooks-online" }],
    choices: ["lowest_cost", "benchmark_best", "intelligence"].map((strategy) => ({
      kind: strategy, strategy, model_lineage: "xai/grok", resolved_child: "xai/grok-4.3",
      location: "cloud", estimated_cost_usd: 0.004,
    })),
  };
  assert.equal(skillPlanPresentationChoices(plan).length, 1);
  const text = formatSkillPlan(plan);
  assert.equal((text.match(/xai\/grok-4\.3/g) || []).length, 1);
  assert.match(text, /Only one eligible model/);
  assert.doesNotMatch(text, /Reply 1, 2, or 3/);
});

test("overlapping marketplace roles are disclosed instead of hidden", () => {
  const plan = {
    status: "education_required", teaching_authorized: true,
    planned_skills: [{ id: "powerpoint-editor" }],
    intelligence_recommendation: { choice_id: "recommended", role: "recommended", reason: "Best balance." },
    choices: [
      {
        choice_id: "economy", role: "economy", roles: ["economy"], strategy: "lowest_cost",
        model_lineage: "xai/grok", resolved_child: "xai/grok-4.3", location: "cloud", estimated_cost_usd: 0.04,
      },
      {
        choice_id: "recommended", role: "recommended", roles: ["recommended", "premium"], strategy: "intelligence",
        model_lineage: "openai/gpt", resolved_child: "openai/gpt-5.5", location: "cloud", estimated_cost_usd: 0.30,
      },
    ],
  };
  const text = formatSkillPlan(plan);
  assert.match(text, /2\. Recommended · Premium — ToggleLogic recommends this/);
  assert.match(text, /Recommended and Premium resolve to the same model/);
  assert.match(text, /Reply 1 or 2/);
});

test("receipt separates planned, observed, and unobserved execution identity", () => {
  const messages = [{ role: "assistant", provider: "google", model: "gemini-3.5-flash", content: "done" }];
  assert.equal(observedAssistantModelRef(messages), "google/gemini-3.5-flash");
  const mismatch = formatSkillExecutionReceipt({
    model_lineage: "xai/grok", planned_model_ref: "xai/grok-4.3",
    observed_model_ref: "google/gemini-3.5-flash", estimated_cost_usd: 0.01,
  });
  assert.match(mismatch, /ToggleLogic plan: xai\/grok → xai\/grok-4\.3/);
  assert.match(mismatch, /Observed execution model: google\/gemini-3.5-flash/);
  assert.doesNotMatch(mismatch, /Routed by ToggleLogic to/);

  const unobserved = formatSkillExecutionReceipt({
    model_lineage: "xai/grok", planned_model_ref: "xai/grok-4.3", estimated_cost_usd: 0.01,
  });
  assert.match(unobserved, /host did not expose the execution model/);
  assert.doesNotMatch(unobserved, /Observed execution model/);
});
