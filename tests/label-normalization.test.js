/*
 * ToggleLogic (Free Tier) — M6 §3.5: identical lowercase+trim label normalization
 * on the incoming task label and the configuredRoutes keys, with a loud collision.
 * (c) 2026 Motherboard, Inc. Source-available under the ToggleLogic Free-Tier
 * License (see LICENSE); all rights reserved.
 * PATENT PENDING.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeConfig, normalizeConfiguredRoutes, warnConfiguredRouteCollisions } from "../src/config/normalize.js";
import { normalizeLabel, configuredTaskLabel, pickConfiguredRoute } from "../src/routing/modes.js";
import { resolveOwnerPins } from "../src/routing/owner-pins.js";

const FLASH = "google/gemini-3.5-flash";
const SONNET = "anthropic/claude-sonnet-4-6";
const OPUS = "anthropic/claude-opus-4-8";

test("normalizeLabel and configuredTaskLabel both lowercase + trim (one rule)", () => {
  assert.equal(normalizeLabel("  Inventory-Sync "), "inventory-sync");
  assert.equal(normalizeLabel("SUMMARIZE"), "summarize");
  assert.equal(normalizeLabel(42), "");
  assert.equal(configuredTaskLabel({ taskType: "  Summarize " }, {}), "summarize");
  assert.equal(configuredTaskLabel({}, { capability: "Inventory-Sync" }), "inventory-sync");
  assert.equal(configuredTaskLabel({}, {}), null);
});

test("configuredRoutes keys are lowercased+trimmed so a mixed-case label matches", () => {
  const config = normalizeConfig({ mode: "configured", configuredRoutes: { "  Summarize ": FLASH, "Inventory-Sync": SONNET } });
  assert.deepEqual(config.configuredRoutes, { summarize: FLASH, "inventory-sync": SONNET });
  assert.deepEqual(config.configuredRoutesCollisions, []);
  // Any case of the incoming label resolves to the same normalized route.
  assert.equal(pickConfiguredRoute(config.configuredRoutes, { taskType: "SUMMARIZE" }, {}).modelId, FLASH);
  assert.equal(pickConfiguredRoute(config.configuredRoutes, {}, { task: "inventory-sync" }).modelId, SONNET);
});

test("a configuredRoutes key collision keeps the last and is recorded for a loud warning", () => {
  const { routes, collisions } = normalizeConfiguredRoutes({ "Inventory-Sync": FLASH, "inventory-sync": SONNET });
  assert.deepEqual(routes, { "inventory-sync": SONNET }, "the last key wins");
  assert.equal(collisions.length, 1);
  assert.equal(collisions[0].normalized, "inventory-sync");
  assert.deepEqual(collisions[0].keys, ["Inventory-Sync", "inventory-sync"]);
  // normalizeConfig surfaces the same collision data.
  assert.deepEqual(normalizeConfig({ configuredRoutes: { "Inventory-Sync": FLASH, "inventory-sync": SONNET } }).configuredRoutesCollisions,
    [{ normalized: "inventory-sync", keys: ["Inventory-Sync", "inventory-sync"] }]);
});

test("warnConfiguredRouteCollisions emits a loud audit event + logger warning, and is a no-op when clean", () => {
  const audits = []; const warns = [];
  const sink = { audit: { emit: (e) => audits.push(e) }, logger: { warn: (m) => warns.push(m) } };
  assert.equal(warnConfiguredRouteCollisions([], sink), false);
  assert.equal(audits.length, 0); assert.equal(warns.length, 0);

  const warned = warnConfiguredRouteCollisions([{ normalized: "inventory-sync", keys: ["Inventory-Sync", "inventory-sync"] }], sink);
  assert.equal(warned, true);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].event, "config.load");
  assert.equal(audits[0].outcome, "failure");
  assert.equal(audits[0].details.check, "configured_routes_collision");
  assert.equal(warns.length, 1);
  assert.match(warns[0], /collide after normalization/);
});

test("end-to-end: a pin set for `Inventory-Sync` matches a turn labelled `inventory-sync`", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tl-labelnorm-"));
  const p = path.join(dir, "pins.json");
  // The CLI (T5) normalizes the scope key; here we store it already normalized.
  fs.writeFileSync(p, JSON.stringify({ schema: "togglelogic-owner-pins/v2", pins: { "task:inventory-sync": { active: true, model_ref: OPUS, set_by: "togglelogic-pin", set_at_ms: 1 } } }));
  // configuredTaskLabel normalizes "Inventory-Sync" -> "inventory-sync", which the resolver matches.
  const label = configuredTaskLabel({}, { taskType: "Inventory-Sync" });
  assert.equal(label, "inventory-sync");
  const r = resolveOwnerPins({ enabled: true, statePath: p }, { label });
  assert.equal(r.task?.resolvedRef, OPUS);
});
