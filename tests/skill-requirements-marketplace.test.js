import test from "node:test";
import assert from "node:assert/strict";

import {
  CONSERVATIVE_DEFAULT,
  createSkillRequirements,
  normalizeSkillRequirements,
} from "../src/skill-routing/skill-requirements.js";

test("skill requirements normalize bounded 1.7 marketplace capability contracts", () => {
  const normalized = normalizeSkillRequirements({
    skills: {
      "powerpoint-editor": {
        requiredTier: "tool_calling_strong",
        capabilityContract: {
          contractId: "powerpoint-editor/v1",
          name: "PowerPoint editing",
          benchmarkDimensions: [
            { field: "document_fidelity", label: "document fidelity", weight: 3 },
            { field: "writing_quality", weight: 2, advantageText: "Strong editorial quality." },
          ],
        },
      },
    },
  });
  assert.deepEqual(normalized.skills["powerpoint-editor"].capabilityContract, {
    contractId: "powerpoint-editor/v1",
    name: "PowerPoint editing",
    benchmarkDimensions: [
      { field: "document_fidelity", label: "document fidelity", weight: 3 },
      { field: "writing_quality", weight: 2, advantageText: "Strong editorial quality." },
    ],
  });
});

test("invalid benchmark contracts fail closed without weakening capability requirements", () => {
  const normalized = normalizeSkillRequirements({
    default: { requiredTier: "terminal_capable", requiresTools: true },
    skills: {
      bad: { capabilityContract: { benchmarkDimensions: [{ field: "not a field" }] } },
    },
  });
  assert.equal(normalized.skills.bad.requiredTier, "terminal_capable");
  assert.equal(normalized.skills.bad.requiresTools, true);
  assert.equal(normalized.skills.bad.capabilityContract, null);
  assert.equal(CONSERVATIVE_DEFAULT.capabilityContract, null);
});

test("multi-skill aggregation produces one deterministic combined benchmark contract", () => {
  const requirements = createSkillRequirements({
    skills: {
      a: { capabilityContract: { name: "A", benchmarkDimensions: [{ field: "factual_accuracy", weight: 2 }] } },
      b: { capabilityContract: { name: "B", benchmarkDimensions: [{ field: "factual_accuracy", weight: 4 }, { field: "tool_use", weight: 3 }] } },
    },
  });
  const result = requirements.aggregate([{ id: "b" }, { id: "a" }]);
  assert.equal(result.capabilityContract.contractId, "combined/a+b");
  assert.deepEqual(result.capabilityContract.benchmarkDimensions, [
    { field: "factual_accuracy", weight: 4 },
    { field: "tool_use", weight: 3 },
  ]);
});

