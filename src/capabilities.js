/*
 * ToggleLogic (Free Tier) — Capability Registry.
 * (c) 2026 Motherboard, Inc. Source-available under the ToggleLogic Free-Tier
 * License 2.0 (see LICENSE); all rights reserved.
 * PATENT PENDING. The benchmark Intelligence engine + Toggle Registry are NOT
 * in this package.
 *
 * Free-tier capabilities: routing (static/intent + simple cheap default +
 * lazy-detection seam), ownerOverrideAsk (the user-override notifier), and
 * costVisibility (observe-only per-model/per-day DOLLAR cost from dynamic public
 * pricing, curated to the major providers; unpriced-loud, never $0.00). Paid /
 * deployment-internal capabilities remain out of this package: spend ENFORCEMENT
 * (budget-blocking), all-model + guaranteed-current registry pricing, per-message
 * dispatch, turn-end memory capture, and credential/db-write gates.
 */

import crypto from "node:crypto";

import { createInterceptor } from "./routing/interceptor.js";
import { createIntelligenceSeam } from "./intelligence/seam.js";
import { createLogger as createRoutingLogger } from "./observability/logger.js";
import { createOwnerOverrideAskHandler } from "./capture/owner-override-ask.js";
import { createCostObserver } from "./usage/cost-observer.js";
import { createSpendProvider } from "./usage/spend-provider.js";
import { FamilyResolver } from "./routing/family-resolver.js";
import { createNewSessionTracker } from "./routing/new-session-tracker.js";
import { createApprovalGate } from "./governance/approval-gate.js";
import { createPricing } from "./usage/pricing.js";
import {
  createSkillRoutingCoordinator,
  createSkillRoutingRunTool,
  createSkillRoutingTool,
} from "./skill-routing/coordinator.js";
import { createCanaryScope } from "./skill-routing/scope.js";
import { createSkillResolver, createSkillClassifier } from "./skill-routing/resolver.js";
import { createSkillContracts } from "./skill-routing/skill-contracts.js";
import { verifyHostAffordances } from "./skill-routing/host-affordances.js";
import {
  loadSkillInventory,
  detectInventoryDrift,
  defaultInventoryPaths,
  aliasesFromCatalogConfig,
  configuredButNotInstalled,
} from "./skill-routing/skill-inventory.js";
import { createNonActionMatcher } from "./skill-routing/intent-categories.js";
import { createIntentRecipes } from "./skill-routing/intent-recipes.js";
import { createSkillRequirements } from "./skill-routing/skill-requirements.js";
import { createGraphCalendarPort } from "./skill-routing/calendar-graph.js";
import { createSubprocessCalendarTransport } from "./skill-routing/calendar-bridge.js";
import { createChildToolGuard } from "./skill-routing/child-tool-guard.js";

import { EVENTS, OUTCOMES } from "./audit/audit-events.js";

/**
 * Build the execution-surface runtime view from OpenClaw's runtime config
 * (api.config) — provider/model -> agentRuntime.id. Passed to the seam so an
 * (optional, separately-licensed) Intelligence layer can resolve each lane's
 * execution surface from the gateway's OWN config. Defensive: any shape issue
 * yields an empty map.
 */
export function buildRuntimeConfigFromApiConfig(cfg) {
  const out = { byProvider: {}, byModel: {}, acceptedModelRefs: [] };
  const addAccepted = (ref) => {
    if (typeof ref === "string" && ref.includes("/") && !out.acceptedModelRefs.includes(ref)) {
      out.acceptedModelRefs.push(ref);
    }
  };
  try {
    const providers = (cfg && cfg.models && cfg.models.providers) || {};
    for (const [prov, v] of Object.entries(providers)) {
      const rt = v && v.agentRuntime && v.agentRuntime.id;
      if (typeof rt === "string" && rt) out.byProvider[prov] = rt;
    }
    const models = cfg && cfg.agents && cfg.agents.defaults && cfg.agents.defaults.models;
    if (models) {
      for (const [ref, v] of Object.entries(models)) {
        addAccepted(ref);
        const rt = v && v.agentRuntime && v.agentRuntime.id;
        if (typeof rt === "string" && rt) out.byModel[ref] = rt;
      }
    }
    const hostModel = cfg?.agents?.defaults?.model;
    if (typeof hostModel === "string") addAccepted(hostModel);
    else if (hostModel && typeof hostModel === "object") {
      addAccepted(hostModel.primary);
      for (const ref of Array.isArray(hostModel.fallbacks) ? hostModel.fallbacks : []) addAccepted(ref);
    }
  } catch (_) { /* fall back to engine defaults */ }
  return out;
}

export function configuredProvidersFromApiConfig(cfg) {
  try {
    const providers = new Set();
    const configured = cfg?.models?.providers;
    if (configured && typeof configured === "object") {
      for (const value of Object.keys(configured)) providers.add(value.toLowerCase());
    }
    const addRef = (value) => {
      if (typeof value !== "string") return;
      const slash = value.indexOf("/");
      if (slash > 0) providers.add(value.slice(0, slash).toLowerCase());
    };
    const defaults = cfg?.agents?.defaults;
    if (defaults?.models && typeof defaults.models === "object") {
      for (const ref of Object.keys(defaults.models)) addRef(ref);
    }
    const model = defaults?.model;
    if (typeof model === "string") addRef(model);
    else if (model && typeof model === "object") {
      addRef(model.primary);
      for (const ref of Array.isArray(model.fallbacks) ? model.fallbacks : []) addRef(ref);
    }
    return [...providers].sort();
  } catch {
    return [];
  }
}

export function hostModelChainFromApiConfig(cfg) {
  const model = cfg?.agents?.defaults?.model;
  if (typeof model === "string") return { primary: model, fallbacks: [] };
  if (!model || typeof model !== "object") return { primary: null, fallbacks: [] };
  return {
    primary: typeof model.primary === "string" ? model.primary : null,
    fallbacks: Array.isArray(model.fallbacks)
      ? model.fallbacks.filter((value) => typeof value === "string")
      : [],
  };
}

export function compareHostFallbackPlan(resolved, host) {
  if (!resolved || resolved.status === "disabled") return { status: "disabled" };
  if (resolved.status !== "resolved") {
    return { status: resolved.status, unresolvedAliases: resolved.unresolvedAliases ?? [] };
  }
  const expected = [resolved.primary, ...resolved.fallbacks];
  const actual = [host?.primary, ...(host?.fallbacks ?? [])];
  const aligned = expected.length === actual.length && expected.every((value, index) => (
    String(value).toLowerCase() === String(actual[index] ?? "").toLowerCase()
  ));
  return { status: aligned ? "aligned" : "drift", expected, actual };
}

/**
 * Capability registry — one entry per feature group. Customer/community
 * deployments use the config.features flags as a delivery-time toggle.
 * register() is defensive: a failure in one capability must not block others.
 */
export const CAPABILITIES = [
  {
    id: "routing",
    // Opt-in. Operators set features.routing.enabled = true AND the gateway's
    // plugins.entries.togglelogic.hooks.allowConversationAccess to arm it.
    defaultEnabled: false,
    description:
      "Model routing: before_model_resolve hook. Resolves owner-override > " +
      "structured-label configuredRoutes > simple cheap default > passthrough. Optionally " +
      "defers to a separately-licensed Intelligence layer via the detection seam " +
      "(no benchmark engine or registry ships in this package).",
    register({ api, audit, fallbackLogger, version, config }) {
      const routingLogger = createRoutingLogger(config.logging, fallbackLogger);
      const hostRuntimeConfig = buildRuntimeConfigFromApiConfig(api && api.config);
      const configuredProviders = configuredProvidersFromApiConfig(api && api.config);
      const familyResolver = new FamilyResolver(config.familyResolution, fallbackLogger);
      const fallbackPlan = compareHostFallbackPlan(
        familyResolver.resolveHostPlan(configuredProviders),
        hostModelChainFromApiConfig(api && api.config),
      );
      audit.emit({
        event: EVENTS.FALLBACK_PLAN_CHECK,
        outcome: fallbackPlan.status === "aligned" || fallbackPlan.status === "disabled"
          ? OUTCOMES.SUCCESS
          : OUTCOMES.FAILURE,
        principal: { source: "plugin-host" },
        subject: { hostField: "agents.defaults.model" },
        details: fallbackPlan,
      });
      if (!["aligned", "disabled"].includes(fallbackPlan.status)) {
        try {
          fallbackLogger?.warn?.(
            `togglelogic: family fallback plan ${fallbackPlan.status}; ` +
            "deployment tooling must materialize the accepted concrete model chain before startup"
          );
        } catch { /* ignore */ }
      }
      const newSessions = createNewSessionTracker();
      const governedEscalation = config.features.governedEscalation.enabled
        ? createApprovalGate({
            config: config.governedEscalation,
            pricing: createPricing(config.costVisibility.pricing, fallbackLogger),
          })
        : null;
      const seam = createIntelligenceSeam(
        config.intelligence,
        fallbackLogger,
        hostRuntimeConfig,
        version,
        newSessions.consume,
      );
      let skillRouting = null;
      let calendarTransportWired = false;
      let childToolGuard = null;
      let spendSummary = null;
      if (config.features.skillRouting.enabled) {
        // Fail-loud host-affordance self-check (postmortem §10.2): verify the
        // host provides what the guaranteed gate needs; force shadow (no active
        // gating) rather than register a silently dead preflight.
        const affordances = verifyHostAffordances({ api, config });
        const forcedShadow = config.intelligence.shadow || affordances.forceShadow;
        audit.emit({
          event: EVENTS.FALLBACK_PLAN_CHECK,
          outcome: affordances.ok ? OUTCOMES.SUCCESS : OUTCOMES.FAILURE,
          principal: { source: "plugin-host" },
          subject: { capability: "skillRouting", check: "host-affordances" },
          details: {
            ok: affordances.ok,
            forcedShadow,
            configuredShadow: config.intelligence.shadow,
            scopeEnabled: config.skillRouting.scope.enabled,
            scopeConstrained: [config.skillRouting.scope.channels, config.skillRouting.scope.accountIds, config.skillRouting.scope.senderIds, config.skillRouting.scope.chatIds, config.skillRouting.scope.sessionKeys].some((l) => l.length > 0),
            catalogSize: config.skillRouting.skillCatalog.length,
            missing: affordances.missing,
            warnings: affordances.warnings,
          },
        });
        if (affordances.missing.length || affordances.warnings.length) {
          try {
            const notes = [...affordances.missing.map((m) => `CRITICAL: ${m}`), ...affordances.warnings].join(" | ");
            fallbackLogger?.warn?.(
              `togglelogic skill-routing: ${affordances.ok ? "active gating degraded" : "INERT (forced shadow)"} — ${notes}`
            );
          } catch { /* ignore */ }
        }
        const scope = createCanaryScope(config.skillRouting.scope);

        // AUTHORITATIVE catalog from the DEPLOYMENT-OWNED inventory SNAPSHOT
        // (generated at deploy time from `openclaw skills list --json`, ELIGIBLE
        // set only, versioned + fingerprinted). The plugin VERIFIES the snapshot's
        // source, version pair, freshness, and fingerprint and FAILS CLOSED on a
        // missing/stale/wrong-source/wrong-version/drifted snapshot — it never reads
        // the workspace skill_manifest.json (proven stale) and never shells out to
        // `openclaw` on a turn. The config skillCatalog only SUPPLEMENTS aliases.
        let resolverCatalog = config.skillRouting.skillCatalog;
        let inventorySummary = { used: "config_catalog" };
        if (config.skillRouting.useSnapshotInventory) {
          const paths = defaultInventoryPaths(config);
          const inventory = loadSkillInventory({
            snapshotPath: paths.snapshotPath,
            expectedPluginFree: version,
            maxAgeMs: config.skillRouting.inventoryMaxAgeHours * 3_600_000,
            aliases: aliasesFromCatalogConfig(config.skillRouting.skillCatalog),
          });
          const drift = detectInventoryDrift(inventory, { markerPath: paths.markerPath });
          const notInstalled = configuredButNotInstalled(config.skillRouting.skillCatalog, inventory);
          resolverCatalog = inventory.catalog; // snapshot authoritative (empty on failure → fail-closed)
          inventorySummary = {
            used: "deployment_snapshot",
            ok: inventory.ok,
            verified: inventory.verified,
            source: inventory.source,
            snapshotPath: paths.snapshotPath,
            eligibleSkillCount: inventory.catalog.length,
            counts: inventory.counts,
            ageHours: Number.isFinite(inventory.ageMs) ? Math.round(inventory.ageMs / 3_600_000) : null,
            stale: inventory.stale,
            inventoryFingerprint: inventory.inventoryFingerprint,
            drift: { firstRun: drift.firstRun, drifted: drift.drifted, added: drift.added, removed: drift.removed, changed: drift.changed.map((c) => c.id) },
            configuredButNotInstalled: notInstalled,
            errors: inventory.errors,
          };
          audit.emit({
            event: EVENTS.FALLBACK_PLAN_CHECK,
            outcome: inventory.ok && !drift.drifted ? OUTCOMES.SUCCESS : OUTCOMES.FAILURE,
            principal: { source: "plugin-host" },
            subject: { capability: "skillRouting", check: "skill-inventory-snapshot" },
            details: inventorySummary,
          });
          if (!inventory.ok || drift.drifted || notInstalled.length) {
            try {
              const notes = [];
              if (!inventory.ok) notes.push(`INVENTORY SNAPSHOT UNTRUSTED (${(inventory.errors || []).join("; ")}) — failing closed; no turn can resolve to a skill. Run scripts/generate-skill-inventory.mjs on the host.`);
              if (drift.drifted) notes.push(`INVENTORY DRIFT since last accepted run: +[${drift.added}] -[${drift.removed}] ~[${drift.changed.map((c) => c.id)}]`);
              if (notInstalled.length) notes.push(`configured catalog ids not in the snapshot: ${notInstalled.join(", ")}`);
              fallbackLogger?.warn?.(`togglelogic skill-routing inventory: ${notes.join(" | ")}`);
            } catch { /* ignore */ }
          }
        }

        const resolver = createSkillResolver({
          catalog: resolverCatalog,
          mode: config.skillRouting.resolverMode,
          ambiguityPolicy: config.skillRouting.ambiguityPolicy,
        });
        const nonAction = createNonActionMatcher(
          config.skillRouting.nonActionCategories,
          (msg) => { try { fallbackLogger?.warn?.(`togglelogic skill-routing: ${msg}`); } catch { /* ignore */ } },
        );
        // Deployment-owned deterministic intent recipes — declarative token rules
        // that compose a natural-language request to one-or-more INSTALLED skills,
        // evaluated AFTER exact resolution returns none and BEFORE the classifier.
        // A rule only resolves when every target skill is in the verified inventory.
        const intentRecipes = createIntentRecipes(config.skillRouting.intentRecipes);
        // DEPLOYMENT-OWNED per-skill capability requirements (routing constraints).
        // Aggregated (strictest) across a turn's resolved skills by the coordinator
        // and passed across the seam into Intelligence.planSkills so first-use
        // education for a tool-using skill (Graph/Zoom) never offers a
        // general_purpose-only local model; a proven tool-free skill explicitly
        // configured general_purpose may still win local lowest-cost.
        const requirements = createSkillRequirements(config.skillRouting.skillRequirements);
        // Bounded skill-resolution classifier (a pinned SYSTEM skill with its own
        // model assignment — preserving the models-by-skill architecture). OFF
        // unless a model is pinned; when off, natural-language turns that name no
        // skill hit the no-skill fail-safe. Every decision is audited.
        const classifier = createSkillClassifier(config.skillRouting.classifier, {
          audit: (decision) => audit.emit({
            event: EVENTS.FALLBACK_PLAN_CHECK,
            outcome: decision.decision === "resolved" ? OUTCOMES.SUCCESS : OUTCOMES.FAILURE,
            principal: { source: "plugin-host" },
            subject: { capability: "skillRouting", check: "skill-resolution-classifier" },
            details: { ...decision, model: config.skillRouting.classifier.model, promptMode: config.skillRouting.classifier.promptMode, lightContext: config.skillRouting.classifier.lightContext },
          }),
          logger: fallbackLogger,
        });
        // Microsoft Graph /me/calendarView grounding port. The production
        // transport is a SUBPROCESS BRIDGE: when the deployment configures
        // skillRouting.calendar.bridge.command, the plugin spawns that explicitly
        // configured, vault-backed, read-only bridge executable
        // (microsoft-graph/scripts/calendar_bridge.py) with a bounded window,
        // wall-clock timeout, and strict JSON validation, and uses its sanitized
        // output as the authoritative calendar. The plugin holds no Graph
        // credentials itself; the bridge does. No model instruction substitutes for
        // this call. With calendar disabled, or enabled-but-unwired (no bridge
        // command), the port has hasTransport:false and every findEvent fails CLOSED
        // (clarify, never fabricate).
        let calendarPort = null;
        if (config.skillRouting.calendar.enabled) {
          const bridgeTransport = createSubprocessCalendarTransport(
            config.skillRouting.calendar.bridge,
            { timeoutMs: config.skillRouting.calendar.timeoutMs, logger: fallbackLogger },
          );
          calendarTransportWired = typeof bridgeTransport === "function";
          calendarPort = createGraphCalendarPort({
            ...(bridgeTransport ? { transport: bridgeTransport } : {}),
            timeoutMs: config.skillRouting.calendar.timeoutMs,
            logger: fallbackLogger,
          });
          audit.emit({
            event: EVENTS.FALLBACK_PLAN_CHECK,
            outcome: calendarTransportWired ? OUTCOMES.SUCCESS : OUTCOMES.FAILURE,
            principal: { source: "plugin-host" },
            subject: { capability: "skillRouting", check: "calendar-bridge" },
            details: {
              enabled: true,
              transportWired: calendarTransportWired,
              command: config.skillRouting.calendar.bridge.command || null,
              timeoutMs: config.skillRouting.calendar.timeoutMs,
              note: calendarTransportWired
                ? "authoritative /me/calendarView grounding via configured subprocess bridge"
                : "calendar enabled but no bridge command configured — port fails CLOSED (clarify, never fabricate)",
            },
          });
          if (!calendarTransportWired) {
            try { fallbackLogger?.warn?.("togglelogic skill-routing: calendar enabled but skillRouting.calendar.bridge.command is not set — meeting-prep grounding will fail closed (clarify, never fabricate)"); } catch { /* ignore */ }
          }
        }
        const contracts = createSkillContracts({
          ownerTimezone: config.skillRouting.ownerTimezone,
          skillTools: config.skillRouting.skillTools,
          maxChildToolCalls: config.skillRouting.maxChildToolCalls,
          // Deployment-owned per-skill mailbox/sender identity (credential-free),
          // injected into the routed child and surfaced in the audit/receipt.
          skillIdentities: config.skillRouting.skillIdentities,
          ...(calendarPort ? { calendarPort } : {}),
        });
        // Bounded-child tool guard: the plugin-enforceable half of the child
        // ceiling. Registered on before_tool_call below; denies re-entrant routing
        // tools, off-allowlist tools, and tool calls past the per-run count ceiling
        // on ":togglelogic-skill:" child sessions. (The host exposes no model
        // token/pass cap — that residual gap is documented, not silently claimed.)
        childToolGuard = createChildToolGuard({
          maxToolCalls: config.skillRouting.maxChildToolCalls,
          logger: fallbackLogger,
          auditInternalError: (details) => audit.emit({
            event: EVENTS.ROUTING_DECISION,
            outcome: OUTCOMES.FAILURE,
            principal: { source: "plugin-host" },
            subject: { hook: "before_tool_call", capability: "skillRouting" },
            details,
          }),
        });
        // LIVE cloud-spend provider. When enabled, the coordinator consumes a
        // deployment-owned, validated, current-policy-month cloud-spend snapshot as
        // the authoritative month-to-date spend for routing (no caller hand-enters a
        // number). It fails CLOSED on a missing/stale/invalid snapshot: with a finite
        // cloud budget declared, cloud routes are withheld while local-capable routes
        // remain. Disabled by default (falls back to the static monthlyCloudSpendUsd).
        const spendProvider = config.skillRouting.spend.enabled
          ? createSpendProvider(config.skillRouting.spend, {
              version,
              ownerTimezone: config.skillRouting.ownerTimezone,
              defaultCostLogPath: config.costVisibility.log.path,
              fallbackLogger,
            })
          : null;
        if (spendProvider) {
          let startup = { status: "disabled" };
          try { startup = spendProvider.current(); } catch (error) { startup = { status: "unavailable", errors: [String(error?.message ?? error)] }; }
          spendSummary = {
            enabled: true,
            status: startup.status,
            finiteCloudBudgetApplies: spendProvider.finiteCloudBudgetApplies,
            cloudSuppressed: startup.cloudSuppressed === true,
            policyMonth: startup.policyMonth ?? null,
          };
          audit.emit({
            event: EVENTS.FALLBACK_PLAN_CHECK,
            outcome: startup.status === "ok" ? OUTCOMES.SUCCESS : OUTCOMES.FAILURE,
            principal: { source: "plugin-host" },
            subject: { capability: "skillRouting", check: "cloud-spend-snapshot" },
            details: {
              enabled: true,
              status: startup.status,
              reason: startup.reason ?? null,
              policyMonth: startup.policyMonth ?? null,
              snapshotPath: spendProvider.snapshotPath,
              finiteCloudBudgetApplies: spendProvider.finiteCloudBudgetApplies,
              monthToDateCostUsd: startup.monthToDateCostUsd ?? null,
              effectiveSpendUsd: Number.isFinite(startup.effectiveSpendUsd) ? startup.effectiveSpendUsd : null,
              cloudSuppressed: startup.cloudSuppressed === true,
              ageHours: startup.ageHours ?? null,
              stale: startup.stale === true,
              errors: (startup.errors || []).slice(0, 8),
            },
          });
          if (startup.status !== "ok") {
            try {
              fallbackLogger?.warn?.(
                `togglelogic skill-routing spend: live snapshot ${startup.status}` +
                (spendProvider.finiteCloudBudgetApplies && startup.cloudSuppressed ? " — WITHHOLDING cloud routes (finite budget; local-capable routes remain)" : " — falling back to static spend") +
                ` (${(startup.errors || []).join("; ") || startup.reason || "no snapshot"}). Run scripts/generate-spend-snapshot.mjs on the host.`
              );
            } catch { /* ignore */ }
          }
        }
        skillRouting = createSkillRoutingCoordinator({
          seam,
          config: config.skillRouting,
          fallbackLogger,
          shadow: forcedShadow,
          scope,
          resolver,
          contracts,
          runtime: api.runtime,
          nonAction,
          intentRecipes,
          classifier,
          requirements,
          childToolGuard,
          spendProvider,
          auditUsage: (details) => audit.emit({
            event: EVENTS.ROUTING_DECISION,
            outcome: details?.execution_status === "ok" ? OUTCOMES.SUCCESS : OUTCOMES.FAILURE,
            principal: { source: "plugin-host" },
            subject: { hook: "subagent_child", check: "post-run-usage-audit" },
            details,
          }),
          auditSpend: (details) => audit.emit({
            event: EVENTS.ROUTING_DECISION,
            outcome: details?.status === "ok" ? OUTCOMES.SUCCESS : OUTCOMES.FAILURE,
            principal: { source: "plugin-host" },
            subject: { hook: "before_agent_reply", check: "cloud-spend-resolution" },
            details,
          }),
        });
      }
      const interceptor = createInterceptor({
        config,
        hostConfig: api && api.config,
        logger: routingLogger,
        seam,
        version,
        audit,
        familyResolver,
        configuredProviders,
        governedEscalation,
        skillRouting,
      });
      api.on("session_start", (event, hookContext) => {
        newSessions.mark({
          sessionId: event?.sessionId ?? hookContext?.sessionId,
          sessionKey: event?.sessionKey ?? hookContext?.sessionKey,
        });
      });
      api.on("before_model_resolve", interceptor, { priority: 100 });
      if (skillRouting) {
        api.registerTool(
          (toolContext) => createSkillRoutingTool(skillRouting, toolContext),
          { name: "togglelogic_skill_plan" },
        );
        api.registerTool(
          (toolContext) => createSkillRoutingRunTool(skillRouting, api.runtime, config.skillRouting, toolContext),
          { name: "togglelogic_skill_run" },
        );
      }
      if (governedEscalation || skillRouting) {
        // eligibleTriggers:["user"] is HOST-ENFORCED — the host refuses to fire
        // this reply hook for cron/heartbeat turns, so the canary can never gate
        // (or educate on) scheduled/background work. Scope + trigger checks in
        // the coordinator are defense-in-depth for hosts that ignore it.
        api.on("before_agent_reply", (event, hookContext) => interceptor.preflight({
          ...event,
          prompt: event?.cleanedBody || event?.prompt || "",
        }, hookContext), { priority: 100, eligibleTriggers: ["user"] });
      }
      if (childToolGuard) {
        // Bounded-child tool enforcement (before_tool_call). Fires for ALL tool
        // calls but only ACTS on ":togglelogic-skill:" child sessions (abstains
        // elsewhere), denying re-entrant routing tools, off-allowlist tools, and
        // tool calls past the per-run count ceiling. Emit a loud audit line on deny.
        api.on("before_tool_call", (event, toolContext) => {
          const decision = childToolGuard.beforeToolCall(event, toolContext);
          if (decision?.block) {
            audit.emit({
              event: EVENTS.ROUTING_DECISION,
              outcome: OUTCOMES.FAILURE,
              principal: { source: "plugin-host" },
              subject: { hook: "before_tool_call", check: "bounded-child-tool-deny" },
              details: {
                mode: "bounded_child_tool_denied",
                tool: event?.toolName ?? null,
                reason: decision.blockReason,
                child_session_key_hash: toolContext?.sessionKey
                  ? crypto.createHash("sha256").update(String(toolContext.sessionKey)).digest("hex") : null,
              },
            });
          }
          return decision;
        }, { priority: 100 });
      }
      if (governedEscalation) {
        api.on("before_agent_run", governedEscalation.beforeAgentRun, { priority: 100 });
        api.on("agent_turn_prepare", governedEscalation.prepareTurn, { priority: 100 });
        api.on("llm_output", governedEscalation.observeOutput, { priority: 100 });
        api.on("message_sending", governedEscalation.appendReceipt, { priority: 100 });
        api.on("reply_payload_sending", governedEscalation.prepareReplyPayload, { priority: 100 });
      }

      // Lazy intelligence detection (no-op without a licensed layer present).
      seam.detect().catch((err) => {
        try {
          audit.emit({
            event: EVENTS.ROUTING_HOOK_FIRE,
            outcome: OUTCOMES.FAILURE,
            principal: { source: "plugin-host" },
            subject: { phase: "intelligence-detect" },
            details: { error: String(err?.message ?? err).slice(0, 512) },
          });
        } catch { /* ignore */ }
        try {
          fallbackLogger?.warn?.(
            `togglelogic: intelligence detection error: ${err?.message ?? err}`
          );
        } catch { /* ignore */ }
      });

      return {
        hooks: [
          "session_start",
          "before_model_resolve",
          ...(governedEscalation || skillRouting ? ["before_agent_reply"] : []),
          ...(childToolGuard ? ["before_tool_call"] : []),
          ...(governedEscalation ? ["before_agent_run", "agent_turn_prepare", "llm_output", "message_sending", "reply_payload_sending"] : []),
        ],
        intelligence: { enabled: config.intelligence.enabled },
        fallbackPlan: { status: fallbackPlan.status },
        skillRouting: {
          enabled: Boolean(skillRouting),
          gate: skillRouting ? "before_agent_reply" : null,
          activeGating: Boolean(skillRouting) && !skillRouting.isShadow && config.skillRouting.scope.enabled,
          shadow: skillRouting ? skillRouting.isShadow : null,
          catalogSize: config.skillRouting.skillCatalog.length,
          tools: skillRouting ? ["togglelogic_skill_plan", "togglelogic_skill_run"] : [],
          childToolGuard: {
            enabled: Boolean(childToolGuard),
            hook: childToolGuard ? "before_tool_call" : null,
            maxToolCalls: config.skillRouting.maxChildToolCalls,
            perSkillPolicies: Object.keys(config.skillRouting.skillTools || {}).length,
          },
          calendar: {
            enabled: config.skillRouting.calendar.enabled,
            transportWired: calendarTransportWired,
          },
          spend: spendSummary || { enabled: false },
        },
      };
    },
  },
  {
    id: "ownerOverrideAsk",
    // Opt-in. The user-override "switch back?" notifier: when an owner override
    // is active and a substantive turn completes, structurally invokes the
    // deployment-supplied consumer so the owner can be prompted to resume the
    // default. Fire-and-forget; authors no prompt content (deployment-side).
    defaultEnabled: false,
    description:
      "Owner-override switch-back notifier. Registers message_sending. Invokes " +
      "the deployment-supplied consumer when an override is active so the owner " +
      "can be prompted to switch back. Never blocks delivery; no prompt content " +
      "authored here.",
    register({ api, audit, fallbackLogger, config }) {
      const handler = createOwnerOverrideAskHandler({ config, fallbackLogger });
      api.on("message_sending", handler);
      return { hooks: ["message_sending"] };
    },
  },
  {
    id: "costVisibility",
    // Opt-in. Operators set features.costVisibility.enabled = true AND the
    // gateway's plugins.entries.togglelogic.hooks.allowConversationAccess (the
    // llm_output hook is a conversation hook). Observe-only: it reports dollar
    // cost, it can never block/halt/downgrade a call.
    defaultEnabled: false,
    description:
      "Cost visibility: observes the llm_output hook (OBSERVE-ONLY) and reports " +
      "per-model / per-day DOLLAR cost from dynamic public pricing (Models.dev, " +
      "MIT; bundled LiteLLM fallback when offline). Curated to the free-tier " +
      "providers (Anthropic/OpenAI/Google/xAI/Meta); anything else is reported " +
      "LOUDLY as unpriced — never a silent $0.00. Reports only; never enforces.",
    register({ api, audit, fallbackLogger, config }) {
      const observer = createCostObserver({ config, fallbackLogger });
      api.on("llm_output", observer.handler);
      observer.warm(); // prefetch pricing once at startup (no per-call fetch)
      return {
        hooks: ["llm_output"],
        pricingSource: (config.costVisibility && config.costVisibility.pricing.sourceUrl) || "models.dev",
        costLog: observer.logPath,
      };
    },
  },
];

/**
 * Resolve which capabilities are enabled given operator config. "reason" is
 * recorded in the feature-gate audit line so the stream shows what's on + why.
 */
export function resolveFeatureGates(features) {
  const f = features && typeof features === "object" ? features : {};
  return CAPABILITIES.map((cap) => {
    const entry = f[cap.id];
    if (!entry || typeof entry !== "object") {
      return { id: cap.id, enabled: cap.defaultEnabled, reason: "default" };
    }
    if (entry.enabled === true) return { id: cap.id, enabled: true, reason: "explicit-on" };
    if (entry.enabled === false) return { id: cap.id, enabled: false, reason: "explicit-off" };
    return { id: cap.id, enabled: cap.defaultEnabled, reason: "default-malformed-entry" };
  });
}

/**
 * Drive capability registration. Emits one feature-gate audit line per
 * capability (including dormant ones) so the audit stream documents every
 * startup decision.
 */
export function registerCapabilities({ api, audit, fallbackLogger, version, config }) {
  const gates = resolveFeatureGates(config.features);
  const registered = [];

  for (const gate of gates) {
    const cap = CAPABILITIES.find((c) => c.id === gate.id);
    if (!cap) continue;

    if (!gate.enabled) {
      audit.emit({
        event: EVENTS.FEATURE_GATE,
        outcome: OUTCOMES.SKIP,
        principal: { source: "plugin-host" },
        subject: { capability: cap.id },
        details: { enabled: false, reason: gate.reason, description: cap.description },
      });
      continue;
    }

    try {
      const summary = cap.register({ api, audit, fallbackLogger, version, config });
      audit.emit({
        event: EVENTS.FEATURE_GATE,
        outcome: OUTCOMES.SUCCESS,
        principal: { source: "plugin-host" },
        subject: { capability: cap.id },
        details: { enabled: true, reason: gate.reason, description: cap.description, ...summary },
      });
      registered.push(cap.id);
    } catch (err) {
      audit.emit({
        event: EVENTS.FEATURE_GATE,
        outcome: OUTCOMES.FAILURE,
        principal: { source: "plugin-host" },
        subject: { capability: cap.id },
        details: { enabled: false, reason: "register-error", error: String(err?.message ?? err).slice(0, 512) },
      });
      try {
        fallbackLogger?.warn?.(
          `togglelogic: capability "${cap.id}" failed to register: ${err?.message ?? err}`
        );
      } catch { /* ignore */ }
    }
  }

  return { registered, gates };
}
