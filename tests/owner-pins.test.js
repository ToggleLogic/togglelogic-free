/*
 * ToggleLogic (Free Tier) — M6 per-task owner pins: resolver + decide() order.
 * (c) 2026 Motherboard, Inc. Source-available under the ToggleLogic Free-Tier
 * License (see LICENSE); all rights reserved.
 * PATENT PENDING.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeConfig } from "../src/config/normalize.js";
import { createDecisionCore, DECISION_API_VERSION } from "../src/core/decide.js";
import { resolveOwnerPins, resolveOwnerPinsStatePath } from "../src/routing/owner-pins.js";

const HAIKU = "anthropic/claude-haiku-4-5";
const SONNET = "anthropic/claude-sonnet-4-6";
const FLASH = "google/gemini-3.5-flash";
const OPUS = "anthropic/claude-opus-4-8";
const BASE = 1_780_000_000_000;

function writeState(doc) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tl-pins-"));
  const p = path.join(dir, "owner_model_override.json");
  fs.writeFileSync(p, JSON.stringify(doc));
  return { dir, p };
}
const v2 = (pins) => ({ schema: "togglelogic-owner-pins/v2", pins });
const cfg = (p) => ({ enabled: true, statePath: p });
const atBase = () => BASE;

// --- Resolver: scopes -------------------------------------------------------

test("resolver: task + all scopes resolve by the normalized label", () => {
  const { p } = writeState(v2({
    all: { active: true, model_ref: SONNET, set_by: "togglelogic-pin", set_at_ms: BASE, expires_at_ms: BASE + 86_400_000 },
    "task:inventory-sync": { active: true, model_ref: OPUS, set_by: "togglelogic-pin", set_at_ms: BASE + 500 },
  }));
  const hit = resolveOwnerPins(cfg(p), { label: "inventory-sync", clock: atBase });
  assert.equal(hit.schemaVersion, "v2");
  assert.equal(hit.labelSeen, "inventory-sync");
  assert.equal(hit.task.eligible, true);
  assert.equal(hit.task.resolvedRef, OPUS);
  assert.equal(hit.task.scope, "task:inventory-sync");
  assert.equal(hit.all.eligible, true);
  assert.equal(hit.all.resolvedRef, SONNET);

  const other = resolveOwnerPins(cfg(p), { label: "other-task", clock: atBase });
  assert.equal(other.task, null, "a different label matches no task pin");
  assert.equal(other.all.eligible, true);

  const unlabelled = resolveOwnerPins(cfg(p), { label: null, clock: atBase });
  assert.equal(unlabelled.task, null, "an unlabelled turn never matches a task pin");
  assert.equal(unlabelled.labelSeen, null);
  assert.equal(unlabelled.all.eligible, true);
});

// --- Resolver: TTL per scope ------------------------------------------------

test("resolver: TTL — absent holds, future holds, past is a quiet not-applied", () => {
  const held = writeState(v2({ "task:t": { active: true, model_ref: OPUS, set_by: "x", set_at_ms: BASE } }));
  assert.equal(resolveOwnerPins(cfg(held.p), { label: "t", clock: atBase }).task.eligible, true, "absent expiry holds");
  const r = resolveOwnerPins(cfg(held.p), { label: "t", clock: atBase }).task;
  assert.equal(r.noExpiry, true);
  assert.equal(r.expiresAtMs, null);

  const future = writeState(v2({ "task:t": { active: true, model_ref: OPUS, set_by: "x", set_at_ms: BASE, expires_at_ms: BASE + 100 } }));
  assert.equal(resolveOwnerPins(cfg(future.p), { label: "t", clock: () => BASE }).task.eligible, true, "future deadline holds");

  const past = writeState(v2({ "task:t": { active: true, model_ref: OPUS, set_by: "x", set_at_ms: BASE, expires_at_ms: BASE - 1 } }));
  const expired = resolveOwnerPins(cfg(past.p), { label: "t", clock: atBase }).task;
  assert.equal(expired.eligible, false);
  assert.equal(expired.blockReason, "expired");
});

test("resolver: a future deadline lapses to expired on a cache hit with no file change", () => {
  const { p } = writeState(v2({ "task:t": { active: true, model_ref: OPUS, set_by: "x", set_at_ms: BASE, expires_at_ms: BASE + 100 } }));
  const live = resolveOwnerPins(cfg(p), { label: "t", clock: () => BASE });
  assert.equal(live.task.eligible, true);
  const lapsed = resolveOwnerPins(cfg(p), { label: "t", clock: () => BASE + 200 });
  assert.equal(lapsed.task.eligible, false, "same file, clock advanced past the deadline");
  assert.equal(lapsed.task.blockReason, "expired");
});

// --- Resolver: v1 migration -------------------------------------------------

test("resolver: a v1 file reads as the all scope, is honored, and is never rewritten", () => {
  const { p } = writeState({ active: true, model_ref: FLASH, set_by: "model-switch", set_at_ms: BASE });
  const before = fs.readFileSync(p, "utf8");
  const r = resolveOwnerPins(cfg(p), { label: "anything", clock: atBase });
  assert.equal(r.schemaVersion, "v1");
  assert.equal(r.all.eligible, true);
  assert.equal(r.all.resolvedRef, FLASH);
  assert.equal(r.all.noExpiry, true, "a v1 all with no expiry is held and flagged no_expiry");
  assert.equal(r.task, null);
  assert.equal(fs.readFileSync(p, "utf8"), before, "the resolver never rewrites the v1 file");
});

// --- Resolver: malformed fail-closed, loud once per version -----------------

test("resolver: a malformed expires_at_ms fails closed and is loud exactly once per file version", () => {
  const { p } = writeState(v2({ all: { active: true, model_ref: SONNET, set_by: "x", set_at_ms: BASE, expires_at_ms: null } }));
  const first = resolveOwnerPins(cfg(p), { label: null, clock: atBase });
  assert.equal(first.all.eligible, false);
  assert.equal(first.all.blockReason, "malformed");
  assert.deepEqual(first.rejections, [{ scope: "all", reason: "malformed_expires_at_ms" }], "loud on the first read of this version");
  const second = resolveOwnerPins(cfg(p), { label: null, clock: atBase });
  assert.equal(second.all.blockReason, "malformed", "still reported on every decision");
  assert.deepEqual(second.rejections, [], "quiet on a cache hit (same version)");
});

// --- Resolver: cache invalidation by mtime ----------------------------------

test("resolver: a changed file (new mtime) is re-read on the next request", () => {
  const { p } = writeState(v2({ "task:t": { active: true, model_ref: OPUS, set_by: "x", set_at_ms: BASE } }));
  assert.equal(resolveOwnerPins(cfg(p), { label: "t", clock: atBase }).task.resolvedRef, OPUS);
  fs.writeFileSync(p, JSON.stringify(v2({ "task:t": { active: true, model_ref: SONNET, set_by: "x", set_at_ms: BASE } })));
  const future = new Date(Date.now() + 5000);
  fs.utimesSync(p, future, future); // force a distinct mtime
  assert.equal(resolveOwnerPins(cfg(p), { label: "t", clock: atBase }).task.resolvedRef, SONNET, "the write takes effect on the next request");
});

// --- Resolver: inactive + disabled + path helper ----------------------------

test("resolver: inactive pins are a quiet not-applied; a disabled/absent config yields no pins", () => {
  const inactive = writeState(v2({ all: { active: false, model_ref: SONNET, set_by: "x", set_at_ms: BASE } }));
  const r = resolveOwnerPins(cfg(inactive.p), { label: null, clock: atBase });
  assert.equal(r.all.eligible, false);
  assert.equal(r.all.blockReason, "inactive");
  assert.deepEqual(r.rejections, []);

  const disabled = resolveOwnerPins({ enabled: false, statePath: inactive.p }, { label: "t", clock: atBase });
  assert.equal(disabled.configured, false);
  assert.equal(disabled.all, null);
  assert.equal(disabled.task, null);
  assert.equal(disabled.labelSeen, "t", "the label is still echoed so the host sees it even when pins are disabled");
});

test("resolveOwnerPinsStatePath resolves the configured path for the CLI (T5) and null when unset", () => {
  assert.equal(resolveOwnerPinsStatePath({ enabled: true, statePath: "/tmp/x/pins.json" }), "/tmp/x/pins.json");
  assert.equal(resolveOwnerPinsStatePath({ enabled: false, statePath: "/tmp/x/pins.json" }), "/tmp/x/pins.json", "independent of enabled");
  assert.equal(resolveOwnerPinsStatePath({}), null);
  assert.equal(resolveOwnerPinsStatePath(null), null);
});

// --- decide() order matrix --------------------------------------------------

const seam = () => ({ status: () => "absent", classify: async () => null });
const record = () => ({ requestId: "r1", selectedModel: null, selectedProvider: null, selectionReason: "passthrough", selectionDetails: {}, mode: null });
function request(over = {}) {
  return {
    apiVersion: DECISION_API_VERSION, requestId: "r1", agent: "main", defaultRef: HAIKU,
    requested: { ref: HAIKU, provider: "anthropic", model: "claude-haiku-4-5", source: "default" },
    candidates: [HAIKU, SONNET, FLASH, OPUS], fallbacks: [SONNET],
    host: { event: {}, context: {} }, ...over,
  };
}
function withLabel(label) { return { host: { event: {}, context: { taskType: label } } }; }
function pick(ref, source) { const [provider, ...rest] = ref.split("/"); return { requested: { ref, provider, model: rest.join("/"), source, pinSource: source === "user" ? "host_runtime" : undefined } }; }

function core(stateDoc, { mode = "configured", configuredRoutes = {}, cheapDefault = null, services = {} } = {}) {
  const { p } = writeState(stateDoc);
  const raw = { mode, configuredRoutes, ownerOverride: { enabled: true, statePath: p }, ...(cheapDefault ? { cheapHeuristic: { default: cheapDefault } } : {}) };
  return createDecisionCore({ policy: normalizeConfig(raw), services: { seam: seam(), ...services }, version: "pins-test" });
}
// NOTE: decide() reads the live wall clock for pins, so all-scope/task pins in
// these rows carry a far-future expiry (or none) and are always live here.
const FAR = Date.now() + 86_400_000;
const allPin = (ref, extra = {}) => ({ all: { active: true, model_ref: ref, set_by: "togglelogic-pin", set_at_ms: BASE, expires_at_ms: FAR, ...extra } });
const taskPin = (label, ref, extra = {}) => ({ [`task:${label}`]: { active: true, model_ref: ref, set_by: "togglelogic-pin", set_at_ms: BASE, ...extra } });

test("order: a user /model pick beats BOTH a task pin and an all-tasks pin (R1)", async () => {
  const c = core(v2({ ...allPin(SONNET), ...taskPin("inventory-sync", OPUS) }));
  const res = await c.decide(request({ ...withLabel("inventory-sync"), ...pick(FLASH, "user") }), { decision: record() });
  assert.equal(res.reason, "user_selection");
  assert.deepEqual(res.decision, { action: "passthrough" });
  assert.equal(res.pins.labelSeen, "inventory-sync");
  assert.equal(res.pins.task.status, "not_applied");
  assert.equal(res.pins.task.reason, "outranked_by_user");
  assert.equal(res.pins.all.status, "not_applied");
  assert.equal(res.pins.all.reason, "outranked_by_user");
});

test("order: 2.2.x behavior change — a user /model pick now beats an active all-tasks override", async () => {
  // In 2.2.x the all-tasks override won; in 2.3.0 the owner's own pick wins.
  const c = core(v2(allPin(SONNET)));
  const res = await c.decide(request(pick(FLASH, "user")), { decision: record() });
  assert.equal(res.reason, "user_selection", "the /model pick wins");
  assert.deepEqual(res.decision, { action: "passthrough" });
  assert.equal(res.pins.all.status, "not_applied");
  assert.equal(res.pins.all.reason, "outranked_by_user");
});

test("order: a task pin beats the all-tasks pin (task-vs-all, §4.4)", async () => {
  const c = core(v2({ ...allPin(SONNET), ...taskPin("inventory-sync", OPUS) }));
  const res = await c.decide(request(withLabel("inventory-sync")), { decision: record() });
  assert.equal(res.reason, "task_pin");
  assert.deepEqual(res.decision, { action: "route", ref: OPUS, provider: "anthropic", model: "claude-opus-4-8" });
  assert.equal(res.pins.task.status, "applied");
  assert.equal(res.pins.task.reason, "applied");
  assert.equal(res.pins.all.status, "not_applied");
  assert.equal(res.pins.all.reason, "outranked_by_task_pin");
  assert.deepEqual(res.rationale.details, { matched_rule: "task_pin", scope: "task:inventory-sync", pin_target: "model", resolved_ref: OPUS });
});

test("order: an all-tasks pin beats a skill request selection (owner_override reason is unchanged)", async () => {
  const c = core(v2(allPin(SONNET)));
  const res = await c.decide(request(pick(FLASH, "request")), { decision: record() });
  assert.equal(res.reason, "owner_override", "the all scope keeps owner_override (Q3)");
  assert.deepEqual(res.decision, { action: "route", ref: SONNET, provider: "anthropic", model: "claude-sonnet-4-6" });
  assert.equal(res.pins.all.status, "applied");
  assert.equal(res.pins.task, null, "no label, so no task scope");
  assert.deepEqual(res.rationale.details, { matched_rule: "owner_override" }, "all scope keeps minimal 2.2.x details");
});

test("order: an all-tasks pin beats the configured route", async () => {
  const c = core(v2(allPin(SONNET)), { mode: "configured", configuredRoutes: { default: FLASH } });
  const res = await c.decide(request(), { decision: record() });
  assert.equal(res.reason, "owner_override");
  assert.equal(res.decision.ref, SONNET, "not the configured FLASH");
  assert.equal(res.pins.all.status, "applied");
});

test("order: a task pin beats BOTH a request selection and the configured route for the same label", async () => {
  const c = core(v2(taskPin("inventory-sync", OPUS)), { mode: "configured", configuredRoutes: { "inventory-sync": FLASH } });
  const res = await c.decide(request({ ...withLabel("inventory-sync"), ...pick(SONNET, "request") }), { decision: record() });
  assert.equal(res.reason, "task_pin");
  assert.equal(res.decision.ref, OPUS, "beats request SONNET and configured FLASH");
  assert.equal(res.pins.task.status, "applied");
});

test("order: with no applicable pin, a request selection beats the configured route", async () => {
  const c = core(v2({}), { mode: "configured", configuredRoutes: { default: FLASH } });
  const res = await c.decide(request(pick(SONNET, "request")), { decision: record() });
  assert.equal(res.reason, "request_selection");
  assert.deepEqual(res.decision, { action: "passthrough" });
  assert.equal(res.pins.task, null);
  assert.equal(res.pins.all, null);
});

test("order: with no pin and no selection, the configured route applies and pins ride along (null)", async () => {
  const c = core(v2({}), { mode: "configured", configuredRoutes: { default: FLASH } });
  const res = await c.decide(request(), { decision: record() });
  assert.equal(res.reason, "configured");
  assert.equal(res.decision.ref, FLASH);
  assert.deepEqual(res.pins, { labelSeen: null, task: null, all: null });
});

test("pins block: a label with no task pin reports task:null but carries labelSeen so the host can offer to pin", async () => {
  const c = core(v2(allPin(SONNET)));
  const res = await c.decide(request(withLabel("fresh-task")), { decision: record() });
  assert.equal(res.pins.labelSeen, "fresh-task");
  assert.equal(res.pins.task, null);
  assert.equal(res.pins.all.status, "applied");
});

test("pins block: an expired all pin is reported not_applied/expired and the turn routes as unpinned", async () => {
  const c = core(v2({ all: { active: true, model_ref: SONNET, set_by: "x", set_at_ms: BASE, expires_at_ms: BASE - 1 } }),
    { mode: "configured", configuredRoutes: { default: FLASH } });
  const res = await c.decide(request(), { decision: record() });
  assert.equal(res.reason, "configured");
  assert.equal(res.decision.ref, FLASH);
  assert.equal(res.pins.all.status, "not_applied");
  assert.equal(res.pins.all.reason, "expired");
});

test("pins block: a malformed pin fails closed, routes as unpinned, and warns loudly once", async () => {
  const warns = [];
  const c = core(v2({ all: { active: true, model_ref: SONNET, set_by: "x", set_at_ms: BASE, expires_at_ms: null } }),
    { mode: "configured", configuredRoutes: { default: FLASH }, services: { fallbackLogger: { warn: (m) => warns.push(m) } } });
  const res = await c.decide(request(), { decision: record() });
  assert.equal(res.reason, "configured", "fail-closed: routes as if unpinned");
  assert.equal(res.pins.all.status, "not_applied");
  assert.equal(res.pins.all.reason, "malformed");
  assert.equal(warns.length, 1, "loud exactly once per file version");
  const again = await c.decide(request(), { decision: record() });
  assert.equal(again.pins.all.reason, "malformed", "still reported");
  assert.equal(warns.length, 1, "quiet on the cached version");
});

test("family pin (T4): without a resolved member it is reported unavailable, never silent", async () => {
  // No familyResolver wired → the family resolves to nothing and the pin is
  // reported `unavailable` with the resolver's reason (the deferred seam is gone).
  const c = core(v2({ "task:t": { active: true, family: "google/*", set_by: "x", set_at_ms: BASE } }),
    { mode: "configured", configuredRoutes: { default: FLASH } });
  const res = await c.decide(request(withLabel("t")), { decision: record() });
  assert.equal(res.reason, "configured", "an unresolved family pin does not apply");
  assert.equal(res.pins.task.status, "not_applied");
  assert.equal(res.pins.task.reason, "unavailable");
  assert.equal(res.pins.task.pin_target, "family");
  assert.equal(res.pins.task.family, "google/*");
  assert.equal(res.pins.task.resolved_ref, null);
  assert.equal(res.pins.task.resolution_reason, "no-configured-child");
});

test("family pin (T4, §5.1): a wired resolver resolves the family and the pin applies", async () => {
  const familyResolver = (family) => family === "google/*" ? { child: FLASH, reason: "newest-configured-release" } : { child: null, reason: "no-configured-child" };
  const c = core(v2({ "task:t": { active: true, family: "google/*", set_by: "x", set_at_ms: BASE } }),
    { mode: "configured", configuredRoutes: { default: SONNET }, services: { familyResolver } });
  const res = await c.decide(request(withLabel("t")), { decision: record() });
  assert.equal(res.reason, "task_pin");
  assert.equal(res.decision.ref, FLASH);
  assert.equal(res.pins.task.status, "applied");
  assert.equal(res.pins.task.pin_target, "family");
  assert.equal(res.pins.task.family, "google/*");
  assert.equal(res.pins.task.resolved_ref, FLASH);
  assert.equal(res.pins.task.resolution_reason, "newest-configured-release");
});

test("family route (T4, §5.2): a configured family: route resolves to the newest member", async () => {
  const familyResolver = (family) => family === "google/*" ? { child: FLASH, reason: "newest-configured-release" } : { child: null, reason: "invalid-lineage" };
  const c = core(v2({}), { mode: "configured", configuredRoutes: { default: "family:google/*" }, services: { familyResolver } });
  const res = await c.decide(request(withLabel("x")), { decision: record() });
  assert.equal(res.reason, "configured");
  assert.equal(res.decision.ref, FLASH);
});

test("family route (T4, §5.2): an unresolved family: route is a loud passthrough, not a silent model", async () => {
  const familyResolver = () => ({ child: null, reason: "invalid-lineage" });
  const c = core(v2({}), { mode: "configured", configuredRoutes: { default: "family:nope" }, services: { familyResolver } });
  const res = await c.decide(request(withLabel("x")), { decision: record() });
  assert.equal(res.reason, "passthrough");
  assert.equal(res.decision.action, "passthrough");
  assert.equal(res.rationale.details.reason, "family route unresolved");
  assert.equal(res.rationale.details.resolutionReason, "invalid-lineage");
});

test("audit (T6, §4.3): OWNER_PIN_CHANGE fires once per file version, carrying scopes", async () => {
  const events = [];
  const c = core(v2({ ...allPin(SONNET), ...taskPin("inventory-sync", OPUS) }), { services: { audit: { emit: (e) => events.push(e) } } });
  await c.decide(request(withLabel("inventory-sync")), { decision: record() });
  const change = events.filter((e) => e.event === "owner_pin_change");
  assert.equal(change.length, 1, "one OWNER_PIN_CHANGE on the first observation");
  assert.equal(change[0].outcome, "noop");
  assert.ok(change[0].details.scopes.some((s) => s.scope === "all"));
  assert.ok(change[0].details.scopes.some((s) => s.scope === "task:inventory-sync" && s.pin_target === "model"));
  await c.decide(request(withLabel("inventory-sync")), { decision: record() });
  assert.equal(events.filter((e) => e.event === "owner_pin_change").length, 1, "quiet on the cached version");
});

test("audit (T6, §4.3): OWNER_PIN_REJECTED fires on a malformed scope (fail-closed)", async () => {
  const events = [];
  const c = core(v2({ all: { active: true, model_ref: SONNET, set_by: "x", set_at_ms: BASE, expires_at_ms: null } }),
    { mode: "configured", configuredRoutes: { default: FLASH }, services: { audit: { emit: (e) => events.push(e) } } });
  await c.decide(request(), { decision: record() });
  const rej = events.filter((e) => e.event === "owner_pin_rejected");
  assert.equal(rej.length, 1);
  assert.equal(rej[0].outcome, "failure");
  assert.equal(rej[0].details.rejected[0].scope, "all");
});

test("order: decide() applies a task pin for a mixed-case incoming label (§3.5 end-to-end)", async () => {
  const c = core(v2(taskPin("inventory-sync", OPUS)), { mode: "configured", configuredRoutes: { default: FLASH } });
  const res = await c.decide(request(withLabel("  INVENTORY-SYNC ")), { decision: record() });
  assert.equal(res.reason, "task_pin");
  assert.equal(res.decision.ref, OPUS);
  assert.equal(res.pins.labelSeen, "inventory-sync");
});

test("pins block: the block is present on every decision path", async () => {
  const c = core(v2(allPin(SONNET)), { mode: "configured", configuredRoutes: { default: FLASH } });
  for (const over of [{}, withLabel("x"), pick(FLASH, "user"), pick(FLASH, "request")]) {
    const res = await c.decide(request(over), { decision: record() });
    assert.ok(res.pins && "labelSeen" in res.pins && "task" in res.pins && "all" in res.pins, `pins present for ${JSON.stringify(over)}`);
  }
});
