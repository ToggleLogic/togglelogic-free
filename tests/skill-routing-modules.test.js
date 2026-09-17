/*
 * ToggleLogic (Free Tier) — unit tests for the skill-routing leaf modules:
 * canary scope, deterministic resolver, per-skill execution contracts, and the
 * host-affordance self-check.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { createCanaryScope, normalizeScope } from "../src/skill-routing/scope.js";
import { createSkillResolver } from "../src/skill-routing/resolver.js";
import { createSkillContracts, parseMeetingReference, BUILTIN_CONTRACTS } from "../src/skill-routing/skill-contracts.js";
import { verifyHostAffordances } from "../src/skill-routing/host-affordances.js";
import { createNonActionMatcher } from "../src/skill-routing/intent-categories.js";

// The SAM-HQ canary account is "default" (session-key form
// agent:main:telegram:default:direct:<owner-peer-id>) — the account SAM itself runs
// on — NOT the separate Codex Development bot account ("codex"), which must stay out
// of scope. The owner peer id here exercises the mechanics; it is a test, not shipped.
const SAM_SCOPE = { enabled: true, channels: ["telegram"], accountIds: ["default"], senderIds: ["7797183919"], ownerSenderIds: ["7797183919"] };

test("scope: an unconstrained scope is inert unless allowGlobal is explicit", () => {
  assert.equal(createCanaryScope({ enabled: true }).evaluate({ senderId: "x", trigger: "user" }).inScope, false);
  assert.equal(createCanaryScope({ enabled: true, allowGlobal: true, requireOwner: false }).evaluate({ senderId: "x", trigger: "user", inputProvenance: { kind: "external_user" } }).inScope, true);
  assert.equal(createCanaryScope({ enabled: false }).evaluate({}).inScope, false);
});

test("scope: matches Al's Telegram DM and excludes everything else", () => {
  const scope = createCanaryScope(SAM_SCOPE);
  const dm = { channel: "telegram", accountId: "default", senderId: "7797183919", sessionKey: "s", trigger: "user", inputProvenance: { kind: "external_user" } };
  assert.equal(scope.evaluate(dm).inScope, true);
  assert.equal(scope.evaluate({ ...dm, channel: "slack" }).reason, "dimension_miss:channel");
  assert.equal(scope.evaluate({ ...dm, senderId: "999" }).reason, "not_owner");
  // the separate Codex Development bot account is out of scope
  assert.equal(scope.evaluate({ ...dm, accountId: "codex" }).reason, "dimension_miss:accountId");
  assert.equal(scope.evaluate({ ...dm, trigger: "cron" }).reason, "trigger_excluded:cron");
  assert.equal(scope.evaluate({ ...dm, trigger: "heartbeat" }).reason, "trigger_excluded:heartbeat");
  assert.equal(scope.evaluate({ ...dm, inputProvenance: { kind: "inter_session" } }).reason, "provenance_excluded:inter_session");
  assert.equal(scope.evaluate({ sessionKey: "cli" }).inScope, false); // CLI: no channel/sender
});

test("scope: sender id can come from the channelContext fallback", () => {
  const scope = createCanaryScope(SAM_SCOPE);
  const ctx = { channel: "telegram", accountId: "default", channelContext: { sender: { id: "7797183919" } }, trigger: "user", inputProvenance: { kind: "external_user" } };
  assert.equal(scope.evaluate(ctx).inScope, true);
});

test("scope: normalizeScope lowercases channels and dedupes", () => {
  const s = normalizeScope({ enabled: true, channels: ["Telegram", "telegram", "SLACK"], senderIds: ["a", "a"] });
  assert.deepEqual(s.channels, ["telegram", "slack"]);
  assert.deepEqual(s.senderIds, ["a"]);
});

test("resolver: exact installed id and alias resolve; unknown skill is ambiguous; bare words don't", () => {
  const r = createSkillResolver({ catalog: [{ id: "meeting-prep", aliases: ["meeting prep"] }, { id: "code-review" }] });
  assert.equal(r.resolve("use the meeting-prep skill").status, "resolved");
  assert.equal(r.resolve("please do a meeting prep").status, "resolved"); // alias
  assert.equal(r.resolve("run code-review on the PR").matchedIds[0], "code-review");
  assert.equal(r.resolve("prepare for my meeting").status, "none"); // "meeting" alone is not the alias phrase
  const amb = r.resolve("use the nonexistent-thing skill");
  assert.equal(amb.status, "ambiguous");
  assert.deepEqual(amb.unknownSkills, ["nonexistent thing"]);
});

test("resolver: off mode resolves nothing", () => {
  const r = createSkillResolver({ mode: "off", catalog: [{ id: "meeting-prep" }] });
  assert.equal(r.resolve("use the meeting-prep skill").status, "none");
});

test("resolver: carries structured identity (version/fingerprint/execution_class)", () => {
  const r = createSkillResolver({ catalog: [{ id: "meeting-prep", version: "2.1.0", fingerprint: "abc", execution_class: "tool" }] });
  const hit = r.resolve("meeting-prep please");
  assert.deepEqual(hit.skills[0], { id: "meeting-prep", version: "2.1.0", fingerprint: "abc", execution_class: "tool" });
  assert.deepEqual(r.identityFor("meeting-prep"), { id: "meeting-prep", version: "2.1.0", fingerprint: "abc", execution_class: "tool" });
  assert.equal(r.identityFor("not-installed"), null);
});

test("meeting contract: parses am/pm and 24h clock references", () => {
  assert.equal(parseMeetingReference("my 2 pm meeting").minutes, 14 * 60);
  assert.equal(parseMeetingReference("meeting at 9:30am").minutes, 9 * 60 + 30);
  assert.equal(parseMeetingReference("sync at 14:00").minutes, 14 * 60);
  assert.equal(parseMeetingReference("tomorrow at 2 pm").hasFutureQualifier, true);
  assert.equal(parseMeetingReference("prep me generally"), null);
});

test("meeting contract: past reference clarifies; future proceeds; no time proceeds", async () => {
  const nowPast = () => Date.parse("2026-09-15T20:03:00Z"); // 16:03 EDT
  const skills = [{ id: "meeting-prep" }];
  const past = createSkillContracts({ ownerTimezone: "America/New_York", now: nowPast });
  assert.equal((await past.preflight(skills, "prep my 2 pm meeting")).action, "clarify");

  const nowEarly = () => Date.parse("2026-09-15T15:00:00Z"); // 11:00 EDT
  const future = createSkillContracts({ ownerTimezone: "America/New_York", now: nowEarly, calendarPort: { findEvent: async () => ({ id: "e1" }) } });
  assert.equal((await future.preflight(skills, "prep my 2 pm meeting")).action, "proceed");

  // future but calendar says no such event → clarify (don't fabricate)
  const futureNoEvent = createSkillContracts({ ownerTimezone: "America/New_York", now: nowEarly, calendarPort: { findEvent: async () => null } });
  assert.equal((await futureNoEvent.preflight(skills, "prep my 2 pm meeting")).action, "clarify");

  // no explicit time → proceed under the injected contract
  assert.equal((await past.preflight(skills, "help me get ready for the board meeting")).action, "proceed");
});

test("meeting contract: non-meeting-prep skills have no time gate; contract text is injectable", async () => {
  const c = createSkillContracts({ ownerTimezone: "America/New_York", now: () => Date.parse("2026-09-15T20:03:00Z") });
  assert.equal((await c.preflight([{ id: "code-review" }], "review at 2 pm")).action, "proceed");
  const prompt = c.contractPrompt([{ id: "meeting-prep" }]);
  assert.match(prompt, /Outlook via Microsoft Graph|Microsoft Graph/);
  assert.match(prompt, /NEVER synthesize/i);
  assert.equal(c.contractPrompt([{ id: "code-review" }]), null);
  assert.ok(BUILTIN_CONTRACTS["meeting-prep"].timeSensitive);
});

test("non-action matcher: only DECLARED categories bypass; default set is empty", () => {
  // Default (no categories): nothing is exempt from the fail-closed rule.
  assert.equal(createNonActionMatcher([]).match("hello").matched, false);

  const m = createNonActionMatcher([
    { id: "greeting", phrases: ["hi", "hello", "good morning"] },
    { id: "acknowledgement", phrases: ["perfect", "great", "sounds good", "got it"] },
    { id: "control", patterns: ["^\\s*/(stop|status|help)\\b"] },
  ]);
  assert.equal(m.match("Hello!").matched, true, "phrase match is normalization-insensitive");
  assert.equal(m.match("Hello!").category, "greeting");
  assert.equal(m.match("/status").category, "control");
  assert.equal(m.match("/status").kind, "pattern");
  assert.equal(m.match("Perfect!").category, "acknowledgement");
  assert.equal(m.match("Perfect! Now reconcile the quarterly ledger.").matched, false, "an acknowledgement prefix never exempts an actionable request");
  assert.equal(m.match("reconcile the quarterly ledger").matched, false, "actionable text is not exempt");
});

test("non-action matcher: an invalid regex pattern is skipped, not thrown", () => {
  let warned = 0;
  const m = createNonActionMatcher([{ id: "bad", patterns: ["("], phrases: ["ok"] }], () => { warned += 1; });
  assert.equal(warned, 1);
  assert.equal(m.match("ok").matched, true, "the valid phrase still works");
});

test("host-affordances: missing subagent runtime forces shadow; unconfigured scope warns", () => {
  const base = { skillRouting: { scope: { enabled: true, channels: ["telegram"], accountIds: [], senderIds: ["7797183919"], chatIds: [], sessionKeys: [], allowGlobal: false }, skillCatalog: [{ id: "meeting-prep" }], resolverMode: "deterministic" } };
  const goodApi = { on() {}, runtime: { subagent: { run() {}, waitForRun() {}, getSessionMessages() {} } } };
  assert.equal(verifyHostAffordances({ api: goodApi, config: base }).ok, true);

  const noRuntime = { on() {} };
  const r = verifyHostAffordances({ api: noRuntime, config: base });
  assert.equal(r.ok, false);
  assert.equal(r.forceShadow, true);
  assert.ok(r.missing.some((m) => /subagent/.test(m)));

  const unscoped = verifyHostAffordances({ api: goodApi, config: { skillRouting: { scope: { enabled: true, channels: [], accountIds: [], senderIds: [], chatIds: [], sessionKeys: [], allowGlobal: false }, skillCatalog: [{ id: "x" }], resolverMode: "deterministic" } } });
  assert.ok(unscoped.warnings.some((w) => /unscoped|constraint|INERT/i.test(w)));

  // With the deployment-owned SNAPSHOT as the authoritative membership source, an
  // empty config catalog only warns when the deployment opted OUT of the snapshot.
  const noCatalog = verifyHostAffordances({ api: goodApi, config: { skillRouting: { useSnapshotInventory: false, scope: { enabled: true, channels: ["telegram"], accountIds: [], senderIds: [], chatIds: [], sessionKeys: [], allowGlobal: false }, skillCatalog: [], resolverMode: "deterministic" } } });
  assert.ok(noCatalog.warnings.some((w) => /catalog/i.test(w)));
  // Default (snapshot inventory) with empty config catalog does NOT warn about the catalog.
  const liveNoCatalog = verifyHostAffordances({ api: goodApi, config: { skillRouting: { scope: { enabled: true, channels: ["telegram"], accountIds: [], senderIds: [], chatIds: [], sessionKeys: [], allowGlobal: false }, skillCatalog: [], resolverMode: "deterministic" } } });
  assert.ok(!liveNoCatalog.warnings.some((w) => /catalog/i.test(w)));
});

test("resolver.suggest: offers installed skills that share significant tokens (plural-stemmed)", () => {
  const r = createSkillResolver({ catalog: [{ id: "zoom-meetings" }, { id: "microsoft-graph" }, { id: "code-review" }] });
  const s = r.suggest("prepare me for my 2 pm meeting");
  assert.ok(s.some((c) => c.id === "zoom-meetings"), "meeting ~ meetings matches zoom-meetings");
  assert.ok(!s.some((c) => c.id === "code-review"), "unrelated skill is not offered");
  assert.deepEqual(r.suggest("xyzzy nothing relevant here"), [], "no token overlap → no suggestions");
});

test("classifier: OFF unless a model is pinned; disabled path never guesses", async () => {
  const { createSkillClassifier } = await import("../src/skill-routing/resolver.js");
  const off = createSkillClassifier({ enabled: true, model: "" });
  assert.equal(off.enabled, false);
  assert.equal((await off.classify("do something", { eligibleIds: ["a"] })).status, "disabled");
});

test("classifier: schema-validated, confidence-thresholded, task-prohibited, id-constrained", async () => {
  const { createSkillClassifier } = await import("../src/skill-routing/resolver.js");
  const eligibleIds = ["zoom-meetings", "microsoft-graph"];
  const make = (raw) => createSkillClassifier(
    { enabled: true, model: "llama3.1:8b", confidenceThreshold: 0.6 },
    { invoke: async () => raw },
  );
  // resolved above threshold
  assert.deepEqual(
    await make('{"skill_id":"zoom-meetings","confidence":0.9}').classify("x", { eligibleIds }),
    { status: "resolved", skillId: "zoom-meetings", confidence: 0.9 },
  );
  // low confidence → none (fail-safe)
  assert.equal((await make('{"skill_id":"zoom-meetings","confidence":0.4}').classify("x", { eligibleIds })).status, "none");
  // hallucinated id not in the eligible set → malformed (invalid)
  assert.equal((await make('{"skill_id":"not-installed","confidence":0.99}').classify("x", { eligibleIds })).status, "malformed");
  // non-JSON → malformed
  assert.equal((await make("I will now do the task for you").classify("x", { eligibleIds })).status, "malformed");
  // Human conversation bypasses skill routing only through an explicit,
  // confidence-thresholded classifier decision; it never names or runs a skill.
  assert.deepEqual(
    await make('{"intent":"conversation","skill_id":null,"confidence":0.95,"ambiguous":false,"alternatives":[]}').classify("Perfect!", { eligibleIds }),
    { status: "conversation", confidence: 0.95 },
  );
  assert.equal(
    (await make('{"intent":"conversation","skill_id":"microsoft-graph","confidence":0.95}').classify("x", { eligibleIds })).status,
    "malformed",
    "conversation can never smuggle a skill execution",
  );
  // A bare optional alternative is NOT ambiguity: a clear winner plus a long-shot
  // alternative resolves to the winner (the gap-B fix — don't needlessly clarify an
  // explicit Outlook/Zoom request the model already picked confidently).
  assert.deepEqual(
    await make('{"skill_id":"zoom-meetings","confidence":0.9,"alternatives":["microsoft-graph"]}').classify("x", { eligibleIds }),
    { status: "resolved", skillId: "zoom-meetings", confidence: 0.9 },
  );
  // Explicit equal-applicability flag → one clarification.
  const flagged = await make('{"skill_id":"zoom-meetings","confidence":0.8,"ambiguous":true,"alternatives":["microsoft-graph"]}').classify("x", { eligibleIds });
  assert.equal(flagged.status, "ambiguous");
  assert.deepEqual(flagged.candidates, ["zoom-meetings", "microsoft-graph"]);
  // A scored near-tie (within ambiguityGap) → clarify even without the explicit flag.
  assert.equal(
    (await make('{"skill_id":"zoom-meetings","confidence":0.82,"alternatives":[{"skill_id":"microsoft-graph","confidence":0.78}]}').classify("x", { eligibleIds })).status,
    "ambiguous",
  );
  // A scored long shot (confidence gap beyond ambiguityGap) → resolve to the winner.
  assert.equal(
    (await make('{"skill_id":"zoom-meetings","confidence":0.9,"alternatives":[{"skill_id":"microsoft-graph","confidence":0.2}]}').classify("x", { eligibleIds })).status,
    "resolved",
  );
  // transport throw → error (fail-safe), never throws out
  const boom = createSkillClassifier({ enabled: true, model: "m" }, { invoke: async () => { throw new Error("down"); } });
  assert.equal((await boom.classify("x", { eligibleIds })).status, "error");
});

test("classifier: is given verified id + bounded description and a configurable, bounded numCtx", async () => {
  const { createSkillClassifier } = await import("../src/skill-routing/resolver.js");
  const seen = [];
  const c = createSkillClassifier(
    { enabled: true, model: "gemma-test", confidenceThreshold: 0.6, numCtx: 8192 },
    { invoke: async (req) => { seen.push(req); return '{"skill_id":"microsoft-graph","confidence":0.9}'; } },
  );
  const eligible = [
    { id: "microsoft-graph", description: "Email, calendar, contacts" },
    { id: "zoom-meetings", description: "Zoom recordings & transcripts" },
  ];
  const r = await c.classify("prepare my outlook email", { eligible });
  assert.deepEqual(r, { status: "resolved", skillId: "microsoft-graph", confidence: 0.9 });
  assert.equal(seen.length, 1);
  assert.match(seen[0].system, /microsoft-graph: Email, calendar, contacts/, "descriptions reach the classifier, not opaque ids");
  assert.equal(seen[0].numCtx, 8192, "the configured, bounded numCtx is passed to the transport");

  // numCtx out of range falls back to the catalog-sufficient default (8192).
  const cDefault = createSkillClassifier(
    { enabled: true, model: "m", numCtx: 999999 },
    { invoke: async (req) => { seen.push(req); return '{"skill_id":"microsoft-graph","confidence":0.9}'; } },
  );
  await cDefault.classify("x", { eligible });
  assert.equal(seen[1].numCtx, 8192);
});

test("classifier: FAILS CLOSED (never invokes) when the eligible catalog exceeds the hard entry bound", async () => {
  const { createSkillClassifier } = await import("../src/skill-routing/resolver.js");
  let invoked = 0;
  const c = createSkillClassifier(
    { enabled: true, model: "m" },
    { invoke: async () => { invoked += 1; return '{"skill_id":null,"confidence":0}'; } },
  );
  const eligible = Array.from({ length: 129 }, (_, i) => ({ id: `skill-${i}`, description: "x" }));
  const r = await c.classify("something", { eligible });
  assert.equal(r.status, "error");
  assert.equal(r.reason, "catalog_bounds_exceeded");
  assert.equal(invoked, 0, "an oversized catalog never reaches the model");
});

test("classifier: a hallucinated id (not in the eligible catalog) is rejected as malformed", async () => {
  const { createSkillClassifier } = await import("../src/skill-routing/resolver.js");
  const c = createSkillClassifier(
    { enabled: true, model: "m" },
    { invoke: async () => '{"skill_id":"totally-made-up","confidence":0.99}' },
  );
  const r = await c.classify("x", { eligible: [{ id: "microsoft-graph", description: "Email" }] });
  assert.equal(r.status, "malformed", "an id outside the verified catalog is never trusted");
});

test("classifier: exact platform cues resolve their obvious skill; only true equal ambiguity clarifies", async () => {
  const { createSkillClassifier } = await import("../src/skill-routing/resolver.js");
  const eligible = [
    { id: "microsoft-graph", description: "Outlook email, calendar, contacts via Microsoft Graph" },
    { id: "zoom-meetings", description: "Zoom cloud recordings & transcripts" },
    { id: "gog", description: "Google Workspace (Gmail/Calendar/Drive)" },
    { id: "youtube-transcript", description: "YouTube video transcripts" },
  ];
  const make = (raw) => createSkillClassifier({ enabled: true, model: "gemma4" }, { invoke: async () => raw });

  // The exact gap-B field cases: an explicit Outlook email → microsoft-graph with a
  // low-confidence "gog" long shot resolves; a Zoom transcript → zoom-meetings with a
  // "youtube-transcript" long shot resolves. Neither clarifies.
  assert.deepEqual(
    await make('{"skill_id":"microsoft-graph","confidence":0.9,"ambiguous":false,"alternatives":[{"skill_id":"gog","confidence":0.2}]}')
      .classify("send an Outlook email to Dana", { eligible }),
    { status: "resolved", skillId: "microsoft-graph", confidence: 0.9 },
  );
  assert.deepEqual(
    await make('{"skill_id":"zoom-meetings","confidence":0.88,"alternatives":[{"skill_id":"youtube-transcript","confidence":0.15}]}')
      .classify("pull the transcript of my Zoom call", { eligible }),
    { status: "resolved", skillId: "zoom-meetings", confidence: 0.88 },
  );
  // A GENUINE equal-applicability case (above threshold, explicit flag + near-tie
  // scores) still clarifies.
  const amb = await make('{"skill_id":"microsoft-graph","confidence":0.7,"ambiguous":true,"alternatives":[{"skill_id":"gog","confidence":0.68}]}')
    .classify("put a hold on my calendar", { eligible });
  assert.equal(amb.status, "ambiguous");
  assert.deepEqual(amb.candidates, ["microsoft-graph", "gog"]);
});
