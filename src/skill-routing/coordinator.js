import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { resolveOpenClawPath } from "../path-utils.js";
import { artifactDeliveryInstructions, deliverArtifactManifest } from "./artifact-delivery.js";
import { classifyToolFreeWork } from "./intent-categories.js";
import { redactSensitiveMeetingAccess } from "./output-redaction.js";

const MAX_STATE_BYTES = 1024 * 1024;
const MAX_PENDING_SESSIONS = 256;
const MAX_SKILLS_PER_PLAN = 32;

// The owner-directed fail-safe. On governed SAM, an actionable request that does
// not resolve to an active installed skill returns this VERBATIM — it is never
// silently passed to a general model. Named-unavailable skills return it too.
export const NO_SKILL_FAILSAFE =
  "I don't have a skill that relates to what you're asking me to do.";

function cleanString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function sessionId(hookContext) {
  const raw = cleanString(hookContext?.sessionKey || hookContext?.sessionId);
  return raw ? crypto.createHash("sha256").update(raw).digest("hex") : null;
}

function senderId(hookContext) {
  const raw = cleanString(hookContext?.requesterSenderId || hookContext?.senderId || hookContext?.channelContext?.sender?.id);
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

function skillChoiceLines(ids, resolver, skillIdentities = {}) {
  const catalog = resolver && typeof resolver.classifierCatalog === "function"
    ? resolver.classifierCatalog()
    : [];
  const descriptions = new Map(catalog.map((item) => [item.id, cleanString(item.description)]));
  return [...new Set((ids || []).map(cleanString).filter(Boolean))].map((id) => {
    const identity = skillIdentities && typeof skillIdentities === "object" ? skillIdentities[id] : null;
    const mailbox = cleanString(identity?.mailbox);
    const description = descriptions.get(id);
    const details = [mailbox, description].filter(Boolean).join(" — ")
      || "Purpose details are unavailable in the installed-skill catalog.";
    return `- ${id}: ${details}`;
  });
}

export function formatSkillClarification(ids, resolver, skillIdentities = {}, intro = "I found more than one applicable skill:") {
  const lines = skillChoiceLines(ids, resolver, skillIdentities);
  return [intro, ...lines, "Reply with the exact skill name shown above."].join("\n");
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

function parseChoiceNumber(text, expectedToken) {
  const normalized = String(text || "").trim();
  const tokenMatch = normalized.match(/^TL-([A-Fa-f0-9]{6})\s+([123])$/);
  return tokenMatch
    ? (tokenMatch[1].toLowerCase() === String(expectedToken || "").toLowerCase() ? tokenMatch[2] : null)
    : (normalized.match(/^([123])$/)?.[1] || null);
}

const PRESENTATION_ROLES = Object.freeze(["economy", "recommended", "premium"]);
const ROLE_LABELS = Object.freeze({
  economy: "Economy",
  recommended: "Recommended",
  premium: "Premium",
});

function choiceRole(choice) {
  const explicit = cleanString(choice?.role || choice?.presentation_role || choice?.marketplace_tier);
  if (explicit && PRESENTATION_ROLES.includes(explicit.toLowerCase())) return explicit.toLowerCase();
  // Backward compatibility with 1.6 Intelligence plans. These labels affect the
  // owner presentation only; the legacy strategy remains attached to the choice
  // and is what gets persisted.
  if (choice?.kind === "lowest_cost") return "economy";
  if (choice?.kind === "intelligence") return "recommended";
  if (choice?.kind === "benchmark_best") return "premium";
  return null;
}

function choiceRoleLabel(choice, fallbackRole) {
  const roles = Array.isArray(choice?.roles)
    ? [...new Set(choice.roles.map((item) => cleanString(item)?.toLowerCase()).filter((item) => PRESENTATION_ROLES.includes(item)))]
    : [];
  if (roles.length > 1) return roles.map((role) => ROLE_LABELS[role]).join(" · ");
  const role = roles[0] || fallbackRole;
  return ROLE_LABELS[role] || "Model";
}

function recommendationMatches(choice, recommendation) {
  if (!recommendation) return choice?.recommended === true;
  if (typeof recommendation === "string") {
    return [choice?.choice_id, choice?.id, choice?.role, choice?.presentation_role,
      choice?.marketplace_tier, choice?.model_lineage, choice?.resolved_child]
      .some((value) => cleanString(value)?.toLowerCase() === recommendation.toLowerCase());
  }
  if (typeof recommendation === "object") {
    return ["choice_id", "id", "role", "model_lineage", "resolved_child"]
      .some((key) => cleanString(recommendation[key]) && cleanString(recommendation[key]) === cleanString(choice?.[key]));
  }
  return choice?.recommended === true;
}

/**
 * Build the owner-visible marketplace from Intelligence output. A numbered
 * choice must always mean one durable route. Duplicate children/lineages are
 * therefore collapsed instead of displaying three labels that all execute the
 * same model (the 1.6 Grok/Grok/Grok defect).
 */
export function skillPlanPresentationChoices(plan) {
  const raw = Array.isArray(plan?.choices) ? plan.choices.filter((item) => item && typeof item === "object") : [];
  const recommendation = plan?.intelligence_recommendation ?? null;
  const unique = [];
  const seen = new Set();
  for (const choice of raw) {
    const lineage = cleanString(choice.model_lineage);
    const child = cleanString(choice.resolved_child);
    if (!child) continue;
    // A lineage is the durable target. Different numbered children of the same
    // lineage are not honest owner alternatives under the family architecture.
    const key = lineage ? `lineage:${lineage.toLowerCase()}` : `child:${child.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push({ ...choice, _role: choiceRole(choice), _recommended: recommendationMatches(choice, recommendation) });
  }
  if (unique.length === 1) {
    return [{ ...unique[0], presentation_role: "recommended", presentation_label: "Only eligible model", choice_number: 1 }];
  }

  const used = new Set();
  const result = [];
  // Preserve explicit marketplace roles. In particular, a two-option market is
  // Economy + Premium; it must not relabel Premium as Recommended merely to fill
  // a visual slot.
  for (const role of PRESENTATION_ROLES) {
    let index = unique.findIndex((choice, i) => !used.has(i) && choice._role === role);
    if (index < 0) continue;
    used.add(index);
    result.push({
      ...unique[index],
      presentation_role: role,
      presentation_label: choiceRoleLabel(unique[index], role),
      choice_number: result.length + 1,
    });
  }
  for (let index = 0; index < unique.length && result.length < 3; index += 1) {
    if (used.has(index)) continue;
    const availableRole = PRESENTATION_ROLES.find((role) => !result.some((item) => item.presentation_role === role));
    if (!availableRole) break;
    result.push({
      ...unique[index],
      presentation_role: availableRole,
      presentation_label: choiceRoleLabel(unique[index], availableRole),
      choice_number: result.length + 1,
    });
  }
  result.forEach((item, index) => { item.choice_number = index + 1; });
  return result;
}

// A message that LOOKS like a token reply (TL-xxxxxx N) — used to distinguish a
// wrong/replayed token from an ordinary turn so the gate can answer loudly
// instead of silently falling through to inline execution.
export function looksLikeChoiceReply(text) {
  return /^TL-[A-Fa-f0-9]{6}\s+[0-9]+$/.test(String(text || "").trim());
}

export function parseMonthlyBudgetUpdate(text) {
  const normalized = String(text || "").trim();
  const match = normalized.match(/^(?:sam\s*[-,:]\s*)?(?:please\s+)?(?:set|change|increase|raise|update)\s+(?:my\s+)?(?:the\s+)?(?:togglelogic\s+)?(?:(?:monthly|cloud)\s+){0,2}budget(?:\s+from\s+\$?[0-9]+(?:\.[0-9]{1,2})?)?\s+to\s+\$?([0-9]+(?:\.[0-9]{1,2})?)(?:\s*(?:per\s+month|monthly|a\s+month))?[.!]?$/i);
  if (!match) return null;
  const monthlyBudgetUsd = Number(match[1]);
  return Number.isFinite(monthlyBudgetUsd) && monthlyBudgetUsd >= 0 && monthlyBudgetUsd <= 1_000_000
    ? monthlyBudgetUsd : null;
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

/**
 * Read execution identity only from the assistant event the host returned for
 * the completed child. The requested override and run-start metadata are plans,
 * not proof, and are deliberately excluded.
 */
export function observedAssistantModelRef(messages) {
  for (let index = (messages || []).length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.role !== "assistant") continue;
    const provider = cleanString(message.provider || message.metadata?.provider || message.runtime?.provider);
    const model = cleanString(message.model || message.modelId || message.metadata?.model || message.metadata?.modelId || message.runtime?.model);
    if (!model) return null;
    if (model.includes("/")) return model;
    return provider ? `${provider}/${model}` : null;
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

function costRange(choice) {
  const raw = choice?.estimated_workflow_cost_usd ?? choice?.estimated_cost_range_usd ?? choice?.estimated_cost_range;
  const low = Number.isFinite(raw?.min) ? raw.min
    : Number.isFinite(raw?.low) ? raw.low
      : Number.isFinite(raw?.low_usd) ? raw.low_usd
      : Number.isFinite(choice?.estimated_cost_min_usd) ? choice.estimated_cost_min_usd : null;
  const high = Number.isFinite(raw?.max) ? raw.max
    : Number.isFinite(raw?.high) ? raw.high
      : Number.isFinite(raw?.high_usd) ? raw.high_usd
      : Number.isFinite(choice?.estimated_cost_max_usd) ? choice.estimated_cost_max_usd : null;
  if (Number.isFinite(low) && Number.isFinite(high)) {
    return `${money(low, choice.location)}–${money(high, choice.location)}`;
  }
  return money(choice?.estimated_cost_usd, choice?.location);
}

export function formatSkillPlan(plan) {
  const skills = (plan?.planned_skills || []).map((item) => item.id).join(", ") || "none";
  const lines = [`I’ll use these skills: ${skills}.`];
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
  const choices = Array.isArray(plan.presentation_choices)
    ? plan.presentation_choices : skillPlanPresentationChoices(plan);
  if (choices.length === 1) {
    lines.push("Only one eligible model is available for this skill right now:");
  } else if (choices.length === 0) {
    lines.push("No eligible model alternatives were returned. No routing choice was staged.");
    return lines.join("\n");
  } else {
    lines.push("Choose a model for this skill:");
  }
  choices.forEach((item, index) => {
    const overage = item.over_monthly_budget === true
      ? `; over monthly allowance by $${Number(item.monthly_overage_after_usd || 0).toFixed(2)} after this run`
      : "";
    const recommended = item._recommended === true || item.presentation_role === "recommended" && plan.intelligence_recommendation
      ? " — ToggleLogic recommends this" : "";
    lines.push(`${index + 1}. ${item.presentation_label || ROLE_LABELS[item.presentation_role] || "Model"}${recommended}`);
    lines.push(`   Model: ${item.model_lineage || "unclassified lineage"} → ${item.resolved_child}`);
    lines.push(`   Estimated workflow cost: ${costRange(item)}${overage}`);
    const advantage = cleanString(item.advantage || item.skill_advantage)
      || (Array.isArray(item.advantages) ? cleanString(item.advantages[0]) : null);
    const tradeoff = cleanString(item.tradeoff || item.skill_tradeoff)
      || (Array.isArray(item.tradeoffs) ? cleanString(item.tradeoffs[0]) : null);
    lines.push(`   Advantage: ${advantage || "Meets this skill’s declared capability requirements."}`);
    lines.push(`   Trade-off: ${tradeoff || "No skill-specific trade-off evidence was supplied."}`);
    lines.push(`   Why this option: ${cleanString(item.option_reason || item.role_reason) || `${item.presentation_label || "This"} is the route ToggleLogic Intelligence identified for this skill.`}`);
    if (item._recommended === true || (item.presentation_role === "recommended" && choices.length === 1)) {
      lines.push(`   Why recommended: ${cleanString(item.why_recommended || item.recommendation_reason || plan.intelligence_recommendation?.reason) || "It is the best supported eligible route for this skill under the current policy."}`);
    }
  });
  for (const item of choices.filter((choice) => Array.isArray(choice.roles) && choice.roles.length > 1)) {
    const roleNames = item.roles.map((role) => ROLE_LABELS[role] || role).join(" and ");
    lines.push(`${roleNames} resolve to the same model for this skill, so ToggleLogic combines those roles instead of listing the same model twice.`);
  }
  if ((plan.choices || []).length > choices.length && choices.length === 1) {
    lines.push("Other policy labels resolved to this same lineage, so they were collapsed instead of being presented as different choices.");
  }
  const budget = plan.economic_policy?.effective_monthly_budget_usd
    ?? plan.economic_policy?.monthly_cloud_budget_usd;
  const headroom = plan.economic_policy?.monthly_headroom_usd;
  lines.push(Number.isFinite(budget)
    ? `Monthly cloud budget: $${budget.toFixed(2)}; headroom: $${Number(headroom || 0).toFixed(2)}.`
    : "Monthly cloud budget: not configured; choices are estimates only.");
  if ((plan.choices || []).some((item) => item.over_monthly_budget === true)) {
    lines.push("Your cloud budget is used up. Replying with a number approves this one run, or say: Set my ToggleLogic budget to $25 per month.");
  }
  const numbers = choices.map((item) => String(item.choice_number));
  const replyList = numbers.length === 2 ? `${numbers[0]} or ${numbers[1]}`
    : numbers.length > 2 ? `${numbers.slice(0, -1).join(", ")}, or ${numbers.at(-1)}` : numbers[0];
  lines.push(choices.length === 1
    ? "Reply 1 to use and remember this model for these skill versions."
    : `Reply ${replyList}. I’ll remember the choice for these skill versions.`);
  return lines.join("\n");
}

export function formatSkillExecutionReceipt(details) {
  const lineage = details?.model_lineage || details?.selected_lineage || "lineage unavailable";
  const child = details?.planned_model_ref || details?.resolved_child || details?.selected_model_ref || "model unavailable";
  const cost = Number.isFinite(details?.estimated_cost_usd) ? money(details.estimated_cost_usd) : "estimate unavailable";
  const observed = cleanString(details?.observed_model_ref);
  const deniedToolCalls = Number.isFinite(details?.denied_tool_calls) ? details.denied_tool_calls : 0;
  if (deniedToolCalls > 0 || details?.execution_status === "tool_guard_denied") {
    return `— EXECUTION INCOMPLETE: ToggleLogic planned ${lineage} → ${child}, but the bounded-child guard denied ${deniedToolCalls || "one or more"} tool call(s). Verification was incomplete, so the result was not accepted as completed work.`;
  }
  const mismatch = observed && child !== "model unavailable" && observed.toLowerCase() !== child.toLowerCase();
  if (mismatch) {
    return `— EXECUTION MODEL MISMATCH: ToggleLogic planned ${lineage} → ${child}, but the host observed ${observed}. The result was not accepted as successfully routed execution.`;
  }
  const evidence = observed
    ? `Observed execution model: ${observed}.`
    : "The host did not expose the execution model, so the planned model is not claimed as the model actually used.";
  return `— ToggleLogic plan: ${lineage} → ${child} in a bounded child session (estimated ${cost}). ${evidence}`;
}

export function createSkillRoutingCoordinator({
  seam,
  config,
  fallbackLogger,
  shadow = false,
  scope = null,
  resolver = null,
  contracts = null,
  runtime = null,
  nonAction = null,
  intentRecipes = null,
  classifier = null,
  requirements = null,
  childToolGuard = null,
  auditUsage = null,
  spendProvider = null,
  auditSpend = null,
}) {
  const statePath = resolveOpenClawPath(config.pendingStatePath);
  const ttlMs = config.pendingTtlMinutes * 60_000;
  const maxChildTokens = Number.isFinite(config.maxChildTokens) ? config.maxChildTokens : 200000;
  const maxChildCostUsd = Number.isFinite(config.maxChildCostUsd) ? config.maxChildCostUsd : 5;
  const clarifyOnMultiSkill = config.clarifyOnMultiSkill === true;
  const skillIdentities = config.skillIdentities && typeof config.skillIdentities === "object"
    ? config.skillIdentities
    : {};
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

  /**
   * The SINGLE trusted owner decision for staging an education choice — the SAME
   * decision that admits a turn into canary scope (scope.isOwner). Prefer the
   * host's senderIsOwner bit when a hook supplies it; else fall back to the
   * configured owner-sender allowlist (ownerSenderIds, or the senderIds scope
   * dimension) matched against the trusted senderId.
   *
   * WHY THIS EXISTS (owner-auth propagation defect): before_agent_reply does NOT
   * carry senderIsOwner, so a configured trusted owner whom scope.evaluate() had
   * already admitted as an in-scope OWNER turn was still denied the teaching
   * choice here because plan() re-derived owner status from the raw bit alone
   * (teaching_authorized=false → "An authenticated owner must start this teaching
   * choice"). Delegating to scope.isOwner keeps the two owner decisions identical
   * and NEVER weakens scope: it only ADDS the explicit-allowlist path to the raw
   * bit (anything senderIsOwner===true authorized before still authorizes). Falls
   * back to the bare bit when no scope evaluator is wired (e.g. the optional
   * planning tools in a deployment without a canary scope, or unit fixtures).
   */
  function isTrustedOwner(hookContext = {}) {
    if (scope && typeof scope.isOwner === "function") return scope.isOwner(hookContext) === true;
    return hookContext?.senderIsOwner === true;
  }

  /**
   * Resolve the skills a turn is bound to from PRODUCTION-AVAILABLE inputs:
   * structured host metadata first (if a host ever supplies it), then the
   * deterministic prompt resolver. Never guesses.
   */
  function resolvePlannedSkills(event = {}, hookContext = {}) {
    const structured = structuredPlannedSkills(event, hookContext);
    if (structured.length > 0) {
      return { status: "resolved", skills: structured, source: "structured_host_metadata", resolution: null };
    }
    if (resolver) {
      const resolution = resolver.resolve(event?.prompt);
      if (resolution.status === "resolved") {
        return { status: "resolved", skills: normalizeSkills(resolution.skills), source: "deterministic_resolver", resolution };
      }
      return { status: resolution.status, skills: [], source: "deterministic_resolver", resolution };
    }
    return { status: "none", skills: [], source: "none", resolution: null };
  }

  // Recipes and the bounded classifier are intentionally allowed to return only
  // installed ids. Before those ids cross the routing/learning boundary, replace
  // them with the exact identity from the verified inventory catalog. Missing
  // version or fingerprint is an integrity failure, never a wildcard profile.
  function hydrateVerifiedSkillIds(ids) {
    if (!resolver || typeof resolver.identityFor !== "function") return null;
    const hydrated = [];
    for (const id of [...new Set(Array.isArray(ids) ? ids : [])].slice(0, MAX_SKILLS_PER_PLAN)) {
      const identity = resolver.identityFor(id);
      if (!identity || !cleanString(identity.version) || !cleanString(identity.fingerprint)) return null;
      hydrated.push(identity);
    }
    return hydrated.length > 0 ? normalizeSkills(hydrated) : null;
  }

  function skillIdentityUnavailable(source, ids) {
    const skillIds = [...new Set(Array.isArray(ids) ? ids : [])].slice(0, MAX_SKILLS_PER_PLAN);
    return {
      handled: true,
      reply: { text: `ToggleLogic matched the installed skill (${skillIds.join(", ") || "unknown"}), but its verified version and fingerprint are unavailable. I held this turn so no wildcard routing profile could be learned. Refresh the verified skill inventory and try again.` },
      reason: "skill_identity_unavailable",
      audit: { mode: "skill_identity_unavailable", source, skill_ids: skillIds },
    };
  }

  async function plan({ prompt, plannedSkills, estimatedTokens, monthlyCloudSpendUsd, originalTask }, hookContext = {}) {
    const skills = normalizeSkills(plannedSkills);
    if (skills.length === 0) throw new Error("at least one planned skill is required");
    // DEPLOYMENT-OWNED capability requirements, aggregated (strictest) across the
    // resolved skills. Passed to Intelligence.planSkills as routing CONSTRAINTS so
    // first-use education for a tool-using skill excludes general_purpose-only local
    // rows; combined there with the legacy task classifier and any learned profile.
    const aggregatedRequirements = requirements && typeof requirements.aggregate === "function"
      ? requirements.aggregate(skills)
      : null;
    const requestedEstimate = Math.max(
      Number.isFinite(estimatedTokens) ? estimatedTokens : config.defaultEstimatedTokens,
      Number.isFinite(aggregatedRequirements?.estimatedTokens) ? aggregatedRequirements.estimatedTokens : 0,
    );
    // Never advertise or stage a route that the bounded-child executor is
    // guaranteed to reject. This invariant belongs before owner education, not
    // after the owner has selected and persisted a model profile.
    if (requestedEstimate > maxChildTokens) {
      throw new Error(`skill task estimated at ${requestedEstimate} tokens exceeds the bounded-child ceiling (${maxChildTokens}); no unrunnable model choice was staged`);
    }
    // Make the execution hard cap a planner constraint as well. A stricter
    // per-skill cap still wins; the global ceiling can never be widened here.
    const skillRequirements = aggregatedRequirements ? {
      ...aggregatedRequirements,
      maxCostUsdPerRun: Number.isFinite(aggregatedRequirements.maxCostUsdPerRun)
        ? Math.min(aggregatedRequirements.maxCostUsdPerRun, maxChildCostUsd)
        : maxChildCostUsd,
    } : null;
    // Month-to-date cloud spend. AUTHORITATIVE PRECEDENCE (WI4, 1.6.1-rc.3): when a
    // live spend provider is wired (skillRouting.spend.enabled), the VALIDATED live
    // snapshot ALWAYS wins — no caller/event/tool parameter may override it (a
    // hand-entered zero must never reopen cloud after a valid or exhausted snapshot).
    // An attempted caller override while live spend is enabled is IGNORED and
    // AUDITED. A caller value is honored only when live spend is DISABLED (no
    // provider). Static config is used only when live spend is disabled with no
    // caller value, or via the documented no-finite-budget fallback (the provider
    // yields a null effective spend, meaning "unavailable, no finite budget"). When
    // the live snapshot is unavailable and a finite cloud budget applies, the
    // provider yields the budget-exhausted sentinel so Intelligence withholds cloud
    // routes while local-capable routes remain. This runs AFTER skill resolution, so
    // the universal no-skill fail-safe is never affected by spend.
    const liveSpendEnabled = Boolean(spendProvider && typeof spendProvider.current === "function");
    const callerSpendProvided = Number.isFinite(monthlyCloudSpendUsd);
    let spendResolution = null;
    let effectiveSpend;
    if (liveSpendEnabled) {
      spendResolution = spendProvider.current();
      effectiveSpend = spendResolution.status === "ok" || spendResolution.cloudSuppressed
        ? spendResolution.effectiveSpendUsd
        : config.monthlyCloudSpendUsd; // documented no-finite-budget fallback (provider effective is null)
      try {
        auditSpend?.({
          mode: "skill_spend_resolution",
          status: spendResolution.status,
          reason: spendResolution.reason,
          policy_month: spendResolution.policyMonth ?? null,
          effective_spend_usd: Number.isFinite(effectiveSpend) ? effectiveSpend : null,
          cloud_suppressed: spendResolution.cloudSuppressed === true,
          month_to_date_cost_usd: spendResolution.monthToDateCostUsd ?? null,
          age_hours: spendResolution.ageHours ?? null,
          stale: spendResolution.stale === true,
          delta: spendResolution.delta ?? null,
          errors: (spendResolution.errors || []).slice(0, 8),
          planned_skills: skills.map((s) => s.id),
          // Record any attempted caller/tool override that the live provider overrode.
          caller_spend_ignored: callerSpendProvided,
          caller_spend_attempted_usd: callerSpendProvided ? monthlyCloudSpendUsd : null,
        });
      } catch { /* audit is best-effort; never raise into planning */ }
    } else if (callerSpendProvided) {
      // Live spend disabled: the optional legacy caller value is honored.
      effectiveSpend = monthlyCloudSpendUsd;
    } else {
      effectiveSpend = config.monthlyCloudSpendUsd;
    }
    const result = await seam.planSkillRoute({
      prompt,
      plannedSkills: skills,
      estimatedTokens: requestedEstimate,
      monthlyCloudSpendUsd: Number.isFinite(effectiveSpend) ? effectiveSpend : config.monthlyCloudSpendUsd,
      ...(skillRequirements ? { skillRequirements } : {}),
    });
    if (!result) throw new Error("ToggleLogic Intelligence skill planning is unavailable");
    const unsafeChoice = (result.choices || []).find((choice) => Number.isFinite(choice?.estimated_cost_usd)
      && choice.estimated_cost_usd > maxChildCostUsd);
    if (unsafeChoice) {
      throw new Error(`routing plan returned a $${unsafeChoice.estimated_cost_usd.toFixed(2)} choice above the bounded-child cost ceiling ($${maxChildCostUsd.toFixed(2)}); no unrunnable model choice was staged`);
    }
    const key = sessionId(hookContext);
    // ONE trusted owner decision (scope.isOwner), NOT the raw senderIsOwner bit —
    // before_agent_reply omits that bit, so a configured trusted owner would
    // otherwise be denied the teaching choice on the exact path scope already
    // admitted as an owner turn. See isTrustedOwner above.
    const teachingAuthorized = isTrustedOwner(hookContext) && shadow !== true;
    const choiceToken = result.status === "education_required" && teachingAuthorized
      ? crypto.randomBytes(3).toString("hex") : null;
    const authorizedResult = {
      ...result,
      teaching_authorized: teachingAuthorized,
      shadow: shadow === true,
      ...(choiceToken ? { choice_token: choiceToken } : {}),
    };
    if (result.status === "education_required") {
      // Persist exactly the routes the owner saw. This prevents a later numeric
      // reply from being reinterpreted against a reordered registry result and
      // makes the sender/session-bound pending record the decision authority.
      authorizedResult.presentation_choices = skillPlanPresentationChoices(result);
    }
    if (result.status === "education_required" && key && teachingAuthorized) {
      prune();
      state.pending[key] = {
        created_at_ms: Date.now(),
        owner_sender_hash: senderId(hookContext),
        // The bounded task the owner is choosing a route FOR — executed in the
        // child once the choice arrives, so the routed model is assigned to the
        // resolved skill work, never to the bare "TL-<token> N" reply text.
        original_task: cleanString(originalTask ?? prompt),
        resolved_skills: skills,
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
    const choiceNumber = parseChoiceNumber(prompt, pending.plan.choice_token);
    if (!choiceNumber) return null;
    const replySender = senderId(hookContext);
    if (pending.owner_sender_hash && pending.owner_sender_hash !== replySender) return null;
    const presented = Array.isArray(pending.plan.presentation_choices)
      ? pending.plan.presentation_choices : skillPlanPresentationChoices(pending.plan);
    const selected = presented[Number(choiceNumber) - 1] || null;
    if (!selected) return null;
    // 1.7 Intelligence supplies a stable persistence strategy separately from
    // the marketplace label. Legacy 1.6 choices use kind directly.
    const strategy = cleanString(selected.strategy || selected.kind || selected.presentation_role);
    if (!strategy) throw new Error("selected skill route has no persistence strategy");
    const {
      _role: _presentationRole,
      _recommended: _presentationRecommended,
      presentation_label: _presentationLabel,
      choice_number: _choiceNumber,
      ...choiceForPersistence
    } = selected;
    const statuses = new Map((pending.plan.profile_matches || []).map((item) => [item.skill_id, item.status]));
    // Persist against the coordinator's verified resolution snapshot, not a
    // planner echo that could omit version/fingerprint. This is the authority
    // the owner actually approved and makes fingerprint drift invalidate the
    // learned profile on the next plan.
    const authoritativeSkills = normalizeSkills(pending.resolved_skills || pending.plan.planned_skills);
    const invalidSkills = authoritativeSkills.filter((skill) => statuses.get(skill.id) !== "current");
    const skillsToTeach = invalidSkills.length > 0 ? invalidSkills : authoritativeSkills;
    for (const skill of skillsToTeach) {
      await seam.recordSkillChoice({
        skill,
        choice: choiceForPersistence,
        strategy,
        requiredTier: pending.plan.required_tier,
        requiredSurface: pending.plan.required_surface,
        privacy: pending.plan.privacy,
        expectedTokens: pending.plan.estimated_tokens,
      });
    }
    const originalTask = pending.original_task || null;
    const skills = pending.resolved_skills || pending.plan.planned_skills;
    const planSnapshot = pending.plan;
    delete state.pending[key];
    persist();
    const override = modelOverride(selected.resolved_child);
    if (!override) throw new Error("selected skill model is not a valid provider/model ref");
    return {
      override,
      modelRef: selected.resolved_child,
      originalTask,
      skills,
      plan: planSnapshot,
      choice: selected,
      strategy,
      details: {
        matched_rule: "owner_taught_skill_profile",
        planned_skills: pending.plan.planned_skills,
        strategy,
        model_lineage: selected.model_lineage,
        resolved_child: selected.resolved_child,
        estimated_cost_usd: selected.estimated_cost_usd,
      },
    };
  }

  /**
   * Execute bounded skill work in a FRESH child session pinned to the resolved
   * child, under the skill's execution contract and a token/cost ceiling. This
   * is the single execution path shared by the run tool and the reply gate; it
   * is what stops routed skill work from re-running inline against the fat main
   * session (the 452K-token incident amplification).
   */
  async function executeBoundedChild({ callRef, invocation, task, skills, override, modelRef, estimatedTokens, estimatedCostUsd, details, signal, runtime: runtimeOverride }) {
    const rt = runtimeOverride || runtime;
    if (!override || !rt?.subagent?.run || !rt?.subagent?.waitForRun || !rt?.subagent?.getSessionMessages) {
      throw new Error("OpenClaw skill execution runtime is unavailable");
    }
    const parentSession = cleanString(invocation?.sessionKey);
    if (!parentSession) throw new Error("a host-authenticated session is required for skill execution");
    if (parentSession.includes(":togglelogic-skill:")) {
      throw new Error("nested ToggleLogic skill execution is not allowed");
    }
    // Bounded-child PRE-FLIGHT rejection — this is an ESTIMATE gate, not a
    // runtime ceiling. OpenClaw 2026.9.4 SubagentRunParams exposes no
    // model-pass/tool-call/token/cost enforcement field (only disableTools /
    // toolsAlsoAllow), so the plugin cannot cap the child's live token spend from
    // here. What it CAN guarantee: a FRESH session (no fat-main history) plus
    // promptMode:"minimal" + lightContext:true (below), and refusing to even
    // start a task whose own estimate already blows the budget.
    const estTokens = Number.isFinite(estimatedTokens) ? estimatedTokens : config.defaultEstimatedTokens;
    if (estTokens > maxChildTokens) {
      throw new Error(`skill task estimated at ${estTokens} tokens exceeds the bounded-child ceiling (${maxChildTokens}); refusing to route to prevent fat-session amplification`);
    }
    if (Number.isFinite(estimatedCostUsd) && Number.isFinite(maxChildCostUsd) && estimatedCostUsd > maxChildCostUsd) {
      throw new Error(`skill task estimated at $${estimatedCostUsd.toFixed(2)} exceeds the bounded-child cost ceiling ($${maxChildCostUsd.toFixed(2)}); refusing to route`);
    }
    signal?.throwIfAborted?.();
    const suffix = crypto.createHash("sha256").update(`${parentSession}\0${callRef}`).digest("hex").slice(0, 16);
    const childSessionKey = `${parentSession}:togglelogic-skill:${suffix}`;
    const childSessionHash = crypto.createHash("sha256").update(childSessionKey).digest("hex");
    const skillList = skills.map((item) => item.id).join(", ");
    const artifactWorkflow = skills.some((item) => item.id === "powerpoint-editor");
    const artifactStagingDir = artifactWorkflow
      ? path.join(resolveOpenClawPath(config.artifactStagingRoot || "~/.openclaw/workspace/.togglelogic-artifacts"), suffix)
      : null;
    if (artifactStagingDir) fs.mkdirSync(artifactStagingDir, { recursive: true, mode: 0o700 });
    const contractPrompt = contracts ? contracts.contractPrompt(skills, task) : null;
    // Credential-free per-skill execution identity (mailbox/sender/label) actually
    // applied to this route — for the audit/receipt. Keyed only to the resolved
    // skills, so it can never carry another skill's mailbox identity.
    const executionIdentity = contracts && typeof contracts.identityAudit === "function"
      ? contracts.identityAudit(skills) : [];
    const extraSystemPrompt = [
      "This is already a ToggleLogic-routed child execution. Do not call togglelogic_skill_plan or togglelogic_skill_run. Execute the bounded task directly and return only its result.",
      ...(contractPrompt ? [contractPrompt] : []),
      ...(artifactStagingDir ? [artifactDeliveryInstructions(artifactStagingDir)] : []),
    ].join("\n\n");

    // Per-skill bounded tool surface. disableTools:true → an exact empty tool
    // surface (a supported SubagentRunParams field). A non-null allowlist and the
    // per-run tool-call COUNT ceiling are enforced live on the child by the
    // before_tool_call guard (see child-tool-guard.js); the host exposes no
    // model-token/pass cap, so those are the real runtime bounds available.
    const toolPolicy = contracts && typeof contracts.toolPolicyFor === "function"
      ? contracts.toolPolicyFor(skills)
      : { disableTools: false, allowedTools: null, maxToolCalls: null };
    childToolGuard?.register?.(childSessionKey, {
      skills,
      allowedTools: toolPolicy.allowedTools,
      maxToolCalls: toolPolicy.maxToolCalls,
      plannedModelRef: modelRef,
    });

    let wait;
    let run;
    let text;
    let observedModelRef = null;
    let usage = null;
    let modelMismatch = false;
    let toolGuardDenied = false;
    let artifactDelivery = null;
    let sensitiveOutputRedactions = 0;
    try {
      run = await rt.subagent.run({
        sessionKey: childSessionKey,
        message: `Execute this bounded task using these planned skills: ${skillList}.\n\nTask:\n${task}`,
        extraSystemPrompt,
        provider: override.providerOverride,
        model: override.modelOverride,
        deliver: false,
        idempotencyKey: `togglelogic-skill-${suffix}`,
        // Supported bounded-context controls (openclaw 2026.9.4 SubagentRunParams):
        // promptMode:"minimal" uses the bounded subagent prompt instead of the full
        // conversation prompt, lightContext trims injected runtime context, and
        // disableTools (when the per-skill policy declares no tools) gives an exact
        // empty tool surface — together with the fresh session, the real defense
        // against the 452K-token fat-main-session amplification. (contextTokenBudget
        // is NOT a supported field and was removed; it silently did nothing.)
        promptMode: "minimal",
        lightContext: true,
        ...(toolPolicy.disableTools ? { disableTools: true } : {}),
      });
      wait = await rt.subagent.waitForRun({
        runId: run.runId,
        timeoutMs: config.executionTimeoutSeconds * 1000,
      });
      if (wait?.status !== "ok") {
        throw new Error(`skill execution ${wait?.status || "unknown"}${wait?.error ? `: ${wait.error}` : ""}`);
      }
      signal?.throwIfAborted?.();
      const transcript = await rt.subagent.getSessionMessages({ sessionKey: run.sessionKey || childSessionKey, limit: 20 });
      text = assistantText(transcript?.messages);
      observedModelRef = observedAssistantModelRef(transcript?.messages);
      if (!text) throw new Error(`skill execution ${wait?.status || "completed"} without an assistant result`);
      if (observedModelRef && observedModelRef.toLowerCase() !== modelRef.toLowerCase()) {
        modelMismatch = true;
        throw new Error(`skill execution model mismatch: planned ${modelRef}, observed ${observedModelRef}; result rejected`);
      }
      if (artifactStagingDir) {
        artifactDelivery = deliverArtifactManifest({ text, ownerPrompt: task, stagingDir: artifactStagingDir, allowBesidePromptedPptx: true });
        text = artifactDelivery.cleanText;
        const deliveredPaths = artifactDelivery.entries.filter((item) => item.status === "delivered").map((item) => item.destination);
        const failed = artifactDelivery.entries.filter((item) => item.status !== "delivered");
        if (artifactDelivery.status === "complete") {
          text = `${text}\n\nArtifact delivery verified by ToggleLogic (${artifactDelivery.delivered}/${artifactDelivery.total}):\n${deliveredPaths.map((item) => `- ${item}`).join("\n")}`.trim();
        } else {
          const failures = failed.length > 0
            ? failed.map((item) => `- ${item.destination || "unknown destination"}: ${item.error || "verification failed"}`).join("\n")
            : `- ${artifactDelivery.error || "delivery manifest verification failed"}`;
          text = `ARTIFACT DELIVERY INCOMPLETE. The child result below is staging-only and is not a final-delivery or completion claim.\n${failures}\n\n${text}`.trim();
        }
      }
      const redacted = redactSensitiveMeetingAccess(text);
      text = redacted.text;
      sensitiveOutputRedactions = redacted.redactions;
    } finally {
      // POST-RUN ACTUAL USAGE AUDIT. The run/wait metadata is not execution proof.
      // A provider/model pair on the returned assistant event IS recorded as
      // observed; otherwise it remains null and the receipt explicitly says the
      // host did not expose it. Token/cost remain estimates because the host does
      // not expose child usage through SubagentRunResult/AgentWaitResult. Tool
      // counts and wall time are still actual observations. This fires whether
      // the run succeeded or failed.
      usage = childToolGuard?.release?.(childSessionKey) || null;
      toolGuardDenied = Number(usage?.deniedToolCalls || 0) > 0;
      const wallClockMs = Number.isFinite(wait?.startedAt) && Number.isFinite(wait?.endedAt)
        ? wait.endedAt - wait.startedAt : null;
      try {
        auditUsage?.({
          mode: "skill_child_usage_audit",
          child_session_key_hash: childSessionHash,
          child_run_id: run?.runId ?? null,
          planned_skills: skills.map((s) => s.id),
          planned_model_lineage: details?.model_lineage ?? null,
          planned_model_ref: modelRef,
          // Backward-compatible planned child field. Never interpret this as
          // observed runtime evidence; use observed_model_ref below.
          resolved_child: modelRef,
          observed_model_ref: observedModelRef,
          execution_status: modelMismatch ? "model_mismatch" : toolGuardDenied ? "tool_guard_denied" : (wait?.status ?? "unknown"),
          model_match_verified: observedModelRef ? !modelMismatch : null,
          completion_verified: !modelMismatch && !toolGuardDenied && wait?.status === "ok" && (!artifactWorkflow || artifactDelivery?.status === "complete"),
          stop_reason: wait?.stopReason ?? null,
          provider_started: wait?.providerStarted ?? null,
          wall_clock_ms: wallClockMs,
          estimated_tokens: Number.isFinite(estimatedTokens) ? estimatedTokens : null,
          estimated_cost_usd: Number.isFinite(estimatedCostUsd) ? estimatedCostUsd : null,
          actual_tool_calls: usage?.toolCalls ?? null,
          denied_tool_calls: usage?.deniedToolCalls ?? null,
          guard_internal_errors: usage?.internalGuardErrors ?? null,
          denied_tools: usage?.deniedTools ?? [],
          tool_call_ceiling: usage?.ceiling ?? null,
          disable_tools: toolPolicy.disableTools === true,
          allowed_tools: toolPolicy.allowedTools ?? null,
          // Per-skill execution identity applied to this child (credential-free).
          execution_identity: executionIdentity,
          // The residual gap (documented): the host exposes no model token/pass cap
          // or in-flight abort, so actual model spend is not observable here.
          model_usage_host_observable: observedModelRef !== null,
          runtime_token_ceiling_enforced: false,
          artifact_delivery_status: artifactDelivery?.status ?? null,
          artifact_delivery: artifactDelivery?.entries ?? [],
          sensitive_output_redactions: sensitiveOutputRedactions,
        });
      } catch { /* audit is best-effort; never raise into the caller */ }
    }
    if (toolGuardDenied) {
      throw new Error(`skill execution incomplete: bounded-child guard denied ${usage.deniedToolCalls} tool call(s); result rejected because verification may not have completed`);
    }
    return {
      text,
      details: {
        schema_version: 1,
        executed: true,
        planned_skills: skills,
        model_lineage: details?.model_lineage ?? null,
        planned_model_ref: modelRef,
        resolved_child: modelRef,
        observed_model_ref: observedModelRef,
        model_usage_host_observable: observedModelRef !== null,
        estimated_cost_usd: Number.isFinite(estimatedCostUsd) ? estimatedCostUsd : null,
        child_run_id: run.runId,
        child_session_key_hash: childSessionHash,
        execution_status: modelMismatch ? "model_mismatch" : toolGuardDenied ? "tool_guard_denied" : wait.status,
        model_match_verified: observedModelRef ? !modelMismatch : null,
        completion_verified: !modelMismatch && !toolGuardDenied && wait.status === "ok" && (!artifactWorkflow || artifactDelivery?.status === "complete"),
        runtime: run.runtime || null,
        prompt_mode: "minimal",
        light_context: true,
        // Per-skill bounded tool surface actually applied to this child.
        disable_tools: toolPolicy.disableTools === true,
        allowed_tools: toolPolicy.allowedTools ?? null,
        // Per-skill authoritative mailbox/sender identity injected into the child
        // (credential-free) — the deployment-owned identity contract's receipt.
        execution_identity: executionIdentity,
        tool_call_ceiling: (childToolGuard && Number.isFinite(toolPolicy.maxToolCalls))
          ? toolPolicy.maxToolCalls : (childToolGuard ? childToolGuard.defaultMax : null),
        guard_internal_errors: usage?.internalGuardErrors ?? null,
        denied_tool_calls: usage?.deniedToolCalls ?? null,
        artifact_delivery_status: artifactDelivery?.status ?? null,
        artifact_delivery: artifactDelivery?.entries ?? [],
        sensitive_output_redactions: sensitiveOutputRedactions,
        // These are PRE-FLIGHT estimate ceilings, not live runtime enforcement.
        preflight_ceiling_tokens: maxChildTokens,
        preflight_ceiling_cost_usd: maxChildCostUsd,
        runtime_token_ceiling_enforced: false,
      },
    };
  }

  /**
   * Evaluate whether a turn is an ACTIVE governed turn (in canary scope and not
   * shadow). Total/never-throws — used by the gate and by the interceptor's
   * defense-in-depth catch so an unexpected error on a governed turn can still
   * fail closed instead of falling through to inline execution.
   */
  function evaluateScope(hookContext = {}) {
    const scopeDecision = scope ? scope.evaluate(hookContext) : { inScope: false, reason: "no_scope" };
    return { scopeDecision, active: scopeDecision.inScope && shadow !== true };
  }

  function routeBindingFor(childSessionKey) {
    return childToolGuard && typeof childToolGuard.routeBindingFor === "function"
      ? childToolGuard.routeBindingFor(childSessionKey) : null;
  }

  /**
   * THE GUARANTEED PRE-EXECUTION GATE. Called from before_agent_reply. Returns
   * null to fall through to normal routing, or a handled reply that
   * short-circuits the turn BEFORE any model/tool work.
   *
   * FAIL-CLOSED (owner-directed): on an ACTIVE governed turn EVERY actionable
   * request must resolve to an active installed skill or return the no-skill
   * fail-safe; internal errors on a governed turn or a token reply return a
   * handled error, NEVER a silent fall-through to inline model execution (the
   * 2026-09-15 incident path). Out-of-scope / shadow turns stay passthrough and
   * are never falsely represented as governed.
   */
  async function handleGate(event = {}, hookContext = {}) {
    const text = cleanString(event?.prompt);
    const { scopeDecision, active } = evaluateScope(hookContext);

    try {
    // Authenticated owner control: update the durable Intelligence economic
    // profile without asking a general model to interpret or write policy.
    const requestedBudget = active && text && isTrustedOwner(hookContext)
      ? parseMonthlyBudgetUpdate(text) : null;
    if (requestedBudget !== null) {
      try {
        const policy = await seam.updateMonthlyCloudBudget(requestedBudget);
        const spend = spendProvider && typeof spendProvider.current === "function" ? spendProvider.current() : null;
        const currentSpend = Number.isFinite(spend?.monthToDateCostUsd) ? spend.monthToDateCostUsd : null;
        const headroom = currentSpend === null ? null : Math.max(0, requestedBudget - currentSpend);
        const spendLine = currentSpend === null
          ? "Current month-to-date spend is unavailable."
          : `Current month-to-date cloud spend is $${currentSpend.toFixed(2)}; remaining headroom is $${headroom.toFixed(2)}.`;
        return {
          handled: true,
          reply: { text: `ToggleLogic’s monthly cloud budget is now $${Number(policy.monthly_cloud_budget_usd).toFixed(2)}. ${spendLine}` },
          reason: "skill_budget_updated",
          audit: { mode: "skill_budget_updated", monthly_cloud_budget_usd: policy.monthly_cloud_budget_usd, current_spend_usd: currentSpend, headroom_usd: headroom },
        };
      } catch (error) {
        return { handled: true, reply: { text: `I couldn’t update the ToggleLogic budget: ${String(error?.message ?? error)}.` }, reason: "skill_budget_update_failed", audit: { mode: "skill_budget_update_failed", error: String(error?.message ?? error).slice(0, 512) } };
      }
    }
    // 1) Owner reply to a staged education choice → record profile + execute the
    //    ORIGINAL bounded task in the child. Only honored in-scope.
    if (active && text) {
      let consumed = null;
      try {
        consumed = await consumeChoice(text, hookContext);
      } catch (error) {
        return { handled: true, reply: { text: `ToggleLogic could not save your routing choice: ${String(error?.message ?? error)}. No task was executed; please try again.` }, reason: "skill_profile_write_failed", audit: { mode: "skill_profile_write_failed", error: String(error?.message ?? error).slice(0, 512) } };
      }
      if (consumed) {
        if (!consumed.originalTask) {
          return { handled: true, reply: { text: `Recorded your choice (${consumed.strategy}). The original task was no longer available to execute; please resend it.` }, reason: "skill_choice_recorded_no_task", audit: { mode: "skill_routing", ...consumed.details } };
        }
        // The route is now learned, but the specific task may still be
        // unexecutable (e.g. a past/nonexistent meeting): validate the skill
        // contract before spending the bounded child.
        if (contracts) {
          const pf = await contracts.preflight(consumed.skills, consumed.originalTask, hookContext);
          if (pf.action === "clarify") {
            return { handled: true, reply: { text: pf.reply }, reason: "skill_contract_clarify", audit: { mode: "skill_contract_clarify", contract_reason: pf.reason, ...consumed.details } };
          }
        }
        const result = await executeBoundedChild({
          callRef: `choice-${crypto.randomBytes(6).toString("hex")}`,
          invocation: hookContext,
          task: consumed.originalTask,
          skills: consumed.skills,
          override: consumed.override,
          modelRef: consumed.modelRef,
          estimatedTokens: consumed.plan?.estimated_tokens,
          estimatedCostUsd: consumed.choice?.estimated_cost_usd,
          details: consumed.details,
        });
        return {
          handled: true,
          reply: { text: `${result.text}\n\n${formatSkillExecutionReceipt({ ...consumed.details, ...result.details })}` },
          reason: result.details.artifact_delivery_status && result.details.artifact_delivery_status !== "complete"
            ? "skill_choice_artifact_delivery_incomplete" : "skill_choice_executed",
          audit: { mode: "skill_routing", ...consumed.details, ...result.details },
        };
      }
      // Looked like a token reply but did not validate (wrong/replayed/expired
      // token or a different sender): fail loud, never execute inline.
      if (looksLikeChoiceReply(text)) {
        return { handled: true, reply: { text: "That routing token is not valid for a pending choice in this conversation (it may be wrong, already used, or expired). Send your request again to get a fresh choice." }, reason: "skill_choice_rejected", audit: { mode: "skill_choice_rejected" } };
      }
    }

    // 2) Resolve the skills this turn is bound to (deterministic).
    let resolved = resolvePlannedSkills(event, hookContext);

    // A skill-invocation cue naming a skill that is NOT an active installed skill.
    // Owner rule: do NOT falsely claim "no related skill" if OTHER installed skills
    // can do the job — report the named skill unavailable and OFFER the resolved
    // applicable installed skills; fall to the no-skill sentence only when none
    // relates. This offers real installed skills; it never guesses a route.
    if (resolved.status === "ambiguous") {
      if (!active) return null;
      const named = resolved.resolution?.unknownSkills || [];
      const suggestions = resolver && typeof resolver.suggest === "function" ? resolver.suggest(text, { limit: 3 }) : [];
      if (suggestions.length > 0) {
        const namedStr = named.join(", ") || "that skill";
        const offered = suggestions.map((s) => s.id);
        return {
          handled: true,
          reply: { text: formatSkillClarification(offered, resolver, skillIdentities, `The ${namedStr} skill isn't installed here. These installed skills may relate to your request:`) },
          reason: "skill_named_unavailable_alternatives",
          audit: { mode: "skill_named_unavailable_alternatives", named, offered },
        };
      }
      return { handled: true, reply: { text: NO_SKILL_FAILSAFE }, reason: "skill_named_unavailable", audit: { mode: "skill_named_unavailable", named } };
    }

    // DEPLOYMENT-OWNED DETERMINISTIC INTENT RECIPES. Evaluate these even when
    // the prompt already names an installed skill. A composed workflow often
    // names its authoritative source explicitly (for example Microsoft Graph in
    // meeting prep); treating that exact match as terminal used to discard the
    // recipe's additional required skills (Zoom transcripts in that example).
    //
    // A recipe may augment an exact text match only when it is a SUPERSET of
    // every deterministically matched skill. A disjoint/contradictory recipe
    // fails closed instead of silently overriding an explicit skill reference.
    // Structured host metadata remains authoritative and is never augmented by
    // prompt recipes.
    let recipeStatus = "not_configured";
    if (active && resolved.source !== "structured_host_metadata" && intentRecipes && typeof intentRecipes.resolve === "function") {
      const installedIds = resolver ? [...resolver.catalogIds] : [];
      const recipe = intentRecipes.resolve(text, { installedIds });
      recipeStatus = recipe.status === "resolved" || recipe.status === "ambiguous" ? recipe.status : (recipe.reason || recipe.status);
      if (recipe.status === "resolved") {
        const exactIds = new Set((resolved.skills || []).map((skill) => skill.id));
        const explicitlyInvokedIds = new Set(resolved.resolution?.explicitlyInvokedIds || []);
        const recipeIds = new Set(recipe.skills || []);
        // Plain-language mentions such as "same images", "Gamma", or "canvas"
        // are not necessarily instructions to invoke those installed skills.
        // Only an explicit "use/run <name> skill" cue can conflict with a
        // deterministic workflow recipe.
        const compatible = resolved.status !== "resolved" || [...explicitlyInvokedIds].every((id) => recipeIds.has(id));
        if (!compatible) {
          return {
            handled: true,
            reply: { text: `Your request explicitly references ${[...exactIds].join(", ")}, but the configured ${recipe.ruleId} workflow requires ${[...recipeIds].join(", ")}. Which skill or workflow should I use?` },
            reason: "skill_recipe_exact_conflict",
            audit: { mode: "skill_recipe_exact_conflict", rule_id: recipe.ruleId, exact_skills: [...exactIds], recipe_skills: [...recipeIds] },
          };
        }
        const hydrated = hydrateVerifiedSkillIds(recipe.skills);
        if (!hydrated) return skillIdentityUnavailable("intent_recipe", recipe.skills);
        resolved = {
          status: "resolved",
          skills: hydrated,
          source: exactIds.size > 0 ? "intent_recipe_augmented_exact" : "intent_recipe",
          resolution: { reason: exactIds.size > 0 ? "intent_recipe_augmented_exact" : "intent_recipe", ruleId: recipe.ruleId },
        };
      } else if (recipe.status === "ambiguous") {
        const ids = [...new Set((recipe.candidates || []).flatMap((candidate) => candidate.skills))].slice(0, 8);
        const ruleIds = (recipe.candidates || []).map((candidate) => candidate.ruleId);
        return { handled: true, reply: { text: formatSkillClarification(ids, resolver, skillIdentities, "Your request matches more than one configured workflow. These are the available skill choices:") }, reason: "skill_recipe_ambiguous", audit: { mode: "skill_recipe_ambiguous", rule_ids: ruleIds, candidates: ids } };
      }
    }

    if (resolved.status !== "resolved" || resolved.skills.length === 0) {
      // No active installed skill relates to this request (deterministically).
      if (!active) return null; // out-of-scope/shadow: prior safe passthrough behavior
      // Non-action conversation/control messages bypass the skill gate ONLY
      // through explicit deployment-owned categories — never by silent inference.
      const category = nonAction ? nonAction.match(text) : { matched: false };
      if (category.matched) {
        return { handled: false, audit: { mode: "non_action_category", category: category.category, kind: category.kind } };
      }
      const toolFree = classifyToolFreeWork(text);
      if (toolFree.matched) {
        return { handled: false, audit: { mode: "tool_free_work", category: toolFree.category } };
      }
      // A natural-language request that names no skill AND matched no recipe may
      // still map to an eligible skill via the BOUNDED resolution classifier (a
      // pinned system skill, OFF unless configured). It is given the VERIFIED
      // catalog (id + bounded description, never arbitrary prompt data), is
      // schema-validated, confidence-thresholded, audited, and PROHIBITED from
      // performing the task; its output is only a skill id we then route normally.
      let classifierStatus = "not_configured";
      if ((resolved.status !== "resolved" || resolved.skills.length === 0) && classifier && classifier.enabled) {
        let decision = { status: "error" };
        try {
          const eligible = resolver && typeof resolver.classifierCatalog === "function"
            ? resolver.classifierCatalog()
            : (resolver ? [...resolver.catalogIds].map((id) => ({ id, description: "" })) : []);
          decision = await classifier.classify(text, { eligible });
        } catch { decision = { status: "error" }; }
        classifierStatus = decision.status;
        if (decision.status === "resolved") {
          // Fall through to normal planning with the classifier-resolved skill.
          const hydrated = hydrateVerifiedSkillIds([decision.skillId]);
          if (!hydrated) return skillIdentityUnavailable("bounded_classifier", [decision.skillId]);
          resolved = { status: "resolved", skills: hydrated, source: "bounded_classifier", resolution: { reason: "classifier_resolved", confidence: decision.confidence } };
        } else if (decision.status === "ambiguous") {
          const ids = (decision.candidates || []).slice(0, 4);
          return { handled: true, reply: { text: formatSkillClarification(ids, resolver, skillIdentities, "Your request could map to more than one installed skill. Here is what each choice does:") }, reason: "skill_classifier_ambiguous", audit: { mode: "skill_classifier_ambiguous", candidates: ids, confidence: decision.confidence } };
        } else if (decision.status === "conversation") {
          return { handled: false, audit: { mode: "conversation", classifier: "bounded_local", confidence: decision.confidence } };
        }
      }
      // Fail-closed: none / low-confidence / malformed / disabled / error → the
      // fail-safe, NOT silently passed to a model.
      if (resolved.status !== "resolved" || resolved.skills.length === 0) {
        return { handled: true, reply: { text: NO_SKILL_FAILSAFE }, reason: "no_skill_failsafe", audit: { mode: "no_skill_failsafe", resolver_reason: resolved.resolution?.reason || resolved.source, recipe: recipeStatus, classifier: classifierStatus } };
      }
    }

    // We have resolved skills. Out-of-scope or shadow turns must NOT actively
    // gate — they stay passthrough (skill runs inline, non-canary path).
    if (!active) {
      return { handled: false, audit: { mode: "skill_routing_shadow", inScope: scopeDecision.inScope, shadow: shadow === true, scope_reason: scopeDecision.reason, planned_skills: resolved.skills } };
    }

    // DETERMINISTIC SAFETY PREFLIGHT — the moment skills resolve, BEFORE any
    // route/model education or spend. Intent- and skill-aware (see
    // skill-contracts.js): a past or unverifiable meeting/calendar request is
    // clarified immediately with ZERO model calls (the 2026-09-15 incident was a
    // past meeting answered with a fabricated inline brief). Generic Graph
    // email/contact work is NOT gated. This runs ahead of the three-choice
    // education preflight so a resolved skill whose SPECIFIC task can't safely
    // execute never even stages a routing choice.
    if (contracts) {
      const pf = await contracts.preflight(resolved.skills, text, hookContext);
      if (pf.action === "clarify") {
        return { handled: true, reply: { text: pf.reply }, reason: "skill_contract_clarify", audit: { mode: "skill_contract_clarify", contract_reason: pf.reason, planned_skills: resolved.skills } };
      }
    }

    // Ambiguous AMONG installed skills (more than one) → one bounded
    // clarification, execute nothing. Opt-in (clarifyOnMultiSkill): the owner rule
    // permits "one or more" skills, so multi-skill tasks resolve by default; a
    // deployment can require a single-skill choice instead.
    if (clarifyOnMultiSkill && resolved.skills.length > 1) {
      const ids = resolved.skills.map((s) => s.id);
      return { handled: true, reply: { text: formatSkillClarification(ids, resolver, skillIdentities, "Your request references more than one installed skill. I can run exactly one of these choices:") }, reason: "skill_ambiguous_multi", audit: { mode: "skill_ambiguous_multi", planned_skills: resolved.skills } };
    }

    // 3) Plan the route. The deterministic safety preflight above has already
    //    cleared this specific task (a past/unverifiable meeting clarified before
    //    reaching here), so a no-profile skill now yields the three-choice
    //    education preflight only for a task that is safe to execute once routed.
    let planResult;
    try {
      planResult = await plan({ prompt: text, plannedSkills: resolved.skills, originalTask: text }, hookContext);
    } catch (error) {
      // A resolved skill on an in-scope active turn whose route cannot be planned
      // must FAIL LOUD, not fall through to inline execution — that inline path is
      // exactly the incident. Hold the turn and ask the owner to retry.
      const names = resolved.skills.map((s) => s.id).join(", ");
      return {
        handled: true,
        reply: { text: `ToggleLogic recognized the skill (${names}) but cannot plan its route right now (${String(error?.message ?? error)}). To avoid running it unrouted, I've held this turn — please try again shortly.` },
        reason: "skill_routing_plan_unavailable",
        audit: { mode: "skill_routing_plan_unavailable", error: String(error?.message ?? error).slice(0, 512), planned_skills: resolved.skills },
      };
    }
    if (!planResult) {
      const names = resolved.skills.map((s) => s.id).join(", ");
      return {
        handled: true,
        reply: { text: `ToggleLogic recognized the skill (${names}) but its routing engine is unavailable. To avoid running it unrouted, I've held this turn — please try again shortly.` },
        reason: "skill_routing_engine_unavailable",
        audit: { mode: "skill_routing_engine_unavailable", planned_skills: resolved.skills },
      };
    }

    if (planResult.status === "education_required" && planResult.teaching_authorized === true) {
      return { handled: true, reply: { text: formatSkillPlan(planResult) }, reason: "skill_education_required", audit: { mode: "skill_routing", status: planResult.status, planned_skills: planResult.planned_skills } };
    }
    if (planResult.status === "selected" && planResult.selected_model_ref) {
      // The deterministic contract preflight already ran BEFORE planning (above),
      // so a past/unverifiable meeting was clarified without ever reaching a
      // selected route. No second preflight is needed on the same turn.
      const override = modelOverride(planResult.selected_model_ref);
      const details = {
        matched_rule: "owner_taught_skill_profile",
        planned_skills: planResult.planned_skills,
        strategy: planResult.strategy,
        model_lineage: planResult.selected_lineage,
        resolved_child: planResult.selected_model_ref,
        estimated_cost_usd: planResult.choices?.find((item) => item.kind === planResult.strategy)?.estimated_cost_usd ?? null,
      };
      const result = await executeBoundedChild({
        callRef: `selected-${crypto.randomBytes(6).toString("hex")}`,
        invocation: hookContext,
        task: text,
        skills: normalizeSkills(planResult.planned_skills),
        override,
        modelRef: planResult.selected_model_ref,
        estimatedTokens: planResult.estimated_tokens,
        estimatedCostUsd: details.estimated_cost_usd,
        details,
      });
      return {
        handled: true,
        reply: { text: `${result.text}\n\n${formatSkillExecutionReceipt({ ...details, ...result.details })}` },
        reason: result.details.artifact_delivery_status && result.details.artifact_delivery_status !== "complete"
          ? "skill_selected_artifact_delivery_incomplete" : "skill_selected_executed",
        audit: { mode: "skill_routing", ...details, ...result.details },
      };
    }
    if (["profile_conflict", "requirements_conflict", "no_eligible_model", "education_disabled"].includes(planResult.status)) {
      return { handled: true, reply: { text: formatSkillPlan(planResult) }, reason: `skill_${planResult.status}`, audit: { mode: "skill_routing", status: planResult.status, planned_skills: planResult.planned_skills } };
    }
    // education_required but not owner-authorized (e.g. non-owner in scope): show
    // the read-only preflight without staging a token.
    return { handled: true, reply: { text: formatSkillPlan(planResult) }, reason: `skill_${planResult.status}`, audit: { mode: "skill_routing", status: planResult.status } };
    } catch (error) {
      const msg = String(error?.message ?? error);
      // FAIL CLOSED on an ACTIVE governed turn (or a token-looking reply): hold
      // the turn with a handled error rather than fall through to inline model
      // execution — that fall-through is exactly the 2026-09-15 incident path.
      if (active || looksLikeChoiceReply(text)) {
        return {
          handled: true,
          reply: { text: `ToggleLogic could not safely route this governed request right now (${msg.slice(0, 200)}). To avoid running it unrouted, I've held this turn — please try again shortly.` },
          reason: "skill_routing_gate_error",
          audit: { mode: "skill_routing_gate_error", error: msg.slice(0, 512), active },
        };
      }
      // Out-of-scope / shadow: safe to stay passthrough (not a governed turn).
      return null;
    }
  }

  return {
    plan,
    consumeChoice,
    handleGate,
    evaluateScope,
    resolvePlannedSkills,
    executeBoundedChild,
    routeBindingFor,
    structuredPlannedSkills,
    formatSkillPlan,
    isShadow: shadow === true,
    scopeEnabled: Boolean(scope),
  };
}

export function createSkillRoutingTool(coordinator, defaultContext = {}) {
  return {
    name: "togglelogic_skill_plan",
    label: "ToggleLogic Skill Plan",
    description: "Declare the skills planned for a task and get the learned route or owner-facing benchmark and cost choices before invoking those skills.",
    promptSnippet: "Plan model routing for the skills you intend to use before invoking them.",
    promptGuidelines: [
      "Use togglelogic_skill_plan only to inspect or explain a route without executing the task.",
      "Automatic skill routing is enforced by ToggleLogic's before_agent_reply gate; this tool is an optional planning/cost-preview surface and does not itself gate execution.",
      "If the result asks for education, present its distinct displayed choices verbatim and stop; do not perform the task until the owner replies.",
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
        // NOTE (1.6.1-rc.3): the former monthly_cloud_spend_usd parameter was
        // REMOVED. Month-to-date cloud spend is owned by the validated live spend
        // snapshot (skillRouting.spend); no caller may hand-enter it. additional
        // Properties:false above means any legacy caller that still sends it is
        // rejected, and the coordinator ignores/audits it while live spend is on.
      },
    },
    async execute(_toolCallId, params, _signal, _onUpdate, context) {
      const plan = await coordinator.plan({
        prompt: params.task_summary,
        plannedSkills: params.skills,
        estimatedTokens: params.estimated_tokens,
        // monthlyCloudSpendUsd intentionally NOT forwarded — live spend is authoritative.
        originalTask: params.task_summary,
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
      "Skill routing is enforced automatically by ToggleLogic's before_agent_reply gate; this tool is an optional explicit surface for the same bounded execution.",
      "If education is required, present the returned choices verbatim and stop until the authenticated owner replies with the displayed number.",
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
        // NOTE (1.6.1-rc.3): the former monthly_cloud_spend_usd parameter was
        // REMOVED. Month-to-date cloud spend is owned by the validated live spend
        // snapshot (skillRouting.spend); no caller may hand-enter it. additional
        // Properties:false above means any legacy caller that still sends it is
        // rejected, and the coordinator ignores/audits it while live spend is on.
      },
    },
    async execute(toolCallId, params, signal, _onUpdate, context) {
      const invocation = context || defaultContext;
      const plan = await coordinator.plan({
        prompt: params.task_summary,
        plannedSkills: params.skills,
        estimatedTokens: params.estimated_tokens,
        // monthlyCloudSpendUsd intentionally NOT forwarded — live spend is authoritative.
        originalTask: params.task_summary,
      }, invocation);
      if (plan.status !== "selected" || !plan.selected_model_ref || coordinator.isShadow) {
        return { content: [{ type: "text", text: formatSkillPlan(plan) }], details: { ...plan, executed: false } };
      }
      const override = modelOverride(plan.selected_model_ref);
      const details = {
        model_lineage: plan.selected_lineage,
        resolved_child: plan.selected_model_ref,
        strategy: plan.strategy,
        estimated_cost_usd: plan.choices?.find((item) => item.kind === plan.strategy)?.estimated_cost_usd ?? null,
      };
      const result = await coordinator.executeBoundedChild({
        callRef: toolCallId,
        invocation,
        task: params.task_summary,
        skills: normalizeSkills(plan.planned_skills),
        override,
        modelRef: plan.selected_model_ref,
        estimatedTokens: plan.estimated_tokens,
        estimatedCostUsd: details.estimated_cost_usd,
        details,
        signal,
        runtime, // tool-supplied runtime overrides the coordinator's closure
      });
      return {
        content: [{ type: "text", text: result.text }],
        details: {
          ...result.details,
          execution_requested_skills: plan.planned_skills,
          strategy: plan.strategy,
        },
      };
    },
  };
}
