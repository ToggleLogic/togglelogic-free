/*
 * ToggleLogic (Free Tier) — config normalization.
 * (c) 2026 Motherboard, Inc. Source-available under the ToggleLogic Free-Tier
 * License 2.0 (see LICENSE). PATENT PENDING.
 *
 * Runtime config resolver: fills defaults, coerces defensively, returns a
 * trusted shape. On anything malformed it falls back to a safe default rather
 * than throw — a misconfigured plugin should still load in passthrough mode,
 * not crash the gateway. The manifest configSchema is the primary validator.
 *
 * Free-tier config surface: mode, logging, configuredRoutes, cheapHeuristic,
 * intelligence (detection of an optional licensed layer), ownerOverride
 * (user-override mechanism), audit, features (routing + ownerOverrideAsk).
 */

import { normalizeScope } from "../skill-routing/scope.js";
import { normalizeIntentRecipes } from "../skill-routing/intent-recipes.js";
import { normalizeSkillRequirements } from "../skill-routing/skill-requirements.js";

const VALID_MODES = ["auto", "passthrough", "configured", "cheap", "intelligence"];

export const DEFAULTS = Object.freeze({
  mode: "auto",
  logging: Object.freeze({
    enabled: true,
    path: "~/.openclaw/logs/togglelogic-routing.log",
    rotateSizeMb: 50,
  }),
  configuredRoutes: Object.freeze({}),
  // Simple cheapest-default heuristic (free tier): a deployment-declared static
  // default. No registry, no benchmark, no request classification.
  cheapHeuristic: Object.freeze({ default: "", order: [] }),
  familyResolution: Object.freeze({
    enabled: false,
    catalogPath: "~/.openclaw/togglelogic/pricing-cache.json",
    maxAgeHours: 48,
    aliases: Object.freeze({}),
    hostPlan: Object.freeze({ primary: "", fallbacks: Object.freeze([]) }),
  }),
  intelligence: Object.freeze({
    enabled: true,
    path: "~/togglelogic-intelligence",
    registryPath: "",
    skillProfilesPath: "",
    shadow: false,
    fallbackOnError: true,
    allowReleaseCandidate: false,
  }),
  features: Object.freeze({
    routing: Object.freeze({ enabled: false }),
    ownerOverrideAsk: Object.freeze({ enabled: false }),
    costVisibility: Object.freeze({ enabled: false }),
    governedEscalation: Object.freeze({ enabled: false }),
    skillRouting: Object.freeze({ enabled: false }),
  }),
  audit: Object.freeze({
    enabled: true,
    path: "~/.openclaw/logs/togglelogic-audit.jsonl",
    rotateSizeMb: 50,
  }),
  // Owner override (user-override mechanism): a top-priority operator model
  // choice applied ABOVE everything else. GENERIC only — the plugin reads the
  // configured state file; deployment-side tooling writes its contents. Opt-in.
  ownerOverride: Object.freeze({
    enabled: false,
    statePath: "~/.openclaw/togglelogic/owner_model_override.json",
    askConsumer: "~/.openclaw/togglelogic/owner_override_ask.py",
  }),
  // Cost visibility (observe-only): per-model / per-day DOLLAR cost from dynamic
  // public pricing (Models.dev primary, bundled LiteLLM fallback). Curated to the
  // free-tier providers; unpriced-loud, never $0.00. Reports only — never enforces.
  costVisibility: Object.freeze({
    attribution: Object.freeze({
      deploymentId: "",
      costCenter: "",
    }),
    log: Object.freeze({ enabled: true, path: "~/.openclaw/logs/togglelogic-cost.jsonl", rotateSizeMb: 50 }),
    pricing: Object.freeze({
      sourceUrl: "https://models.dev/api.json",
      cachePath: "~/.openclaw/togglelogic/pricing-cache.json",
      refreshHours: 24,
      timeoutMs: 15000,
      userPriceOverridePath: "",
    }),
    summaryEveryCalls: 20,
  }),
  governedEscalation: Object.freeze({
    localModel: "",
    localTiers: Object.freeze(["general_purpose"]),
    approvalTiers: Object.freeze(["flagship_reasoning"]),
    ttlMinutes: 10,
    statePath: "~/.openclaw/togglelogic/governed-escalation.json",
    externalDataNotice: "this request and active conversation context will be sent to the selected external provider",
    approvalLanguage: Object.freeze({
      affirmative: Object.freeze(["yes"]),
      negative: Object.freeze(["no"]),
    }),
    displayNames: Object.freeze({ providers: Object.freeze({}), models: Object.freeze({}) }),
  }),
  skillRouting: Object.freeze({
    pendingStatePath: "~/.openclaw/togglelogic/skill-routing-pending.json",
    artifactStagingRoot: "~/.openclaw/workspace/.togglelogic-artifacts",
    pendingTtlMinutes: 15,
    defaultEstimatedTokens: 4000,
    executionTimeoutSeconds: 600,
    monthlyCloudSpendUsd: 0,
    // LIVE cloud-spend snapshot (1.6.1-rc.3). When enabled the coordinator consumes
    // a DEPLOYMENT-OWNED, versioned+fingerprinted, current-policy-month cloud-spend
    // snapshot (written by scripts/generate-spend-snapshot.mjs from `openclaw gateway
    // usage-cost --all-agents --expect-final --json`) as the AUTHORITATIVE spend for
    // routing — no caller hand-enters a number. The plugin re-verifies source/pair/
    // month/freshness/fingerprint, fails CLOSED on unpriced CLOUD rows, and (with a
    // finite cloud budget declared) treats an unavailable snapshot as budget-exhausted
    // so cloud routes are withheld while local-capable routes remain. Unpriced LOCAL
    // (Ollama) rows are expected $0 and never fail the snapshot. Disabled by default
    // (falls back to the static monthlyCloudSpendUsd). See src/usage/spend-snapshot.js.
    spend: Object.freeze({
      enabled: false,
      snapshotPath: "~/.openclaw/togglelogic/cloud-spend.snapshot.json",
      maxAgeHours: 26, // daily refresh cadence + slack; older = stale = fail closed
      timezone: "",    // policy-month timezone; defaults to skillRouting.ownerTimezone
      localProviders: Object.freeze(["ollama"]),
      // When true, an unavailable/stale/invalid snapshot suppresses cloud routes (a
      // finite amortized cloud budget applies; see docs/ECONOMIC-PROFILE.md). When
      // false, an unavailable snapshot falls back to the static monthlyCloudSpendUsd.
      finiteCloudBudgetApplies: false,
      // OPTIONAL conservative in-memory top-up from the plugin's OWN cost log for
      // cloud calls STRICTLY AFTER the snapshot's `through` instant (same policy
      // month). Uses already-reconciled costUsd (no cache double-pricing). Off by default.
      delta: Object.freeze({
        enabled: false,
        costLogPath: "", // defaults to costVisibility.log.path
        maxBytes: 8 * 1024 * 1024,
      }),
    }),
    // Bounded-child ceilings — the routed child runs in a FRESH session seeded
    // only with the bounded task + skill list; these cap it so a routed skill can
    // never re-incur the 452K-token fat-main-session amplification the incident
    // showed. A plan estimated above maxChildTokens fails loud instead of running.
    maxChildTokens: 200000,
    maxChildCostUsd: 5,
    // Hard per-child tool-call COUNT ceiling, enforced live by the before_tool_call
    // guard (child-tool-guard.js). Bounds a runaway tool loop; it is NOT a model
    // token/pass cap (the host exposes none — see docs/BOUNDED-CHILD-LIMITS.md).
    maxChildToolCalls: 32,
    // Per-skill bounded tool surface: { "<skillId>": { allowedTools:[...],
    // maxToolCalls:int, disableTools:bool } }. disableTools → empty tool surface;
    // a non-null allowlist and count cap are enforced by the guard.
    skillTools: Object.freeze({}),
    // DEPLOYMENT-OWNED per-skill EXECUTION IDENTITY (authoritative mailbox/account
    // + sender identity + send policy), keyed by verified installed skill id and
    // injected into the routed child's system prompt + audit/receipt (never a
    // credential). Not model-selectable; an identity is only applied to a skill
    // that actually resolved on the turn, so identities can never cross skills.
    // Default empty (opt-in). See src/skill-routing/skill-contracts.js.
    skillIdentities: Object.freeze({}),
    // Deterministic skill resolution from message text (see resolver.js).
    resolverMode: "deterministic", // "deterministic" | "off"
    ambiguityPolicy: "clarify",    // "clarify" | "fail"
    // DEPLOYMENT-OWNED skill-inventory SNAPSHOT (authoritative). The plugin does
    // NOT read the workspace skill_manifest.json (proven stale on the reference
    // host) and NEVER shells out to `openclaw` on a turn. A deploy-time generator
    // (scripts/generate-skill-inventory.mjs) runs `openclaw skills list --json`,
    // filters to the ELIGIBLE set, and writes a versioned+fingerprinted snapshot
    // here; the plugin verifies source/version/freshness/fingerprint and fails
    // CLOSED on a missing/stale/wrong-source/wrong-version/drifted snapshot. The
    // config skillCatalog only SUPPLEMENTS aliases for snapshot ids.
    useSnapshotInventory: true,
    inventorySnapshotPath: "~/.openclaw/togglelogic/skill-inventory.snapshot.json",
    inventoryMarkerPath: "~/.openclaw/togglelogic/skill-inventory-accepted.json",
    inventoryMaxAgeHours: 24,
    skillCatalog: Object.freeze([]),
    // Bounded skill-resolution classifier (a SYSTEM skill with its own model
    // assignment). Exact id/alias resolution is always deterministic; this is the
    // SECOND stage for natural-language requests that name no skill. It is a
    // tool-free, minimal, light-context classifier PINNED by the deployment
    // (preferably a local Ollama model), constrained to the FRESH eligible
    // inventory, schema-validated and confidence-thresholded, audited, and
    // PROHIBITED from performing the task. OFF by default: with no pinned model the
    // resolver stays exact-only and an unresolved actionable turn hits the
    // no-skill fail-safe (fail-safe, never guess).
    classifier: Object.freeze({
      enabled: false,
      provider: "ollama",
      model: "",                 // deployment-pinned, e.g. "llama3.1:8b"
      endpoint: "http://127.0.0.1:11434",
      confidenceThreshold: 0.6,
      // A scored alternative within this confidence gap of the primary is a genuine
      // near-tie → clarify; a clear winner plus a long-shot alternative is not
      // ambiguous. The model must also flag genuine equal applicability explicitly.
      ambiguityGap: 0.15,
      timeoutMs: 4000,
      // Local context window. Default sized for the current 57-skill catalog fed as
      // id + bounded description; the 2048 default silently truncated that list in
      // local benchmarks. Hard-bounded [2048, 32768] in normalizeClassifier.
      numCtx: 8192,
      promptMode: "minimal",
      lightContext: true,
    }),
    // DEPLOYMENT-OWNED deterministic intent recipes. Declarative normalized-token
    // rules ({ id, allTerms, anyTerms, skillIds }) that compose a natural-language
    // request to one-or-more INSTALLED skills AFTER exact resolution returns none
    // and BEFORE the classifier. A rule resolves only if every target skill is in
    // the fresh verified inventory; conflicting rules fail closed. Default empty.
    intentRecipes: Object.freeze([]),
    // Owner rule: multiple explicitly-named installed skills resolve as a
    // multi-skill task ("one or more"); set true to require one bounded
    // clarification instead when more than one installed skill is referenced.
    clarifyOnMultiSkill: false,
    // DEPLOYMENT-OWNED per-skill CAPABILITY REQUIREMENTS (routing constraints, not
    // learned model choices). Keyed by verified installed skill id; carries the
    // capability floor a skill needs (requiredTier/requiredSurface/privacy/
    // requiresTools + optional estimatedTokens/minimumBenchmarkScore/cost caps).
    // A skill with NO explicit entry inherits the CONSERVATIVE default
    // (tool_calling_strong + requiresTools) so an unverified general_purpose-only
    // local model is never offered for tool-using skill execution; a PROVEN
    // tool-free skill is opted DOWN to { requiredTier:"general_purpose",
    // requiresTools:false }. Aggregated (strictest) across a turn's resolved skills
    // and passed across the seam into Intelligence.planSkills. Invalid values fail
    // CLOSED to the conservative fallback (see skill-requirements.js).
    skillRequirements: Object.freeze({
      default: Object.freeze({
        requiredTier: "tool_calling_strong",
        requiredSurface: null,
        privacy: "cloud_allowed",
        requiresTools: true,
        estimatedTokens: null,
        minimumBenchmarkScore: null,
        maxCostUsdPerRun: null,
        maxCostUsdPerMonth: null,
      }),
      skills: Object.freeze({}),
    }),
    // Deployment-owned non-action categories (conversation/control) — the ONLY
    // way a non-skill message bypasses the fail-closed gate. Default empty: a
    // deployment must declare its own (see intent-categories.js).
    nonActionCategories: Object.freeze([]),
    // Microsoft Graph /me/calendarView grounding port for meeting-prep. The
    // transport is an explicitly configured, deployment-owned SUBPROCESS BRIDGE
    // (bridge.command = the vault-backed calendar_bridge.py executable); the
    // plugin holds no Graph credentials, so it is disabled by default and fails
    // CLOSED (clarify, never fabricate) when disabled or when no bridge command
    // is configured. No model instruction substitutes for this call.
    calendar: Object.freeze({
      enabled: false,
      timeoutMs: 8000,
      bridge: Object.freeze({
        command: "",
        args: Object.freeze([]),
        cwd: "",
        env: Object.freeze({}),
        accountArg: "",
        maxResults: 25,
      }),
    }),
    ownerTimezone: "America/New_York",
    // Canary scope — ACTIVE routing/education only for matching trusted hook
    // identities; every other turn stays shadow/passthrough (see scope.js).
    scope: Object.freeze({
      enabled: false,
      allowGlobal: false,
      requireOwner: true,
      channels: Object.freeze([]),
      accountIds: Object.freeze([]),
      senderIds: Object.freeze([]),
      chatIds: Object.freeze([]),
      sessionKeys: Object.freeze([]),
      ownerSenderIds: Object.freeze([]),
    }),
  }),
});

export function normalizeConfig(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const logging = r.logging && typeof r.logging === "object" ? r.logging : {};
  const intelligence = r.intelligence && typeof r.intelligence === "object" ? r.intelligence : {};
  const features = r.features && typeof r.features === "object" ? r.features : {};
  const audit = r.audit && typeof r.audit === "object" ? r.audit : {};

  return {
    mode: VALID_MODES.includes(r.mode) ? r.mode : DEFAULTS.mode,
    logging: {
      enabled: logging.enabled !== false,
      path:
        typeof logging.path === "string" && logging.path.length > 0
          ? logging.path
          : DEFAULTS.logging.path,
      rotateSizeMb:
        Number.isFinite(logging.rotateSizeMb) && logging.rotateSizeMb >= 1
          ? Math.floor(logging.rotateSizeMb)
          : DEFAULTS.logging.rotateSizeMb,
    },
    configuredRoutes:
      r.configuredRoutes && typeof r.configuredRoutes === "object"
        ? { ...r.configuredRoutes }
        : {},
    cheapHeuristic: normalizeCheapHeuristic(r.cheapHeuristic),
    familyResolution: normalizeFamilyResolution(r.familyResolution),
    intelligence: {
      enabled: intelligence.enabled !== false,
      path:
        typeof intelligence.path === "string" && intelligence.path.length > 0
          ? intelligence.path
          : DEFAULTS.intelligence.path,
      registryPath:
        typeof intelligence.registryPath === "string" && intelligence.registryPath.length > 0
          ? intelligence.registryPath
          : "",
      skillProfilesPath:
        typeof intelligence.skillProfilesPath === "string" && intelligence.skillProfilesPath.length > 0
          ? intelligence.skillProfilesPath
          : "",
      shadow: intelligence.shadow === true,
      fallbackOnError: intelligence.fallbackOnError !== false,
      allowReleaseCandidate: intelligence.allowReleaseCandidate === true,
    },
    features: {
      routing: normalizeFeatureEntry(features.routing, DEFAULTS.features.routing),
      ownerOverrideAsk: normalizeFeatureEntry(features.ownerOverrideAsk, DEFAULTS.features.ownerOverrideAsk),
      costVisibility: normalizeFeatureEntry(features.costVisibility, DEFAULTS.features.costVisibility),
      governedEscalation: normalizeFeatureEntry(features.governedEscalation, DEFAULTS.features.governedEscalation),
      skillRouting: normalizeFeatureEntry(features.skillRouting, DEFAULTS.features.skillRouting),
    },
    audit: {
      enabled: audit.enabled !== false,
      path:
        typeof audit.path === "string" && audit.path.length > 0
          ? audit.path
          : DEFAULTS.audit.path,
      rotateSizeMb:
        Number.isFinite(audit.rotateSizeMb) && audit.rotateSizeMb >= 1
          ? Math.floor(audit.rotateSizeMb)
          : DEFAULTS.audit.rotateSizeMb,
    },
    ownerOverride: normalizeOwnerOverrideEntry(r.ownerOverride),
    costVisibility: normalizeCostVisibility(r.costVisibility),
    governedEscalation: normalizeGovernedEscalation(r.governedEscalation),
    skillRouting: normalizeSkillRouting(r.skillRouting),
  };
}

function normalizeSkillCatalog(raw) {
  if (!Array.isArray(raw)) return [];
  const idRe = /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,127}$/;
  const out = [];
  for (const item of raw.slice(0, 128)) {
    const entry = typeof item === "string" ? { id: item } : (item && typeof item === "object" ? item : null);
    if (!entry) continue;
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    if (!idRe.test(id)) continue;
    const aliases = Array.isArray(entry.aliases)
      ? [...new Set(entry.aliases.map((a) => String(a).trim()).filter(Boolean))].slice(0, 16)
      : [];
    out.push({
      id,
      ...(aliases.length ? { aliases } : {}),
      ...(typeof entry.version === "string" && entry.version.trim() ? { version: entry.version.trim() } : {}),
      ...(typeof entry.fingerprint === "string" && entry.fingerprint.trim() ? { fingerprint: entry.fingerprint.trim() } : {}),
      ...(typeof entry.execution_class === "string" && entry.execution_class.trim() ? { execution_class: entry.execution_class.trim() } : {}),
    });
  }
  return out;
}

function normalizeClassifier(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const d = DEFAULTS.skillRouting.classifier;
  const provider = typeof r.provider === "string" && r.provider.trim() ? r.provider.trim() : d.provider;
  const model = typeof r.model === "string" && r.model.trim() ? r.model.trim() : d.model;
  return {
    // Enabled ONLY when a model is pinned — an "enabled" classifier with no model
    // would be a silent no-op, so we treat it as off (fail-safe, never guess).
    enabled: r.enabled === true && Boolean(model),
    provider,
    model,
    endpoint: typeof r.endpoint === "string" && r.endpoint.trim() ? r.endpoint.trim() : d.endpoint,
    confidenceThreshold: Number.isFinite(r.confidenceThreshold) && r.confidenceThreshold >= 0 && r.confidenceThreshold <= 1
      ? r.confidenceThreshold : d.confidenceThreshold,
    ambiguityGap: Number.isFinite(r.ambiguityGap) && r.ambiguityGap >= 0 && r.ambiguityGap <= 1
      ? r.ambiguityGap : d.ambiguityGap,
    timeoutMs: Number.isFinite(r.timeoutMs) && r.timeoutMs >= 250 && r.timeoutMs <= 60000
      ? Math.floor(r.timeoutMs) : d.timeoutMs,
    // Hard-bounded context window; out-of-range or missing falls back to the
    // catalog-sufficient default so a misconfig can never shrink it below usable.
    numCtx: Number.isFinite(r.numCtx) && r.numCtx >= 2048 && r.numCtx <= 32768
      ? Math.floor(r.numCtx) : d.numCtx,
    // These are locked by contract: a resolution classifier must stay minimal +
    // light-context and never carry tools/task authority.
    promptMode: "minimal",
    lightContext: true,
  };
}

// Deployment-owned subprocess calendar bridge. command is the vault-backed
// executable (e.g. python3 + calendar_bridge.py); args/cwd/env/accountArg are
// operator-set. An empty command leaves the port UNWIRED (fails closed).
// Per-skill bounded-child tool policy map. Skill ids are validated; each entry
// yields { allowedTools?:string[], maxToolCalls?:int, disableTools?:bool }.
function normalizeSkillTools(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const idRe = /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,127}$/;
  const out = {};
  for (const [id, value] of Object.entries(raw).slice(0, 128)) {
    if (!idRe.test(id) || !value || typeof value !== "object") continue;
    const entry = {};
    if (Array.isArray(value.allowedTools)) {
      const tools = [...new Set(value.allowedTools.map((t) => (typeof t === "string" ? t.trim() : "")).filter(Boolean))].slice(0, 128);
      entry.allowedTools = tools;
    }
    if (Number.isFinite(value.maxToolCalls) && value.maxToolCalls >= 0) entry.maxToolCalls = Math.floor(value.maxToolCalls);
    if (value.disableTools === true) entry.disableTools = true;
    if (Object.keys(entry).length > 0) out[id] = entry;
  }
  return out;
}

// DEPLOYMENT-OWNED per-skill execution identity. Keyed by a valid skill id; each
// entry is a bounded set of identity/policy STRINGS (mailbox/account, sender
// identity, authority, send policy, label) — never a credential. Control chars are
// stripped and each field is length-bounded so a hostile value cannot inject an
// unbounded block into the child prompt. skill-contracts.js re-sanitizes as
// defense in depth. Empty/malformed entries are dropped.
function normalizeSkillIdentities(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const idRe = /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,127}$/;
  const clean = (value, max) => {
    if (typeof value !== "string") return "";
    let out = "";
    for (const ch of value) {
      const code = ch.codePointAt(0);
      out += (code < 0x20 || code === 0x7f) ? " " : ch;
    }
    return out.replace(/\s+/g, " ").trim().slice(0, max);
  };
  const out = {};
  for (const [id, value] of Object.entries(raw).slice(0, 128)) {
    if (!idRe.test(id) || !value || typeof value !== "object" || Array.isArray(value)) continue;
    const entry = {};
    const mailbox = clean(value.mailbox, 600);
    const senderIdentity = clean(value.senderIdentity, 600);
    const authority = clean(value.authority, 600);
    const sendPolicy = clean(value.sendPolicy, 600);
    const label = clean(value.label, 80);
    if (mailbox) entry.mailbox = mailbox;
    if (senderIdentity) entry.senderIdentity = senderIdentity;
    if (authority) entry.authority = authority;
    if (sendPolicy) entry.sendPolicy = sendPolicy;
    if (label) entry.label = label;
    // Require at least one substantive field beyond a bare label.
    if (mailbox || senderIdentity || authority || sendPolicy) out[id] = entry;
  }
  return out;
}

function normalizeCalendarBridge(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const d = DEFAULTS.skillRouting.calendar.bridge;
  const command = typeof r.command === "string" && r.command.trim() ? r.command.trim() : d.command;
  const args = Array.isArray(r.args)
    ? r.args.filter((a) => typeof a === "string").slice(0, 64)
    : [...d.args];
  const cwd = typeof r.cwd === "string" && r.cwd.trim() ? r.cwd.trim() : d.cwd;
  const accountArg = typeof r.accountArg === "string" && r.accountArg.trim() ? r.accountArg.trim() : d.accountArg;
  const maxResults = Number.isFinite(r.maxResults) && r.maxResults >= 1 && r.maxResults <= 100
    ? Math.floor(r.maxResults) : d.maxResults;
  const env = {};
  if (r.env && typeof r.env === "object" && !Array.isArray(r.env)) {
    for (const [key, value] of Object.entries(r.env)) {
      if (typeof key === "string" && key && typeof value === "string") env[key] = value;
    }
  }
  return { command, args, cwd, env, accountArg, maxResults };
}

// LIVE cloud-spend snapshot consumption settings. localProviders defaults back to
// the shipped set when a deployment clears it (an empty set would classify every
// missing-cost row as cloud and needlessly fail closed).
function normalizeSpend(raw, defaults) {
  const r = raw && typeof raw === "object" ? raw : {};
  const d = defaults;
  const delta = r.delta && typeof r.delta === "object" ? r.delta : {};
  const localProviders = Array.isArray(r.localProviders)
    ? [...new Set(r.localProviders.map((p) => String(p).trim().toLowerCase()).filter(Boolean))].slice(0, 32)
    : [...d.localProviders];
  return {
    enabled: r.enabled === true,
    snapshotPath: typeof r.snapshotPath === "string" && r.snapshotPath.trim() ? r.snapshotPath.trim() : d.snapshotPath,
    maxAgeHours: Number.isFinite(r.maxAgeHours) && r.maxAgeHours >= 1 ? Math.floor(r.maxAgeHours) : d.maxAgeHours,
    timezone: typeof r.timezone === "string" && r.timezone.trim() ? r.timezone.trim() : "",
    localProviders: localProviders.length ? localProviders : [...d.localProviders],
    finiteCloudBudgetApplies: r.finiteCloudBudgetApplies === true,
    delta: {
      enabled: delta.enabled === true,
      costLogPath: typeof delta.costLogPath === "string" && delta.costLogPath.trim() ? delta.costLogPath.trim() : "",
      maxBytes: Number.isFinite(delta.maxBytes) && delta.maxBytes >= 65536 ? Math.floor(delta.maxBytes) : d.delta.maxBytes,
    },
  };
}

function normalizeSkillRouting(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const defaults = DEFAULTS.skillRouting;
  return {
    pendingStatePath: typeof r.pendingStatePath === "string" && r.pendingStatePath.length > 0
      ? r.pendingStatePath : defaults.pendingStatePath,
    artifactStagingRoot: typeof r.artifactStagingRoot === "string" && r.artifactStagingRoot.length > 0
      ? r.artifactStagingRoot : defaults.artifactStagingRoot,
    pendingTtlMinutes: Number.isFinite(r.pendingTtlMinutes) && r.pendingTtlMinutes >= 1
      ? Math.floor(r.pendingTtlMinutes) : defaults.pendingTtlMinutes,
    defaultEstimatedTokens: Number.isFinite(r.defaultEstimatedTokens) && r.defaultEstimatedTokens >= 1
      ? Math.floor(r.defaultEstimatedTokens) : defaults.defaultEstimatedTokens,
    executionTimeoutSeconds: Number.isFinite(r.executionTimeoutSeconds) && r.executionTimeoutSeconds >= 30 && r.executionTimeoutSeconds <= 3600
      ? Math.floor(r.executionTimeoutSeconds) : defaults.executionTimeoutSeconds,
    monthlyCloudSpendUsd: Number.isFinite(r.monthlyCloudSpendUsd) && r.monthlyCloudSpendUsd >= 0
      ? r.monthlyCloudSpendUsd : defaults.monthlyCloudSpendUsd,
    spend: normalizeSpend(r.spend, defaults.spend),
    maxChildTokens: Number.isFinite(r.maxChildTokens) && r.maxChildTokens >= 1000
      ? Math.floor(r.maxChildTokens) : defaults.maxChildTokens,
    maxChildCostUsd: Number.isFinite(r.maxChildCostUsd) && r.maxChildCostUsd >= 0
      ? r.maxChildCostUsd : defaults.maxChildCostUsd,
    maxChildToolCalls: Number.isFinite(r.maxChildToolCalls) && r.maxChildToolCalls >= 0
      ? Math.floor(r.maxChildToolCalls) : defaults.maxChildToolCalls,
    skillTools: normalizeSkillTools(r.skillTools),
    skillIdentities: normalizeSkillIdentities(r.skillIdentities),
    resolverMode: r.resolverMode === "off" ? "off" : "deterministic",
    ambiguityPolicy: r.ambiguityPolicy === "fail" ? "fail" : "clarify",
    useSnapshotInventory: r.useSnapshotInventory !== false,
    inventorySnapshotPath: typeof r.inventorySnapshotPath === "string" && r.inventorySnapshotPath.length > 0
      ? r.inventorySnapshotPath : defaults.inventorySnapshotPath,
    inventoryMarkerPath: typeof r.inventoryMarkerPath === "string" && r.inventoryMarkerPath.length > 0
      ? r.inventoryMarkerPath : defaults.inventoryMarkerPath,
    inventoryMaxAgeHours: Number.isFinite(r.inventoryMaxAgeHours) && r.inventoryMaxAgeHours >= 1
      ? Math.floor(r.inventoryMaxAgeHours) : defaults.inventoryMaxAgeHours,
    skillCatalog: normalizeSkillCatalog(r.skillCatalog),
    classifier: normalizeClassifier(r.classifier),
    intentRecipes: normalizeIntentRecipes(r.intentRecipes),
    clarifyOnMultiSkill: r.clarifyOnMultiSkill === true,
    skillRequirements: normalizeSkillRequirements(r.skillRequirements),
    nonActionCategories: normalizeNonActionCategories(r.nonActionCategories),
    calendar: {
      enabled: r.calendar?.enabled === true,
      timeoutMs: Number.isFinite(r.calendar?.timeoutMs) && r.calendar.timeoutMs >= 1000 && r.calendar.timeoutMs <= 60000
        ? Math.floor(r.calendar.timeoutMs) : defaults.calendar.timeoutMs,
      bridge: normalizeCalendarBridge(r.calendar?.bridge),
    },
    ownerTimezone: typeof r.ownerTimezone === "string" && r.ownerTimezone.trim()
      ? r.ownerTimezone.trim() : defaults.ownerTimezone,
    scope: normalizeScope(r.scope),
  };
}

function normalizeNonActionCategories(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw.slice(0, 32)) {
    if (!item || typeof item !== "object") continue;
    const id = typeof item.id === "string" && item.id.trim() ? item.id.trim() : "";
    if (!id) continue;
    const phrases = Array.isArray(item.phrases)
      ? [...new Set(item.phrases.map((p) => String(p).trim()).filter(Boolean))].slice(0, 256)
      : [];
    const patterns = Array.isArray(item.patterns)
      ? [...new Set(item.patterns.map((p) => String(p).trim()).filter((p) => p && p.length <= 256))].slice(0, 64)
      : [];
    if (phrases.length === 0 && patterns.length === 0) continue;
    out.push({ id, ...(phrases.length ? { phrases } : {}), ...(patterns.length ? { patterns } : {}) });
  }
  return out;
}

function normalizeGovernedEscalation(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const validTier = (value) => ["general_purpose", "tool_calling_strong", "terminal_capable", "flagship_reasoning"].includes(value);
  return {
    localModel: typeof r.localModel === "string" ? r.localModel.trim() : "",
    localTiers: Array.isArray(r.localTiers) ? [...new Set(r.localTiers.filter(validTier))] : [...DEFAULTS.governedEscalation.localTiers],
    approvalTiers: Array.isArray(r.approvalTiers) ? [...new Set(r.approvalTiers.filter(validTier))] : [...DEFAULTS.governedEscalation.approvalTiers],
    ttlMinutes: Number.isFinite(r.ttlMinutes) && r.ttlMinutes >= 1 ? Math.floor(r.ttlMinutes) : DEFAULTS.governedEscalation.ttlMinutes,
    statePath: typeof r.statePath === "string" && r.statePath.length > 0 ? r.statePath : DEFAULTS.governedEscalation.statePath,
    externalDataNotice: typeof r.externalDataNotice === "string" && r.externalDataNotice.length > 0
      ? r.externalDataNotice
      : DEFAULTS.governedEscalation.externalDataNotice,
    approvalLanguage: {
      affirmative: normalizePhraseList(r.approvalLanguage?.affirmative, DEFAULTS.governedEscalation.approvalLanguage.affirmative),
      negative: normalizePhraseList(r.approvalLanguage?.negative, DEFAULTS.governedEscalation.approvalLanguage.negative),
    },
    displayNames: {
      providers: normalizeDisplayNames(r.displayNames?.providers),
      models: normalizeDisplayNames(r.displayNames?.models),
    },
  };
}

function normalizePhraseList(value, fallback) {
  if (!Array.isArray(value) || value.length === 0) return [...fallback];
  const phrases = [...new Set(value.map((item) => String(item).trim()).filter((item) => (
    item && item
      .toLowerCase()
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/[.,!?;:]+/g, " ")
      .trim()
  )))];
  return phrases.length > 0 ? phrases : [...fallback];
}

function normalizeDisplayNames(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const names = {};
  for (const [key, label] of Object.entries(value)) {
    if (typeof label === "string" && label.trim()) names[key] = label.trim();
  }
  return names;
}

function normalizeFamilyResolution(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const aliases = {};
  if (r.aliases && typeof r.aliases === "object" && !Array.isArray(r.aliases)) {
    for (const [name, value] of Object.entries(r.aliases)) {
      if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(name) || !value || typeof value !== "object") continue;
      const providers = Array.isArray(value.providers)
        ? [...new Set(value.providers.map((item) => String(item).trim().toLowerCase()).filter((item) => /^[a-z0-9][a-z0-9_-]{0,31}$/.test(item)))]
        : [];
      const family = typeof value.family === "string" ? value.family.trim().toLowerCase() : "";
      if (!family || providers.length === 0) continue;
      aliases[name] = {
        family,
        providers,
        strategy: value.strategy === "newest" ? "newest" : "lowest_cost",
        ...(Array.isArray(value.acceptedModels) ? {
          acceptedModels: [...new Set(value.acceptedModels
            .map((item) => String(item).trim().toLowerCase())
            .filter((item) => /^[^/\s]+\/[^/\s]+$/.test(item)))],
        } : {}),
        ...(Number.isFinite(value.maxInputPerM) && value.maxInputPerM > 0 ? { maxInputPerM: value.maxInputPerM } : {}),
        ...(Number.isFinite(value.maxOutputPerM) && value.maxOutputPerM > 0 ? { maxOutputPerM: value.maxOutputPerM } : {}),
      };
    }
  }
  return {
    enabled: r.enabled === true,
    catalogPath: typeof r.catalogPath === "string" && r.catalogPath.length > 0 ? r.catalogPath : DEFAULTS.familyResolution.catalogPath,
    maxAgeHours: Number.isFinite(r.maxAgeHours) && r.maxAgeHours >= 1 ? r.maxAgeHours : DEFAULTS.familyResolution.maxAgeHours,
    aliases,
    hostPlan: normalizeFamilyHostPlan(r.hostPlan, aliases),
  };
}

function normalizeFamilyHostPlan(raw, aliases) {
  const r = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const validAlias = (value) => typeof value === "string" && Object.hasOwn(aliases, value);
  const primary = validAlias(r.primary) ? r.primary : "";
  const fallbacks = Array.isArray(r.fallbacks)
    ? [...new Set(r.fallbacks.filter(validAlias))].filter((alias) => alias !== primary)
    : [];
  return { primary, fallbacks };
}

function normalizeCostVisibility(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const attribution = r.attribution && typeof r.attribution === "object" ? r.attribution : {};
  const log = r.log && typeof r.log === "object" ? r.log : {};
  const pricing = r.pricing && typeof r.pricing === "object" ? r.pricing : {};
  const D = DEFAULTS.costVisibility;
  return {
    attribution: {
      deploymentId: normalizeAttributionId(attribution.deploymentId),
      costCenter: normalizeAttributionId(attribution.costCenter),
    },
    log: {
      enabled: log.enabled !== false,
      path: typeof log.path === "string" && log.path.length > 0 ? log.path : D.log.path,
      rotateSizeMb:
        Number.isFinite(log.rotateSizeMb) && log.rotateSizeMb >= 1
          ? Math.floor(log.rotateSizeMb)
          : D.log.rotateSizeMb,
    },
    pricing: {
      sourceUrl:
        typeof pricing.sourceUrl === "string" && pricing.sourceUrl.length > 0
          ? pricing.sourceUrl
          : D.pricing.sourceUrl,
      cachePath:
        typeof pricing.cachePath === "string" && pricing.cachePath.length > 0
          ? pricing.cachePath
          : D.pricing.cachePath,
      refreshHours:
        Number.isFinite(pricing.refreshHours) && pricing.refreshHours >= 1
          ? pricing.refreshHours
          : D.pricing.refreshHours,
      timeoutMs:
        Number.isFinite(pricing.timeoutMs) && pricing.timeoutMs >= 1000
          ? Math.floor(pricing.timeoutMs)
          : D.pricing.timeoutMs,
      userPriceOverridePath:
        typeof pricing.userPriceOverridePath === "string" ? pricing.userPriceOverridePath : "",
      // Cache-token proxy multipliers (applied to input rate only when the
      // source lacks explicit cache-tier rates). Reconciles the cost log and the
      // owner receipt onto one calculation; defaults documented in pricing.js.
      cacheReadMultiplier:
        Number.isFinite(pricing.cacheReadMultiplier) && pricing.cacheReadMultiplier >= 0
          ? pricing.cacheReadMultiplier : 0.25,
      cacheWriteMultiplier:
        Number.isFinite(pricing.cacheWriteMultiplier) && pricing.cacheWriteMultiplier >= 0
          ? pricing.cacheWriteMultiplier : 1.0,
    },
    summaryEveryCalls:
      Number.isFinite(r.summaryEveryCalls) && r.summaryEveryCalls >= 1
        ? Math.floor(r.summaryEveryCalls)
        : D.summaryEveryCalls,
  };
}

// Billing attribution is deliberately a small, non-secret identifier surface.
// Restrict values to portable slugs so names, email addresses, paths, tokens,
// or other customer data cannot accidentally enter the local usage ledger.
function normalizeAttributionId(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9._-]{0,63}$/.test(trimmed) ? trimmed : "";
}

function normalizeCheapHeuristic(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const out = { default: "", order: [] };
  if (typeof r.default === "string") out.default = r.default;
  if (Array.isArray(r.order)) out.order = r.order.filter((x) => typeof x === "string" && x.length > 0);
  return out;
}

function normalizeOwnerOverrideEntry(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  return {
    enabled: r.enabled === true,
    statePath:
      typeof r.statePath === "string" && r.statePath.length > 0
        ? r.statePath
        : DEFAULTS.ownerOverride.statePath,
    askConsumer:
      typeof r.askConsumer === "string" && r.askConsumer.length > 0
        ? r.askConsumer
        : DEFAULTS.ownerOverride.askConsumer,
  };
}

function normalizeFeatureEntry(entry, fallback) {
  if (!entry || typeof entry !== "object") return { enabled: fallback.enabled };
  if (entry.enabled === true || entry.enabled === false) return { enabled: entry.enabled };
  return { enabled: fallback.enabled };
}
