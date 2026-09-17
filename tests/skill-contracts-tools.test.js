import test from "node:test";
import assert from "node:assert/strict";

import { createSkillContracts } from "../src/skill-routing/skill-contracts.js";

test("Graph plus Zoom receives a bounded composite budget instead of the smallest component ceiling", () => {
  const contracts = createSkillContracts({
    maxChildToolCalls: 32,
    skillTools: {
      "microsoft-graph": { allowedTools: ["graph_call"], maxToolCalls: 8 },
      "zoom-meetings": { allowedTools: ["zoom_call"], maxToolCalls: 10 },
    },
  });
  assert.deepEqual(contracts.toolPolicyFor([{ id: "microsoft-graph" }, { id: "zoom-meetings" }]), {
    disableTools: false,
    allowedTools: ["graph_call", "zoom_call"],
    maxToolCalls: 18,
  });
});

test("PowerPoint artifact work keeps its declared budget and composite work stays globally capped", () => {
  const contracts = createSkillContracts({
    maxChildToolCalls: 32,
    skillTools: {
      "microsoft-graph": { allowedTools: ["graph_call"], maxToolCalls: 12 },
      "powerpoint-editor": { allowedTools: ["read", "exec", "write"], maxToolCalls: 24 },
    },
  });
  assert.deepEqual(contracts.toolPolicyFor([{ id: "powerpoint-editor" }]), {
    disableTools: false,
    allowedTools: ["read", "exec", "write"],
    maxToolCalls: 24,
  });
  assert.deepEqual(contracts.toolPolicyFor([{ id: "microsoft-graph" }, { id: "powerpoint-editor" }]), {
    disableTools: false,
    allowedTools: ["graph_call", "read", "exec", "write"],
    maxToolCalls: 32,
  });
});

test("PowerPoint workflow upgrades the unsafe RC3 12-call policy to 24 while retaining the hard global cap", () => {
  const normal = createSkillContracts({
    maxChildToolCalls: 32,
    skillTools: { "powerpoint-editor": { maxToolCalls: 12 } },
  });
  assert.equal(normal.toolPolicyFor([{ id: "powerpoint-editor" }]).maxToolCalls, 24);

  const tighterDeployment = createSkillContracts({
    maxChildToolCalls: 20,
    skillTools: { "powerpoint-editor": { maxToolCalls: 12 } },
  });
  assert.equal(tighterDeployment.toolPolicyFor([{ id: "powerpoint-editor" }]).maxToolCalls, 20);

  const explicitlyZero = createSkillContracts({
    maxChildToolCalls: 32,
    skillTools: { "powerpoint-editor": { maxToolCalls: 0 } },
  });
  assert.equal(explicitlyZero.toolPolicyFor([{ id: "powerpoint-editor" }]).maxToolCalls, 0);
});

test("PowerPoint contract requires note order, measured timing, and completed verification", () => {
  const contracts = createSkillContracts({});
  const prompt = contracts.contractPrompt([{ id: "powerpoint-editor" }], "Edit this deck");
  assert.match(prompt, /3-MINUTE SCRIPT first, 6-MINUTE SCRIPT second, and ORIGINAL NOTES last/);
  assert.match(prompt, /Compute word counts from the FINAL text actually written/);
  assert.match(prompt, /Do not claim completion when any required verification tool call was denied/);
});

test("undeclared or duplicate component policies cannot multiply the global ceiling", () => {
  const contracts = createSkillContracts({
    maxChildToolCalls: 20,
    skillTools: { declared: { maxToolCalls: 7 } },
  });
  assert.equal(contracts.toolPolicyFor([{ id: "declared" }, { id: "undeclared" }]).maxToolCalls, 20);
  assert.equal(contracts.toolPolicyFor([{ id: "declared" }, { id: "declared" }]).maxToolCalls, 7);
});

test("all-disabled composite has an exact empty surface and zero tool budget", () => {
  const contracts = createSkillContracts({
    maxChildToolCalls: 32,
    skillTools: { a: { disableTools: true }, b: { disableTools: true } },
  });
  assert.deepEqual(contracts.toolPolicyFor([{ id: "a" }, { id: "b" }]), {
    disableTools: true,
    allowedTools: [],
    maxToolCalls: 0,
  });
});
