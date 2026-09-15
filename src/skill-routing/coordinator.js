import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { resolveOpenClawPath } from "../path-utils.js";

const MAX_STATE_BYTES = 1024 * 1024;
const MAX_PENDING_SESSIONS = 256;
const MAX_SKILLS_PER_PLAN = 32;

function cleanString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function sessionId(hookContext) {
  const raw = cleanString(hookContext?.sessionKey || hookContext?.sessionId);
  return raw ? crypto.createHash("sha256").update(raw).digest("hex") : null;
}

function senderId(hookContext) {
  const raw = cleanString(hookContext?.requesterSenderId || hookContext?.senderId);
  return raw ? crypto.createHash("sha256").update(raw).digest("hex") : null;
}

function normalizeSkills(value) {
  const input = Array.isArray(value) ? value : value ? [value] : [];
  return input.slice(0, MAX_SKILLS_PER_PLAN)
    .map((item) => typeof item === "string" ? { id: item } : item)
    .filter((item) => item && typeof item === "object" && /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,127}$/.test(cleanString(item.id || item.skill_id || item.name) || ""))
    .map((item) => ({
      id: cleanString(item.id || item.skill_id || item.name),
      ...(cleanString(item.version || item.skill_version) ? { version: cleanString(item.version || item.skill_version) } : {}),
      ...(cleanString(item.fingerprint || item.skill_fingerprint) ? { fingerprint: cleanString(item.fingerprint || item.skill_fingerprint) } : {}),
      execution_class: cleanString(item.execution_class) || "default",
    }));
}

export function structuredPlannedSkills(event = {}, hookContext = {}) {
  const arrays = [
    hookContext.plannedSkills,
    hookContext.skillsPlanned,
    event.plannedSkills,
    event.metadata?.plannedSkills,
    event.metadata?.skills,
  ];
  for (const value of arrays) {
    const skills = normalizeSkills(value);
    if (skills.length > 0) return skills;
  }
  const single = cleanString(
    hookContext.skillId || hookContext.skillName || hookContext.skill ||
    event.skillId || event.skillName || event.metadata?.skillId || event.metadata?.skillName,
  );
  return single ? [{ id: single, execution_class: "default" }] : [];
}

function parseChoice(text, expectedToken) {
  const match = String(text || "").trim().match(/^TL-([A-Fa-f0-9]{6})\s+([123])$/);
  if (!match || match[1].toLowerCase() !== String(expectedToken || "").toLowerCase()) return null;
  if (match[2] === "1") return "lowest_cost";
  if (match[2] === "2") return "benchmark_best";
  if (match[2] === "3") return "intelligence";
  return null;
}

function modelOverride(modelRef) {
  const slash = typeof modelRef === "string" ? modelRef.indexOf("/") : -1;
  if (slash <= 0 || slash >= modelRef.length - 1) return null;
  return { providerOverride: modelRef.slice(0, slash), modelOverride: modelRef.slice(slash + 1) };
}

function assistantText(messages) {
  for (let index = (messages || []).length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.role !== "assistant") continue;
    if (typeof message.content === "string" && message.content.trim()) return message.content.trim();
    if (Array.isArray(message.content)) {
      const text = message.content
        .filter((item) => item && item.type === "text" && typeof item.text === "string")
        .map((item) => item.text)
        .join("\n")
        .trim();
      if (text) return text;
    }
  }
  return null;
}

function money(value, location = "cloud") {
  if (!Number.isFinite(value)) return "unpriced";
  const basis = location === "local" ? "allocated local cost" : "external AI estimate";
  if (value === 0) return `$0.00 ${basis}`;
  if (value < 0.01) return `<$0.01 ${basis}`;
  return `$${value.toFixed(2)} ${basis}`;
}

export function formatSkillPlan(plan) {
  const skills = (plan?.planned_skills || []).map((item) => item.id).join(", ") || "none";
  const lines = [`ToggleLogic skill preflight — planned skills: ${skills}`];
  if (plan?.status === "selected") {
    lines.push(`Learned profile: ${plan.strategy}; ${plan.selected_lineage || "lineage unavailable"} → ${plan.selected_model_ref}.`);
    return lines.join("\n");
  }
  if (plan?.status !== "education_required") {
    lines.push(`Routing status: ${plan?.status || "unavailable"}. No automatic selection was applied.`);
    return lines.join("\n");
  }
  if (plan.teaching_authorized !== true) {
    lines.push("An authenticated owner must start this teaching choice; no routing profile was staged.");
    return lines.join("\n");
  }
  lines.push("This skill needs an owner-taught routing profile. Choose:");
  const labels = { lowest_cost: "Lowest expected cost", benchmark_best: "Benchmark-best within budget", intelligence: "Let ToggleLogic Intelligence decide" };
  (plan.choices || []).forEach((item, index) => {
    lines.push(`${index + 1}. ${labels[item.kind] || item.kind}: ${item.model_lineage || "unclassified lineage"} → ${item.resolved_child} (${item.location}, ${money(item.estimated_cost_usd, item.location)})`);
  });
  if (plan.choices_converged === true) {
    lines.push("All approved strategies currently resolve to the same execution child; the choice teaches the policy to use when the accepted pool changes.");
  }
  const budget = plan.economic_policy?.effective_monthly_budget_usd
    ?? plan.economic_policy?.monthly_cloud_budget_usd;
  const headroom = plan.economic_policy?.monthly_headroom_usd;
  lines.push(Number.isFinite(budget)
    ? `Monthly cloud budget: $${budget.toFixed(2)}; headroom: $${Number(headroom || 0).toFixed(2)}.`
    : "Monthly cloud budget: not configured; choices are estimates only.");
  lines.push(`Reply TL-${plan.choice_token} 1, TL-${plan.choice_token} 2, or TL-${plan.choice_token} 3. The one-time token binds your reply to this exact plan.`);
  lines.push("The choice is saved for this skill version and used deterministically until its profile is invalidated.");
  return lines.join("\n");
}

export function createSkillRoutingCoordinator({ seam, config, fallbackLogger, shadow = false }) {
  const statePath = resolveOpenClawPath(config.pendingStatePath);
  const ttlMs = config.pendingTtlMinutes * 60_000;
  let state = { schema_version: 1, pending: {} };

  try {
    const stat = fs.statSync(statePath);
    if (stat.size > MAX_STATE_BYTES) throw new Error(`state exceeds ${MAX_STATE_BYTES} bytes`);
    const parsed = JSON.parse(fs.readFileSync(statePath, "utf8"));
    if (parsed && parsed.schema_version === 1 && parsed.pending && typeof parsed.pending === "object") state = parsed;
  } catch (error) {
    if (error?.code !== "ENOENT") fallbackLogger?.warn?.(`togglelogic: ignored invalid skill-routing pending state: ${error.message}`);
  }

  function persist() {
    fs.mkdirSync(path.dirname(statePath), { recursive: true, mode: 0o700 });
    const temp = `${statePath}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(temp, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(temp, statePath);
  }

  function prune(now = Date.now()) {
    let changed = false;
    for (const [key, item] of Object.entries(state.pending)) {
      if (!item || !Number.isFinite(item.created_at_ms) || now - item.created_at_ms > ttlMs) {
        delete state.pending[key];
        changed = true;
      }
    }
    const keys = Object.keys(state.pending);
    for (const key of keys.slice(0, Math.max(0, keys.length - MAX_PENDING_SESSIONS))) {
      delete state.pending[key];
      changed = true;
    }
    if (changed) persist();
  }

  async function plan({ prompt, plannedSkills, estimatedTokens, monthlyCloudSpendUsd }, hookContext = {}) {
    const skills = normalizeSkills(plannedSkills);
    if (skills.length === 0) throw new Error("at least one planned skill is required");
    const result = await seam.planSkillRoute({
      prompt,
      plannedSkills: skills,
      estimatedTokens: estimatedTokens || config.defaultEstimatedTokens,
      monthlyCloudSpendUsd: Number.isFinite(monthlyCloudSpendUsd) ? monthlyCloudSpendUsd : config.monthlyCloudSpendUsd,
    });
    if (!result) throw new Error("ToggleLogic Intelligence skill planning is unavailable");
    const key = sessionId(hookContext);
    const teachingAuthorized = hookContext?.senderIsOwner === true && shadow !== true;
    const choiceToken = result.status === "education_required" && teachingAuthorized
      ? crypto.randomBytes(3).toString("hex") : null;
    const authorizedResult = {
      ...result,
      teaching_authorized: teachingAuthorized,
      shadow: shadow === true,
      ...(choiceToken ? { choice_token: choiceToken } : {}),
    };
    if (result.status === "education_required" && key && teachingAuthorized) {
      prune();
      state.pending[key] = {
        created_at_ms: Date.now(),
        owner_sender_hash: senderId(hookContext),
        plan: authorizedResult,
      };
      const keys = Object.keys(state.pending);
      if (keys.length > MAX_PENDING_SESSIONS) delete state.pending[keys[0]];
      persist();
    }
    return authorizedResult;
  }

  async function consumeChoice(prompt, hookContext = {}) {
    const key = sessionId(hookContext);
    if (!key || shadow === true) return null;
    prune();
    const pending = state.pending[key];
    if (!pending) return null;
    const kind = parseChoice(prompt, pending.plan.choice_token);
    if (!kind) return null;
    const replySender = senderId(hookContext);
    if (pending.owner_sender_hash && pending.owner_sender_hash !== replySender) return null;
    const selected = pending.plan.choices.find((item) => item.kind === kind);
    if (!selected) return null;
    const statuses = new Map((pending.plan.profile_matches || []).map((item) => [item.skill_id, item.status]));
    const invalidSkills = pending.plan.planned_skills.filter((skill) => statuses.get(skill.id) !== "current");
    const skillsToTeach = invalidSkills.length > 0 ? invalidSkills : pending.plan.planned_skills;
    for (const skill of skillsToTeach) {
      await seam.recordSkillChoice({
        skill,
        choice: selected,
        requiredTier: pending.plan.required_tier,
        requiredSurface: pending.plan.required_surface,
        privacy: pending.plan.privacy,
        expectedTokens: pending.plan.estimated_tokens,
      });
    }
    delete state.pending[key];
    persist();
    const override = modelOverride(selected.resolved_child);
    if (!override) throw new Error("selected skill model is not a valid provider/model ref");
    return {
      override,
      modelRef: selected.resolved_child,
      details: {
        matched_rule: "owner_taught_skill_profile",
        planned_skills: pending.plan.planned_skills,
        strategy: kind,
        model_lineage: selected.model_lineage,
        resolved_child: selected.resolved_child,
        estimated_cost_usd: selected.estimated_cost_usd,
      },
    };
  }

  return { plan, consumeChoice, structuredPlannedSkills, formatSkillPlan, isShadow: shadow === true };
}

export function createSkillRoutingTool(coordinator, defaultContext = {}) {
  return {
    name: "togglelogic_skill_plan",
    label: "ToggleLogic Skill Plan",
    description: "Declare the skills planned for a task and get the learned route or owner-facing benchmark and cost choices before invoking those skills.",
    promptSnippet: "Plan model routing for the skills you intend to use before invoking them.",
    promptGuidelines: [
      "Use togglelogic_skill_plan only to inspect or explain a route without executing the task; use togglelogic_skill_run for normal skill work.",
      "If the result asks for education, present its three choices verbatim and stop; do not perform the task until the owner replies.",
      "If a learned route is returned, name the planned skills and resolved route; this planning tool does not itself change the model already running.",
    ],
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["task_summary", "skills"],
      properties: {
        task_summary: { type: "string", minLength: 1, description: "Short description of the work the skills will perform." },
        skills: {
          type: "array",
          minItems: 1,
          maxItems: MAX_SKILLS_PER_PLAN,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["id"],
            properties: {
              id: { type: "string", minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9][A-Za-z0-9:._/-]*$" },
              version: { type: "string", maxLength: 128 },
              fingerprint: { type: "string", maxLength: 256 },
              execution_class: { type: "string", maxLength: 128 },
            },
          },
        },
        estimated_tokens: { type: "integer", minimum: 1 },
        monthly_cloud_spend_usd: { type: "number", minimum: 0 },
      },
    },
    async execute(_toolCallId, params, _signal, _onUpdate, context) {
      const plan = await coordinator.plan({
        prompt: params.task_summary,
        plannedSkills: params.skills,
        estimatedTokens: params.estimated_tokens,
        monthlyCloudSpendUsd: params.monthly_cloud_spend_usd,
      }, context || defaultContext);
      const rendered = formatSkillPlan(plan);
      return { content: [{ type: "text", text: rendered }], details: plan };
    },
  };
}

export function createSkillRoutingRunTool(coordinator, runtime, config, defaultContext = {}) {
  return {
    name: "togglelogic_skill_run",
    label: "ToggleLogic Skill Run",
    description: "Plan a skill-aware route and, when a learned profile exists, execute the task in a child run pinned to the currently accepted child of that skill's model lineage.",
    promptSnippet: "Route and execute planned skill work through its learned ToggleLogic profile.",
    promptGuidelines: [
      "Before performing work that invokes one or more skills, call togglelogic_skill_run with the exact skill names/versions and the complete bounded task.",
      "If education is required, present the returned choices verbatim and stop until the authenticated owner replies with the displayed one-time token.",
      "If execution succeeds, return the child result without repeating the task in the parent model.",
    ],
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["task_summary", "skills"],
      properties: {
        task_summary: { type: "string", minLength: 1, maxLength: 20000 },
        skills: {
          type: "array",
          minItems: 1,
          maxItems: MAX_SKILLS_PER_PLAN,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["id"],
            properties: {
              id: { type: "string", minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9][A-Za-z0-9:._/-]*$" },
              version: { type: "string", maxLength: 128 },
              fingerprint: { type: "string", maxLength: 256 },
              execution_class: { type: "string", maxLength: 128 },
            },
          },
        },
        estimated_tokens: { type: "integer", minimum: 1 },
        monthly_cloud_spend_usd: { type: "number", minimum: 0 },
      },
    },
    async execute(toolCallId, params, signal, _onUpdate, context) {
      const invocation = context || defaultContext;
      const plan = await coordinator.plan({
        prompt: params.task_summary,
        plannedSkills: params.skills,
        estimatedTokens: params.estimated_tokens,
        monthlyCloudSpendUsd: params.monthly_cloud_spend_usd,
      }, invocation);
      if (plan.status !== "selected" || !plan.selected_model_ref || coordinator.isShadow) {
        return { content: [{ type: "text", text: formatSkillPlan(plan) }], details: { ...plan, executed: false } };
      }
      const override = modelOverride(plan.selected_model_ref);
      if (!override || !runtime?.subagent?.run || !runtime?.subagent?.waitForRun || !runtime?.subagent?.getSessionMessages) {
        throw new Error("OpenClaw skill execution runtime is unavailable");
      }
      const parentSession = cleanString(invocation?.sessionKey);
      if (!parentSession) throw new Error("a host-authenticated session is required for skill execution");
      if (parentSession.includes(":togglelogic-skill:")) {
        throw new Error("nested ToggleLogic skill execution is not allowed");
      }
      signal?.throwIfAborted?.();
      const suffix = crypto.createHash("sha256").update(`${parentSession}\0${toolCallId}`).digest("hex").slice(0, 16);
      const childSessionKey = `${parentSession}:togglelogic-skill:${suffix}`;
      const skillList = plan.planned_skills.map((item) => item.id).join(", ");
      const run = await runtime.subagent.run({
        sessionKey: childSessionKey,
        message: `Execute this bounded task using these planned skills: ${skillList}.\n\nTask:\n${params.task_summary}`,
        extraSystemPrompt: "This is already a ToggleLogic-routed child execution. Do not call togglelogic_skill_plan or togglelogic_skill_run. Execute the bounded task directly and return only its result.",
        provider: override.providerOverride,
        model: override.modelOverride,
        deliver: false,
        idempotencyKey: `togglelogic-skill-${suffix}`,
      });
      const wait = await runtime.subagent.waitForRun({
        runId: run.runId,
        timeoutMs: config.executionTimeoutSeconds * 1000,
      });
      if (wait?.status !== "ok") {
        throw new Error(`skill execution ${wait?.status || "unknown"}${wait?.error ? `: ${wait.error}` : ""}`);
      }
      signal?.throwIfAborted?.();
      const transcript = await runtime.subagent.getSessionMessages({ sessionKey: run.sessionKey || childSessionKey, limit: 20 });
      const text = assistantText(transcript?.messages);
      if (!text) throw new Error(`skill execution ${wait?.status || "completed"} without an assistant result`);
      return {
        content: [{ type: "text", text }],
        details: {
          schema_version: 1,
          executed: true,
          planned_skills: plan.planned_skills,
          execution_requested_skills: plan.planned_skills,
          strategy: plan.strategy,
          model_lineage: plan.selected_lineage,
          resolved_child: plan.selected_model_ref,
          estimated_cost_usd: plan.choices.find((item) => item.kind === plan.strategy)?.estimated_cost_usd ?? null,
          child_run_id: run.runId,
          child_session_key_hash: crypto.createHash("sha256").update(run.sessionKey || childSessionKey).digest("hex"),
          execution_status: wait.status,
          runtime: run.runtime || null,
        },
      };
    },
  };
}
