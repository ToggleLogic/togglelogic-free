/*
 * ToggleLogic (Free Tier) — permanent per-skill execution contracts.
 * (c) 2026 Motherboard, Inc. Source-available under the ToggleLogic Free-Tier
 * License (see LICENSE). PATENT PENDING.
 *
 * When ToggleLogic routes a resolved skill through the bounded child, it OWNS
 * that execution and therefore can attach a durable execution contract to it —
 * without editing the external skill package. Two enforcement layers:
 *
 *   1. Deterministic PREFLIGHT (this process): for a meeting/calendar turn we
 *      check the owner-local clock and, when a calendar port is wired, the
 *      authoritative calendar, BEFORE any route/model education or spend. A past
 *      / unverifiable meeting reference is answered with a bounded clarification
 *      — never a fabricated brief.
 *   2. Bounded-child CONTRACT (the model): the contract text below is injected
 *      into the routed child's system prompt so the model executes under the
 *      same rules (Outlook via Microsoft Graph is authoritative; Zoom only
 *      after; never synthesize an event from history).
 *
 * APPLICABILITY IS INTENT-AWARE AND SKILL-AWARE (1.6.1-rc.2 correction). The
 * incident skill id "meeting-prep" is NOT installed on the reference host; a
 * natural-language meeting/calendar request there resolves to the ELIGIBLE
 * "microsoft-graph" skill (the authoritative Outlook/Graph calendar) and/or
 * "zoom-meetings" (subordinate recordings, never a calendar). Binding the
 * contract to the absent id alone would leave that real path ungoverned. So the
 * contract now applies when the turn shows a calendar/meeting INTENT AND resolves
 * to a calendar-capable installed skill — while GENERIC Graph email/contact work
 * (no meeting intent) is deliberately left untouched. A meeting/calendar request
 * that resolved ONLY to a subordinate skill (Zoom, no authoritative Outlook/Graph
 * in the route) cannot establish an event and is clarified deterministically.
 *
 * The 2026-09-15 incident was "Prepare me for my 2 pm meeting…" sent at 16:03
 * owner-local — a meeting already in the past — which was answered with an
 * inline briefing on a fat main session. This contract makes that outcome a
 * clarification instead, whether the request routes through meeting-prep,
 * microsoft-graph, or a microsoft-graph + zoom-meetings composition.
 *
 * EXPLICIT-INSPECTION PRECEDENCE (1.6.1-rc.4 correction). The past-meeting
 * short-circuit above is a COST-SAVING guard for an AMBIGUOUS prep request whose
 * referenced time has passed — not a blanket ban on ever consulting a past time.
 * A request that EXPLICITLY directs SAM to inspect/check/search/query the Outlook
 * calendar via Microsoft Graph ("Check my Outlook calendar using Microsoft Graph
 * and tell me whether I had a 2 pm meeting today") is asking for exactly the
 * authoritative verification the contract exists to protect, so it must PROCEED
 * through the Microsoft Graph skill/bridge — under the same contract — rather than
 * be clarified away merely because 2 pm is in the past. The narrow precedence rule
 * (detectCalendarInspectionIntent + an authoritative Graph calendar in the route)
 * lets prompt B proceed while the ordinary prep prompt A still short-circuits.
 */

const MEETING_CALENDAR_CONTRACT = [
  "MEETING / CALENDAR EXECUTION CONTRACT (mandatory, non-negotiable):",
  "1. First determine the CURRENT date and time in the owner's timezone before doing anything else.",
  "2. Microsoft Outlook via Microsoft Graph is the ONE AUTHORITATIVE calendar. A meeting exists only if it is on that Outlook calendar. Do not treat chat history, memory, Zoom, or any other source as the calendar.",
  "3. If the referenced meeting is in the past, is not on the Outlook calendar, or is ambiguous, STOP and ask the owner to clarify. Do not prepare a brief for an unverified or past meeting.",
  "4. NEVER synthesize, infer, or invent a calendar event from conversation history, assumptions, or prior context.",
  "5. Only AFTER confirming the meeting on Outlook may you use Zoom history (recordings/transcripts of prior related meetings) as supplementary context. Zoom alone can never establish that a meeting exists.",
  "6. If Microsoft Graph / Outlook is not actually callable, say so plainly and ask how to proceed — do not fabricate a calendar, attendees, or agenda.",
].join("\n");

const ZOOM_HISTORY_EVIDENCE_CONTRACT = [
  "ZOOM HISTORY EVIDENCE CONTRACT (mandatory when zoom-meetings is planned):",
  "1. After Microsoft Graph confirms the unique Outlook event, perform an actual Zoom API/search/list operation using the verified event title, client name, or attendees to look for relevant prior recordings, transcripts, or summaries.",
  "2. Reading the zoom-meetings skill instructions is preparation, not a Zoom history search.",
  "3. You may state that no relevant Zoom history was found only after a successful Zoom search returned no relevant result.",
  "4. If Zoom is unavailable, authentication fails, or the search cannot be completed, state that Zoom history was not checked. Never convert an unperformed or failed search into a negative finding.",
].join("\n");

const POWERPOINT_EDITOR_CONTRACT = [
  "POWERPOINT EDITING EXECUTION CONTRACT (mandatory, non-negotiable):",
  "1. Preserve the source presentation unchanged and write the result to a new output file unless the owner explicitly requests an in-place edit.",
  "2. Create and verify output PPTX and companion teleprompter files only in the per-run staging directory supplied by ToggleLogic. Do not attempt the final destination write; return the required delivery manifest so the trusted parent can copy verified bytes to destinations explicitly named by the owner.",
  "3. When adding the requested speaking scripts to slide notes, use this exact order: 3-MINUTE SCRIPT first, 6-MINUTE SCRIPT second, and ORIGINAL NOTES last at the bottom.",
  "4. Compute word counts from the FINAL text actually written to the output. Compute duration from that verified word count and the stated words-per-minute rate; never estimate or repeat a draft count as though it were measured.",
  "5. Reopen the saved PPTX and verify slide count, note order/content, output-file integrity, and companion text files. Render and inspect the edited presentation when the task requires visual QA.",
  "6. Do not claim final delivery or completion when any required verification tool call was denied, failed, or skipped. Never speculate about final-destination permissions; only the trusted parent performs and verifies delivery.",
].join("\n");

const QUICKBOOKS_ONLINE_CONTRACT = [
  "QUICKBOOKS ONLINE EXECUTION CONTRACT (mandatory, non-negotiable):",
  "1. Treat financial reads as source-grounded work: query QuickBooks Online and never manufacture balances, customers, invoices, dates, or company names from conversation history.",
  "2. Keep every QBO realm legally and structurally separate. A cross-company summary may compare separately labeled results, but must never merge ledgers or imply that one realm is another.",
  "3. For an A/R aging request covering all configured companies, use the deterministic one-command fast path: python3 skills/quickbooks-online/main.py --action aged_receivables_all --start-date YYYY-MM-DD --end-date YYYY-MM-DD. Resolve the requested date first, then make this ONE tool call; do not make separate per-company tool calls.",
  "4. The report command performs credential refresh and a live authentication preflight internally for each realm. Do not run a separate healthcheck before a normal report unless the report itself returns a verified authentication failure.",
  "5. All report dates must be explicit ISO dates. If the owner's requested period is ambiguous, ask for clarification instead of guessing.",
  "6. Remain read-only unless the owner explicitly asks for a specific mutation. Clearly distinguish verified QBO facts from recommendations or prioritization judgments.",
].join("\n");

export const BUILTIN_CONTRACTS = Object.freeze({
  "meeting-prep": Object.freeze({ timeSensitive: true, contract: MEETING_CALENDAR_CONTRACT }),
  "powerpoint-editor": Object.freeze({ timeSensitive: false, contract: POWERPOINT_EDITOR_CONTRACT }),
  "quickbooks-online": Object.freeze({ timeSensitive: false, contract: QUICKBOOKS_ONLINE_CONTRACT }),
});

// The ELIGIBLE calendar-capable skills on the reference host. AUTHORITATIVE =
// the Outlook calendar via Microsoft Graph (a meeting is real only if it is
// there). SUBORDINATE = meeting-adjacent skills that are NOT a calendar (Zoom
// recordings/transcripts); their presence alone can never confirm an event.
// Deployment-overridable via createSkillContracts({ calendarSkillIds,
// meetingSubordinateSkillIds }).
const DEFAULT_AUTHORITATIVE_CALENDAR_SKILLS = Object.freeze(["microsoft-graph"]);
const DEFAULT_SUBORDINATE_MEETING_SKILLS = Object.freeze(["zoom-meetings"]);

// Artifact editing requires a complete inspect → edit → render → verify loop.
// The 12-call presentation policy observed in RC3 exhausted during rendering and
// denied four verification calls. The RC5 canary then used all 24 calls to reach
// a truthful timing failure and had its single corrective edit denied before it
// could re-apply and re-verify. Thirty-two is still a hard bounded workflow: it
// covers inspection, edit/write, render/visual QA, reopen/content verification,
// and one correction/reverification cycle. The deployment-wide ceiling always
// wins when configured lower, so this floor never expands global authority.
export const BUILTIN_WORKFLOW_TOOL_CALL_FLOORS = Object.freeze({
  "powerpoint-editor": 32,
});

// Deterministic calendar/meeting INTENT. High-precision, meeting/calendar
// vocabulary ONLY — it must NOT fire on generic Graph email/contact work
// ("send an email", "look up a contact"), so the calendar contract never gates
// non-calendar Graph tasks. Not a task→skill guess; only a topical gate applied
// AFTER a calendar-capable skill has already resolved.
const MEETING_INTENT_RE = /\b(?:meetings?|calendars?|appointments?|agenda|stand[-\s]?up|one[-\s]on[-\s]one|1:1|debriefs?|reschedul(?:e|ed|ing))\b/i;

export function detectMeetingIntent(text) {
  return MEETING_INTENT_RE.test(String(text || ""));
}

// EXPLICIT calendar-INSPECTION intent (1.6.1-rc.4 precedence correction). An owner
// who explicitly directs SAM to INSPECT / CHECK / SEARCH / QUERY the Outlook
// calendar via Microsoft Graph is telling it to consult the ONE authoritative
// source and report the truth. That is NOT the ambiguous meeting-PREP request the
// cost-saving past-meeting short-circuit was built for, so it must NOT be
// short-circuited merely because the referenced clock time has already passed — it
// must proceed through the Microsoft Graph skill/bridge (which still executes under
// the meeting/calendar contract, so it never fabricates an event and reports the
// authoritative calendar truthfully, whether the meeting existed or not).
//
// High-precision by construction: requires BOTH (a) an explicit inspection verb AND
// (b) an explicit Outlook / Microsoft Graph / calendar target. An ordinary prep
// request ("prepare me for my 2 pm meeting", "get me ready for my 2 pm") carries
// NEITHER an inspection verb nor a calendar/Graph object, so it still takes the
// deterministic clarification. This is a topical precedence gate applied only AFTER
// a calendar-capable authoritative skill has already resolved; it never guesses a
// route.
const CALENDAR_INSPECT_VERB_RE = /\b(?:check(?:s|ed|ing)?|inspect(?:s|ed|ing)?|search(?:es|ed|ing)?|quer(?:y|ies|ied|ying)|look(?:s|ed|ing)?\s+(?:up|at|into)|verif(?:y|ies|ied|ying)|confirm(?:s|ed|ing)?|pull(?:s|ed|ing)?\s+up|review(?:s|ed|ing)?|read|tell\s+me\s+(?:whether|if)|find\s+out|did\s+i\s+have|do\s+i\s+have)\b/i;
const CALENDAR_INSPECT_TARGET_RE = /\b(?:outlook|microsoft\s+graph|ms\s+graph|graph\s+api|graph|calendars?|my\s+schedule)\b/i;

export function detectCalendarInspectionIntent(text) {
  const value = String(text || "");
  return CALENDAR_INSPECT_VERB_RE.test(value) && CALENDAR_INSPECT_TARGET_RE.test(value);
}

function normalizeIdList(value, fallback) {
  const list = (Array.isArray(value) ? value : [])
    .map((item) => cleanString(item))
    .filter(Boolean);
  return list.length ? [...new Set(list)] : [...fallback];
}

function cleanString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

// Owner-local wall-clock parts for an absolute instant, using the IANA tz.
function localParts(nowMs, timeZone) {
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
    });
    const parts = {};
    for (const part of fmt.formatToParts(new Date(nowMs))) parts[part.type] = part.value;
    return {
      year: Number(parts.year),
      month: Number(parts.month),
      day: Number(parts.day),
      hour: parts.hour === "24" ? 0 : Number(parts.hour),
      minute: Number(parts.minute),
      weekday: String(parts.weekday || "").toLowerCase(),
    };
  } catch {
    const d = new Date(nowMs);
    return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate(), hour: d.getHours(), minute: d.getMinutes(), weekday: "" };
  }
}

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/**
 * Parse a bounded meeting-time reference. Returns null when no explicit clock
 * time is present (nothing to validate deterministically), else
 * { minutes, hasFutureQualifier, hasPastQualifier, raw }.
 */
export function parseMeetingReference(text) {
  const raw = String(text || "");
  const lower = raw.toLowerCase();

  let minutes = null;
  const ampm = lower.match(/\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)\b/);
  if (ampm) {
    let hour = Number(ampm[1]) % 12;
    if (/p/.test(ampm[3])) hour += 12;
    minutes = hour * 60 + (ampm[2] ? Number(ampm[2]) : 0);
  } else {
    const h24 = lower.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
    if (h24) minutes = Number(h24[1]) * 60 + Number(h24[2]);
  }
  if (minutes === null) return null;

  const hasFutureQualifier = /\b(tomorrow|later|upcoming|next\s+\w+|this\s+(?:afternoon|evening)|tonight|in\s+\d+\s+(?:hours?|minutes?))\b/.test(lower)
    || WEEKDAYS.some((day) => new RegExp(`\\b(?:next|this)\\s+${day}\\b`).test(lower));
  const hasPastQualifier = /\b(yesterday|earlier|this\s+morning|already\s+(?:had|happened)|last\s+\w+)\b/.test(lower);
  return { minutes, hasFutureQualifier, hasPastQualifier, raw };
}

// ---------------------------------------------------------------------------
// PER-SKILL EXECUTION IDENTITY (deployment-owned, bounded, non-model-selected).
//
// When ToggleLogic routes a resolved skill through the bounded child, it OWNS
// that execution and can attach the AUTHORITATIVE mailbox/account identity the
// child must act under — keyed ONLY to a VERIFIED resolved skill id, never
// chosen by the model. The reference host has TWO distinct mail identities that
// must never be conflated:
//   - microsoft-graph = the OWNER's Microsoft 365 mailbox (SAM acts as Al / on
//     behalf of Al);
//   - gog (Gmail) = SAM's OWN account clickitco@gmail.com (SAM in SAM's own
//     identity; NEVER impersonate Al).
// The identity text is deployment config (labels + policy sentences), NEVER a
// credential/token; it is injected into the routed child's system prompt AND
// surfaced (credential-free) in the audit/receipt metadata. An identity is only
// ever applied to a skill id present in the resolved route, so a Graph identity
// can never cross onto a Gmail route (or vice versa) and an identity can never
// be supplied for a skill that did not resolve.
// ---------------------------------------------------------------------------
const MAX_IDENTITIES = 128;
const MAX_IDENTITY_FIELD_CHARS = 600;
const MAX_IDENTITY_LABEL_CHARS = 80;
const IDENTITY_ID_RE = /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,127}$/;

// Bounded, single-line-collapsed, control-free text (idempotent). Mirrors the
// resolver's boundedDescription so a hostile config value can never emit control
// characters or an unbounded block into the child system prompt.
function sanitizeIdentityText(value, max = MAX_IDENTITY_FIELD_CHARS) {
  if (typeof value !== "string") return "";
  let out = "";
  for (const ch of value) {
    const code = ch.codePointAt(0);
    out += (code < 0x20 || code === 0x7f) ? " " : ch;
  }
  return out.replace(/\s+/g, " ").trim().slice(0, Math.max(0, max));
}

// Coerce the raw config.skillIdentities into a trusted, bounded map keyed by a
// valid skill id. Drops malformed / empty entries. Pure; never throws.
function normalizeIdentities(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out = {};
  let count = 0;
  for (const [id, value] of Object.entries(raw)) {
    if (count >= MAX_IDENTITIES) break;
    if (!IDENTITY_ID_RE.test(id) || !value || typeof value !== "object" || Array.isArray(value)) continue;
    const mailbox = sanitizeIdentityText(value.mailbox);
    const senderIdentity = sanitizeIdentityText(value.senderIdentity);
    const authority = sanitizeIdentityText(value.authority);
    const sendPolicy = sanitizeIdentityText(value.sendPolicy);
    // An identity is only meaningful if it carries at least one field.
    if (!mailbox && !senderIdentity && !authority && !sendPolicy) continue;
    const label = sanitizeIdentityText(value.label, MAX_IDENTITY_LABEL_CHARS)
      || sanitizeIdentityText(mailbox, MAX_IDENTITY_LABEL_CHARS) || id;
    const lines = [`PER-SKILL EXECUTION IDENTITY — skill "${id}" (deployment-owned, mandatory, non-negotiable):`];
    if (mailbox) lines.push(`- Mailbox / account: ${mailbox}`);
    if (senderIdentity) lines.push(`- Act as: ${senderIdentity}`);
    if (authority) lines.push(`- ${authority}`);
    if (sendPolicy) lines.push(`- Send policy: ${sendPolicy}`);
    lines.push("- Never use another skill's mailbox/account or sender identity for this work; if the identity is unclear or seems to conflict with the request, STOP and confirm with the owner before sending anything externally.");
    out[id] = { label, mailbox, senderIdentity, authority, sendPolicy, prompt: lines.join("\n") };
    count += 1;
  }
  return out;
}

export function createSkillContracts(rawConfig = {}) {
  const ownerTimezone = cleanString(rawConfig.ownerTimezone) || "America/New_York";
  // Deployment-owned per-skill execution identity, keyed by verified skill id.
  const identities = normalizeIdentities(rawConfig.skillIdentities);
  const now = typeof rawConfig.now === "function" ? rawConfig.now : () => Date.now();
  const calendarPort = rawConfig.calendarPort && typeof rawConfig.calendarPort.findEvent === "function"
    ? rawConfig.calendarPort
    : null;
  const overrides = rawConfig.contracts && typeof rawConfig.contracts === "object" ? rawConfig.contracts : {};
  // Deployment-declared per-skill tool policy, enforced on the bounded child by the
  // before_tool_call guard: { "<skillId>": { allowedTools:[...], maxToolCalls, disableTools } }.
  const skillTools = rawConfig.skillTools && typeof rawConfig.skillTools === "object" ? rawConfig.skillTools : {};
  // The configured guard ceiling is also the hard cap for a composite route.
  // Component ceilings may add together because a Graph+Zoom (or Graph+artifact)
  // workflow legitimately needs both skills' tool budgets, but composition can
  // never expand beyond this global bound.
  const compositeToolCallCeiling = Number.isFinite(rawConfig.maxChildToolCalls) && rawConfig.maxChildToolCalls >= 0
    ? Math.floor(rawConfig.maxChildToolCalls) : 32;
  // Calendar-capable installed skills (deployment-overridable). Authoritative =
  // Outlook via Microsoft Graph; subordinate = Zoom (never a calendar).
  const authoritativeCalendarSkills = normalizeIdList(rawConfig.calendarSkillIds, DEFAULT_AUTHORITATIVE_CALENDAR_SKILLS);
  const subordinateMeetingSkills = normalizeIdList(rawConfig.meetingSubordinateSkillIds, DEFAULT_SUBORDINATE_MEETING_SKILLS);

  /**
   * Combined bounded-child tool policy for a set of resolved skills:
   *   { disableTools, allowedTools:string[]|null, maxToolCalls:number|null }
   * disableTools=true → run with an exact empty tool surface (SubagentRunParams).
   * allowedTools=null → no allowlist (count-only); a non-null list is enforced by
   * the guard. To avoid breaking a skill whose tools are undeclared, an allowlist
   * only applies when EVERY non-disabled skill declared one.
   *
   * The count ceiling is a BOUNDED COMPOSITE: each unique non-disabled skill
   * contributes its declared ceiling (or the global ceiling when undeclared),
   * the contributions are summed, and the result is capped by the configured
   * global ceiling. This gives Graph+Zoom enough room for both workflows without
   * letting composition multiply the deployment's hard safety limit.
   */
  function toolPolicyFor(skills) {
    const list = Array.isArray(skills) ? skills : [];
    if (list.length === 0) return { disableTools: false, allowedTools: null, maxToolCalls: null };
    let disableAll = true;
    let anyUnrestricted = false;
    const combinedAllow = new Set();
    let compositeCalls = 0;
    const seenSkills = new Set();
    for (const skill of list) {
      const id = cleanString(typeof skill === "string" ? skill : skill?.id);
      if (!id || seenSkills.has(id)) continue;
      seenSkills.add(id);
      const policy = id && skillTools[id] && typeof skillTools[id] === "object" ? skillTools[id] : null;
      const disable = policy?.disableTools === true;
      const allow = Array.isArray(policy?.allowedTools)
        ? policy.allowedTools.map(cleanString).filter(Boolean) : null;
      const configuredMaxCalls = Number.isFinite(policy?.maxToolCalls) && policy.maxToolCalls >= 0 ? Math.floor(policy.maxToolCalls) : null;
      const workflowFloor = BUILTIN_WORKFLOW_TOOL_CALL_FLOORS[id] ?? 0;
      const maxCalls = disable || configuredMaxCalls === 0 ? 0 : Math.min(
        compositeToolCallCeiling,
        Math.max(configuredMaxCalls ?? compositeToolCallCeiling, workflowFloor),
      );
      if (!disable) disableAll = false;
      if (!disable && !allow) anyUnrestricted = true;
      if (allow) for (const t of allow) combinedAllow.add(t);
      if (!disable) compositeCalls += maxCalls;
    }
    const disableTools = disableAll;
    const allowedTools = disableTools
      ? []
      : (anyUnrestricted || combinedAllow.size === 0 ? null : [...combinedAllow]);
    const maxToolCalls = disableTools ? 0 : Math.min(compositeToolCallCeiling, compositeCalls);
    return { disableTools, allowedTools, maxToolCalls };
  }

  // Ordered, deduped identity prompt blocks for the RESOLVED skill set. Only ids
  // that both (a) appear in this route and (b) have a configured identity emit a
  // block — so an identity can never be attached to a skill outside the route.
  function identityBlocksFor(skills) {
    const seen = new Set();
    const blocks = [];
    for (const skill of skills || []) {
      const id = cleanString(typeof skill === "string" ? skill : skill?.id);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const ident = identities[id];
      if (ident) blocks.push(ident.prompt);
    }
    return blocks;
  }

  // Credential-free identity metadata for a resolved skill set, for the
  // audit/receipt record. Labels + mailbox/act-as text ONLY — never a token.
  function identityAudit(skills) {
    const seen = new Set();
    const applied = [];
    for (const skill of skills || []) {
      const id = cleanString(typeof skill === "string" ? skill : skill?.id);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const ident = identities[id];
      if (ident) applied.push({ skill: id, label: ident.label, mailbox: ident.mailbox || null, act_as: ident.senderIdentity || null });
    }
    return applied;
  }

  function contractFor(skillId) {
    const id = cleanString(skillId);
    if (!id) return null;
    if (overrides[id] && typeof overrides[id] === "object") {
      return { timeSensitive: overrides[id].timeSensitive === true, contract: cleanString(overrides[id].contract) };
    }
    return BUILTIN_CONTRACTS[id] || null;
  }

  /**
   * Whether the meeting/calendar truth contract applies to this turn, and whether
   * an AUTHORITATIVE calendar (Outlook via Microsoft Graph) is part of the route.
   * Intent-aware AND skill-aware:
   *   - A skill with a builtin/override time-sensitive contract (meeting-prep)
   *     always carries it.
   *   - Otherwise it applies only when the text shows a calendar/meeting INTENT
   *     AND a calendar-capable installed skill resolved (microsoft-graph and/or
   *     zoom-meetings). Generic Graph email/contact work (no meeting intent) does
   *     NOT trigger it.
   *   - authoritativeAvailable is true only when an Outlook/Graph calendar skill
   *     (or a builtin meeting skill) is in the route; a Zoom-only meeting request
   *     applies but has NO authoritative calendar (Zoom alone cannot establish an
   *     event).
   */
  function meetingApplicability(skills, text) {
    const ids = new Set();
    for (const skill of skills || []) {
      const id = cleanString(typeof skill === "string" ? skill : skill?.id);
      if (id) ids.add(id);
    }
    const builtinTimed = (skills || []).some((skill) => contractFor(skill?.id)?.timeSensitive);
    const hasAuthoritative = authoritativeCalendarSkills.some((id) => ids.has(id));
    const hasSubordinate = subordinateMeetingSkills.some((id) => ids.has(id));
    const intent = detectMeetingIntent(text);
    const applies = builtinTimed || (intent && (hasAuthoritative || hasSubordinate));
    const authoritativeAvailable = builtinTimed || hasAuthoritative;
    return { applies, authoritativeAvailable, hasAuthoritative, hasSubordinate, intent, builtinTimed };
  }

  // Combined contract text for a set of resolved skills — injected into the
  // bounded child's system prompt. Includes any builtin/override contract, plus
  // the meeting/calendar contract whenever this turn is an intent+skill-aware
  // calendar turn (so a microsoft-graph meeting request gets the same rules the
  // absent meeting-prep skill would have injected). Generic Graph work gets none.
  function contractPrompt(skills, text) {
    const seen = new Set();
    const blocks = [];
    // Per-skill execution identity FIRST (which mailbox / whose identity / send
    // policy) — foundational context the child must read before the task.
    for (const block of identityBlocksFor(skills)) blocks.push(block);
    for (const skill of skills || []) {
      const spec = contractFor(skill?.id);
      if (spec?.contract && !seen.has(skill.id)) {
        seen.add(skill.id);
        blocks.push(spec.contract);
      }
    }
    const applicability = meetingApplicability(skills, text);
    if (!blocks.includes(MEETING_CALENDAR_CONTRACT) && applicability.applies) {
      blocks.push(MEETING_CALENDAR_CONTRACT);
    }
    if (applicability.applies && applicability.hasSubordinate) {
      blocks.push(ZOOM_HISTORY_EVIDENCE_CONTRACT);
    }
    return blocks.length ? blocks.join("\n\n") : null;
  }

  /**
   * Deterministic pre-execution validation for a resolved skill set + request.
   * Runs BEFORE any route/model education or spend. Returns
   *   { action: "proceed" }                       — safe to route/execute
   *   { action: "clarify", reply, reason }        — must ask instead of executing
   * Never throws.
   */
  async function preflight(skills, text, _hookContext = {}) {
    const applicability = meetingApplicability(skills, text);
    if (!applicability.applies) return { action: "proceed", reason: "no_calendar_contract" };

    const local = localParts(now(), ownerTimezone);

    // Calendar/meeting intent that resolved ONLY to a subordinate meeting skill
    // (e.g. Zoom) with NO authoritative Outlook/Graph calendar in the route:
    // Zoom alone cannot establish that a meeting exists. Clarify deterministically
    // (never fabricate) with zero model calls.
    if (!applicability.authoritativeAvailable) {
      return {
        action: "clarify",
        reason: "subordinate_meeting_skill_not_authoritative",
        reply: buildClarify(local, ownerTimezone, parseMeetingReference(text), { subordinateOnly: true }),
      };
    }

    // NARROW PRECEDENCE (1.6.1-rc.4): an EXPLICIT request to inspect/check/search/
    // query the Outlook calendar via Microsoft Graph — with an authoritative Graph
    // calendar in the route (guaranteed here, past the subordinate-only branch) — is
    // a direct instruction to consult the authoritative source and report the truth.
    // It must NOT be short-circuited merely because the referenced meeting time has
    // already passed; it proceeds through the Microsoft Graph skill/bridge, which
    // still runs under the injected meeting/calendar contract (Outlook authoritative,
    // never fabricate). The cost-saving past-meeting clarification is preserved for
    // ordinary ambiguous meeting-PREP requests, which carry no inspect/check verb.
    if (detectCalendarInspectionIntent(text)) {
      return { action: "proceed", reason: "explicit_calendar_inspection" };
    }

    const ref = parseMeetingReference(text);
    const nowMinutes = local.hour * 60 + local.minute;

    // No explicit clock time referenced → nothing to validate deterministically.
    // Execution proceeds under the bounded-child contract (which forces an
    // authoritative Outlook check).
    if (!ref) return { action: "proceed", reason: "no_explicit_time_reference" };

    const isPastToday = !ref.hasFutureQualifier && (ref.hasPastQualifier || ref.minutes < nowMinutes);

    // Consult the authoritative calendar when a port is wired.
    let calendarEvent;
    let calendarChecked = false;
    if (calendarPort) {
      calendarChecked = true;
      try {
        calendarEvent = await calendarPort.findEvent({
          minutesOfDay: ref.minutes,
          nowMs: now(),
          timeZone: ownerTimezone,
          text,
        });
      } catch {
        calendarEvent = undefined; // treat a failed lookup as unverifiable
      }
    }

    if (isPastToday) {
      return {
        action: "clarify",
        reason: calendarChecked && calendarEvent ? "past_meeting_reference" : "past_meeting_reference_unverified",
        reply: buildClarify(local, ownerTimezone, ref, { past: true, calendarChecked, calendarEvent }),
      };
    }
    if (calendarChecked && !calendarEvent) {
      return {
        action: "clarify",
        reason: "no_authoritative_calendar_event",
        reply: buildClarify(local, ownerTimezone, ref, { past: false, calendarChecked, calendarEvent }),
      };
    }
    return { action: "proceed", reason: calendarChecked ? "calendar_event_confirmed" : "future_reference_defer_to_contract" };
  }

  return { contractFor, contractPrompt, preflight, meetingApplicability, toolPolicyFor, identityAudit, identityBlocksFor, ownerTimezone };
}

function fmtRef(ref) {
  const h = Math.floor(ref.minutes / 60);
  const m = ref.minutes % 60;
  const suffix = h < 12 ? "AM" : "PM";
  const hour12 = ((h + 11) % 12) + 1;
  return m ? `${hour12}:${String(m).padStart(2, "0")} ${suffix}` : `${hour12} ${suffix}`;
}

function buildClarify(local, timeZone, ref, { past, calendarChecked, calendarEvent, subordinateOnly } = {}) {
  const nowStr = `${fmtRef({ minutes: local.hour * 60 + local.minute })} (${timeZone})`;
  const lines = [
    `I checked the current time first: it is ${nowStr}.`,
  ];
  if (subordinateOnly) {
    // A meeting/calendar request that resolved only to Zoom (no Outlook/Graph in
    // the route). Zoom is subordinate context, never the calendar.
    lines.push("Zoom isn't a calendar — I can use Zoom recordings and transcripts as context, but I can't confirm a meeting exists from Zoom alone.");
    lines.push("I treat your Outlook calendar via Microsoft Graph as the one source of truth, and it isn't part of this request, so I won't invent a meeting. Please confirm the meeting's day and time, or ask again including Outlook / Microsoft Graph so I can verify it against your calendar.");
    return lines.join(" ");
  }
  const refStr = ref ? fmtRef(ref) : "that meeting";
  if (past) {
    lines.push(`The meeting you referenced (${refStr}) is already in the past today, and I won't prepare a brief for a meeting that has passed based on assumptions.`);
  } else if (calendarChecked && !calendarEvent) {
    lines.push(`I can't find a ${refStr} meeting on your Outlook calendar, so I won't invent one.`);
  }
  lines.push("Did you mean an upcoming meeting (please confirm the day/time), or would you like a debrief of a past one? I use your Outlook calendar via Microsoft Graph as the source of truth and never fabricate a meeting.");
  return lines.join(" ");
}
