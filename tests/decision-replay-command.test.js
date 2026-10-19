/*
 * ToggleLogic (Free Tier) — M1 step 5: togglelogic-decide replay command.
 * (c) 2026 Motherboard, Inc. Source-available under the ToggleLogic Free-Tier
 * License (see LICENSE); all rights reserved.
 * PATENT PENDING.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { normalizeConfig } from "../src/config/normalize.js";
import { replayRecords, NOT_REPLAYABLE } from "../src/core/replay.js";
import { policyDigestOf } from "../src/core/decide.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, "fixtures/decision-matrix");
const BIN = path.join(here, "../bin/togglelogic-decide.js");
const config = () => normalizeConfig(JSON.parse(fs.readFileSync(path.join(fixtures, "openclaw.json"), "utf8")).plugins.entries.togglelogic.config);
const lines = () => fs.readFileSync(path.join(fixtures, "routing.jsonl"), "utf8").split("\n");

test("replay classifies replayable vs not, and reports only real differences", async () => {
  const report = await replayRecords(lines(), config());
  assert.equal(report.total, 8);
  assert.equal(report.unparseable, 1);
  assert.deepEqual(report.notReplayable, { owner_override: 1, provider_unavailable: 1, intelligence: 1 });
  assert.equal(report.replayed, 4);
  assert.equal(report.matched, 3, "cheap default and both precedence records replay identically");
  assert.deepEqual(report.differences, [{ requestId: "r7", timestamp: "2026-10-19T10:06:00.000Z",
    recorded: { reason: "cheap_default", model: "anthropic/claude-sonnet-4-6" }, replayed: { reason: "cheap_default", model: "google/gemini-3.5-flash" } }]);
  assert.equal(report.policyDigest, policyDigestOf(config()));
});

test("every reason outside the replayable set is named with why", () => {
  for (const reason of ["owner_override", "intelligence", "intelligence_shadow", "pin", "provider_unavailable", "fallback_unresolved", "fallback"]) {
    assert.equal(typeof NOT_REPLAYABLE[reason], "string");
  }
});

test("togglelogic-decide replay prints a summary, exits 2 on differences, and writes nothing", () => {
  const before = fs.readdirSync(fixtures).sort();
  const run = spawnSync(process.execPath, [BIN, "replay", "--log", path.join(fixtures, "routing.jsonl"), "--config", path.join(fixtures, "openclaw.json")], { encoding: "utf8" });
  assert.equal(run.status, 2, run.stderr);
  assert.match(run.stdout, /^policy sha256:[a-f0-9]{64}$/m);
  assert.match(run.stdout, /records 8; replayed 4; matched 3; differ 1; unparseable 1/);
  assert.match(run.stdout, /not replayable: owner_override 1, provider_unavailable 1, intelligence 1/);
  assert.match(run.stdout, /DIFF r7 .*cheap_default anthropic\/claude-sonnet-4-6 -> cheap_default google\/gemini-3.5-flash/);
  const json = spawnSync(process.execPath, [BIN, "replay", "--log", path.join(fixtures, "routing.jsonl"), "--config", path.join(fixtures, "openclaw.json"), "--json"], { encoding: "utf8" });
  assert.equal(JSON.parse(json.stdout).differences.length, 1);
  assert.deepEqual(fs.readdirSync(fixtures).sort(), before);
});

test("togglelogic-decide rejects bad usage", () => {
  for (const args of [["serve"], ["replay", "--log"], ["replay", "--config", "x.json"], ["replay", "--log", "a", "--bogus", "b"]]) {
    const run = spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8" });
    assert.equal(run.status, 1, args.join(" "));
  }
  const help = spawnSync(process.execPath, [BIN, "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0); assert.match(help.stdout, /togglelogic-decide replay/);
});

test("replay keeps a provider whose model id contains a slash (no false difference)", async () => {
  const rec = { requestId: "s1", requestedProvider: "openrouter", requestedModel: "anthropic/claude-x", modelOverrideSource: "user",
    selectedModel: "openrouter/anthropic/claude-x", selectedProvider: "openrouter", selectionReason: "user_selection", selectionDetails: {} };
  const report = await replayRecords([JSON.stringify(rec)], normalizeConfig({ mode: "cheap", cheapHeuristic: { default: "google/gemini-3.5-flash" } }));
  assert.equal(report.replayed, 1); assert.equal(report.matched, 1, JSON.stringify(report.differences));
});

test("replay never claims a match for a record whose task label the log does not carry", async () => {
  const policy = normalizeConfig({ mode: "configured", configuredRoutes: { coding: "anthropic/claude-sonnet-4-6", default: "google/gemini-3.5-flash" } });
  const fellToDefault = { requestId: "c1", requestedProvider: "anthropic", requestedModel: "claude-haiku-4-5", selectedModel: "google/gemini-3.5-flash", selectedProvider: "google", selectionReason: "configured", selectionDetails: { matchedKey: "default" }, mode: "configured" };
  const noMatch = { requestId: "c2", requestedProvider: "anthropic", requestedModel: "claude-haiku-4-5", selectedModel: null, selectedProvider: null, selectionReason: "passthrough", selectionDetails: { reason: "no configured match" }, mode: "configured" };
  const labelled = { requestId: "c3", requestedProvider: "anthropic", requestedModel: "claude-haiku-4-5", selectedModel: "anthropic/claude-sonnet-4-6", selectedProvider: "anthropic", selectionReason: "configured", selectionDetails: { matchedKey: "coding" }, mode: "configured" };
  const report = await replayRecords([fellToDefault, noMatch, labelled].map((r) => JSON.stringify(r)), policy);
  assert.deepEqual(report.notReplayable, { task_label_not_logged: 2 });
  assert.equal(report.replayed, 1); assert.equal(report.matched, 1);
  const defaultOnly = await replayRecords([JSON.stringify(fellToDefault)], normalizeConfig({ mode: "configured", configuredRoutes: { default: "google/gemini-3.5-flash" } }));
  assert.equal(defaultOnly.matched, 1, "with only a default route the label cannot matter");
});
