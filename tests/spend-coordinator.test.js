import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createSkillRoutingCoordinator } from "../src/skill-routing/coordinator.js";
import { CLOUD_BUDGET_EXHAUSTED_SENTINEL } from "../src/usage/spend-provider.js";

function harness({ spendProvider = null, monthlyCloudSpendUsd = 0 } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tl-spend-coord-"));
  const captured = [];
  const audits = [];
  const seam = {
    planSkillRoute: async (request) => {
      captured.push(request);
      return {
        schema_version: 1,
        status: "education_required",
        planned_skills: request.plannedSkills,
        choices: [{ kind: "lowest_cost", model_lineage: "l", resolved_child: "p/m", location: "cloud", estimated_cost_usd: 0.01 }],
      };
    },
    recordSkillChoice: () => {},
  };
  const coordinator = createSkillRoutingCoordinator({
    seam,
    config: { pendingStatePath: path.join(directory, "pending.json"), pendingTtlMinutes: 15, defaultEstimatedTokens: 4000, monthlyCloudSpendUsd },
    fallbackLogger: null,
    spendProvider,
    auditSpend: (d) => audits.push(d),
  });
  return { coordinator, captured, audits };
}

const SKILLS = [{ id: "microsoft-graph" }];

test("gate path uses the LIVE snapshot spend automatically (no caller value)", async () => {
  const { coordinator, captured } = harness({
    spendProvider: { current: () => ({ status: "ok", effectiveSpendUsd: 23.1264, policyMonth: "2026-09", cloudSuppressed: false, reason: "live_snapshot", monthToDateCostUsd: 23.1264 }) },
  });
  await coordinator.plan({ prompt: "brief me", plannedSkills: SKILLS }, {});
  assert.equal(captured[0].monthlyCloudSpendUsd, 23.1264);
});

test("unavailable snapshot + finite budget feeds the exhaustion sentinel (cloud withheld)", async () => {
  const { coordinator, captured, audits } = harness({
    spendProvider: { current: () => ({ status: "unavailable", effectiveSpendUsd: CLOUD_BUDGET_EXHAUSTED_SENTINEL, cloudSuppressed: true, reason: "snapshot_unavailable_finite_budget", policyMonth: "2026-09", errors: ["missing"] }) },
  });
  await coordinator.plan({ prompt: "brief me", plannedSkills: SKILLS }, {});
  assert.equal(captured[0].monthlyCloudSpendUsd, CLOUD_BUDGET_EXHAUSTED_SENTINEL);
  assert.equal(audits.at(-1).cloud_suppressed, true);
  assert.equal(audits.at(-1).status, "unavailable");
});

test("unavailable snapshot + NO finite budget falls back to the static configured spend", async () => {
  const { coordinator, captured } = harness({
    monthlyCloudSpendUsd: 2.5,
    spendProvider: { current: () => ({ status: "unavailable", effectiveSpendUsd: null, cloudSuppressed: false, reason: "snapshot_unavailable_static_fallback", policyMonth: "2026-09", errors: ["missing"] }) },
  });
  await coordinator.plan({ prompt: "brief me", plannedSkills: SKILLS }, {});
  assert.equal(captured[0].monthlyCloudSpendUsd, 2.5);
});

test("live spend is AUTHORITATIVE: a caller value CANNOT override it (backwards precedence fixed)", async () => {
  const { coordinator, captured, audits } = harness({
    spendProvider: { current: () => ({ status: "ok", effectiveSpendUsd: 23.1264, policyMonth: "2026-09", cloudSuppressed: false, reason: "live_snapshot", monthToDateCostUsd: 23.1264 }) },
  });
  await coordinator.plan({ prompt: "brief me", plannedSkills: SKILLS, monthlyCloudSpendUsd: 0.42 }, {});
  assert.equal(captured[0].monthlyCloudSpendUsd, 23.1264, "the live snapshot wins over the caller value");
  assert.equal(audits.at(-1).caller_spend_ignored, true, "the ignored caller override is audited");
  assert.equal(audits.at(-1).caller_spend_attempted_usd, 0.42);
});

test("REGRESSION (WI4): a caller ZERO cannot reopen cloud after an EXHAUSTED live snapshot", async () => {
  const { coordinator, captured, audits } = harness({
    spendProvider: { current: () => ({ status: "unavailable", effectiveSpendUsd: CLOUD_BUDGET_EXHAUSTED_SENTINEL, cloudSuppressed: true, reason: "snapshot_unavailable_finite_budget", policyMonth: "2026-09", errors: ["missing"] }) },
  });
  // A hand-entered zero is exactly the attack ("we've spent nothing — reopen cloud").
  await coordinator.plan({ prompt: "brief me", plannedSkills: SKILLS, monthlyCloudSpendUsd: 0 }, {});
  assert.equal(captured[0].monthlyCloudSpendUsd, CLOUD_BUDGET_EXHAUSTED_SENTINEL, "the exhaustion sentinel stands; the caller zero is ignored");
  assert.equal(audits.at(-1).cloud_suppressed, true);
  assert.equal(audits.at(-1).caller_spend_ignored, true);
  assert.equal(audits.at(-1).caller_spend_attempted_usd, 0);
});

test("REGRESSION: a caller zero cannot override a VALID live snapshot either", async () => {
  const { coordinator, captured } = harness({
    spendProvider: { current: () => ({ status: "ok", effectiveSpendUsd: 23.1264, policyMonth: "2026-09", cloudSuppressed: false, reason: "live_snapshot", monthToDateCostUsd: 23.1264 }) },
  });
  await coordinator.plan({ prompt: "brief me", plannedSkills: SKILLS, monthlyCloudSpendUsd: 0 }, {});
  assert.equal(captured[0].monthlyCloudSpendUsd, 23.1264);
});

test("no spend provider (live spend DISABLED) preserves the legacy static-config behavior", async () => {
  const { coordinator, captured } = harness({ monthlyCloudSpendUsd: 1.23 });
  await coordinator.plan({ prompt: "brief me", plannedSkills: SKILLS }, {});
  assert.equal(captured[0].monthlyCloudSpendUsd, 1.23);
});

test("no spend provider (live spend DISABLED): the optional caller value is still honored (legacy surface)", async () => {
  const { coordinator, captured } = harness({ monthlyCloudSpendUsd: 1.23 });
  await coordinator.plan({ prompt: "brief me", plannedSkills: SKILLS, monthlyCloudSpendUsd: 0.42 }, {});
  assert.equal(captured[0].monthlyCloudSpendUsd, 0.42);
});
