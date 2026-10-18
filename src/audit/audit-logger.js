/*
 * ToggleLogic (Free Tier) — model-routing plugin for OpenClaw.
 * (c) 2026 Motherboard, Inc. Source-available under the ToggleLogic Free-Tier
 * License (see LICENSE); all rights reserved.
 * PATENT PENDING. The benchmark Intelligence engine + Toggle Registry are NOT
 * in this package.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { resolvePath } from "../path-utils.js";

import { AUDIT_SCHEMA, EVENTS, OUTCOMES, controlsFor } from "./audit-events.js";

/**
 * Structured audit writer.
 *
 * Separate from the routing log on purpose:
 *   togglelogic-routing.log: routing-decision-specific (only when routing
 *     capability is on)
 *   togglelogic-audit.jsonl: ALL consequential plugin actions, on for the
 *     lifetime of the plugin
 *
 * Writes are serialized through a promise chain. Audit failures never break
 * the dispatch path, but they are never silent either (2.1.5): every failed
 * write is counted; an error-level host log is written on the first failure
 * and then at most once per FAILURE_REPORT_INTERVAL_MS with cumulative and
 * since-last-report counts; health() reports the audit capability as not
 * ready; failure-report listeners are notified (the plugin forwards these to
 * the usage-events stream, an independent sink); and the first successful
 * write afterwards is followed by an `audit.write.recovered` record in the
 * audit stream itself stating exactly how many records were lost and when.
 *
 * Rotation cascades just like the routing logger to keep the file count
 * bounded: the active file plus `.1` through `.5`. Retention beyond those
 * files is the deployment's job (offload to SIEM / object storage).
 *
 * Caller pattern: audit.emit({...}) is fire-and-forget. The returned
 * promise can be awaited only when the caller specifically needs to
 * guarantee durability before responding.
 */

const MAX_ROTATION_INDEX = 4; // renames .1-.4 up one, so files .1 through .5 are kept
export const FAILURE_REPORT_INTERVAL_MS = 60_000;

export function createAuditLogger(auditConfig, hostLogger, runtimeMeta = {}, deps = {}) {
  const now = typeof deps.now === "function" ? deps.now : () => Date.now();
  const fsApi = deps.fs ?? fs;
  const config = auditConfig ?? {};
  const enabled = config.enabled !== false;
  const targetPath = resolvePath(
    config.path ?? "~/.openclaw/logs/togglelogic-audit.jsonl",
    deps.paths ?? null
  );
  const rotateBytes = Math.max(1, config.rotateSizeMb ?? 50) * 1024 * 1024;

  const sessionId = generateSessionId();
  const startedAt = new Date().toISOString();

  let writeQueue = Promise.resolve();
  // Failure accounting. `total` and the timestamps cover the current failure
  // window (reset when a recovery record is written); `lifetime` never resets.
  const failures = { total: 0, sinceReport: 0, lifetime: 0, firstAt: null, lastAt: null, lastErrorCode: null, lastReportAt: null };
  const failureListeners = new Set();

  async function ensureDir() {
    await fsApi.mkdir(path.dirname(targetPath), { recursive: true });
  }

  async function rotateIfNeeded() {
    let stats;
    try {
      stats = await fsApi.stat(targetPath);
    } catch {
      return;
    }
    if (stats.size < rotateBytes) return;
    for (let i = MAX_ROTATION_INDEX; i >= 1; i--) {
      try {
        await fsApi.rename(`${targetPath}.${i}`, `${targetPath}.${i + 1}`);
      } catch {
        /* missing rotation file — skip */
      }
    }
    try {
      await fsApi.rename(targetPath, `${targetPath}.1`);
    } catch {
      /* fallthrough: append will create a fresh file */
    }
  }

  async function writeOnce(record) {
    const line = JSON.stringify(record) + "\n";
    await ensureDir();
    await rotateIfNeeded();
    await fsApi.appendFile(targetPath, line, { encoding: "utf8", mode: 0o600 });
  }

  function shapeRecord(input) {
    const event = input?.event ?? "unknown";
    const outcome = input?.outcome ?? OUTCOMES.SUCCESS;
    const correlationId = input?.correlationId ?? generateCorrelationId();
    return {
      "@timestamp": new Date(now()).toISOString(),
      "@version": "1",
      auditSchema: AUDIT_SCHEMA,
      pluginId: runtimeMeta.pluginId ?? "togglelogic",
      pluginVersion: runtimeMeta.pluginVersion ?? "unknown",
      session: { id: sessionId, startedAt },
      controls: controlsFor(event),
      event,
      outcome,
      principal: redactPrincipal(input?.principal),
      subject: input?.subject ?? null,
      details: input?.details ?? null,
      correlationId,
    };
  }

  function errorCode(err) {
    const code = err && typeof err.code === "string" ? err.code : null;
    return code && /^[A-Z0-9_]{1,32}$/.test(code) ? code : "EUNKNOWN";
  }

  function report() {
    const at = now();
    const info = {
      failedCount: failures.total,
      sinceLastReport: failures.sinceReport,
      firstFailureAt: failures.firstAt,
      lastFailureAt: failures.lastAt,
      errorCode: failures.lastErrorCode,
      path: targetPath,
    };
    failures.sinceReport = 0;
    failures.lastReportAt = at;
    try {
      hostLogger?.error?.(
        `togglelogic-audit: audit write failing (${info.errorCode}) at ${targetPath}; ` +
        `${info.failedCount} record(s) not written since ${info.firstFailureAt} ` +
        `(${info.sinceLastReport} since the last report). The audit capability is NOT READY; ` +
        `routing continues. A recovery record will state the gap once writes succeed.`
      );
    } catch { /* ignore logger failures */ }
    for (const listener of failureListeners) {
      try { void Promise.resolve(listener(info)).catch(() => {}); } catch { /* ignore listener failures */ }
    }
  }

  function recordFailure(err) {
    const at = new Date(now()).toISOString();
    failures.total += 1;
    failures.sinceReport += 1;
    failures.lifetime += 1;
    failures.firstAt ??= at;
    failures.lastAt = at;
    failures.lastErrorCode = errorCode(err);
    if (failures.lastReportAt === null || now() - failures.lastReportAt >= FAILURE_REPORT_INTERVAL_MS) report();
  }

  async function writeRecoveryRecord() {
    const record = shapeRecord({
      event: EVENTS.AUDIT_WRITE_RECOVERED,
      outcome: OUTCOMES.SUCCESS,
      principal: { source: "plugin" },
      details: {
        failedCount: failures.total,
        firstFailureAt: failures.firstAt,
        lastFailureAt: failures.lastAt,
        lastErrorCode: failures.lastErrorCode,
        recordsLost: failures.total,
      },
    });
    await writeOnce(record);
    try {
      hostLogger?.warn?.(
        `togglelogic-audit: audit writes recovered; ${failures.total} record(s) were not written ` +
        `between ${failures.firstAt} and ${failures.lastAt} (recorded as audit.write.recovered).`
      );
    } catch { /* ignore */ }
    failures.total = 0;
    failures.sinceReport = 0;
    failures.firstAt = null;
    failures.lastAt = null;
    failures.lastErrorCode = null;
    failures.lastReportAt = null;
  }

  function emit(input) {
    if (!enabled) return Promise.resolve();
    const record = shapeRecord(input);
    writeQueue = writeQueue.then(async () => {
      try {
        await writeOnce(record);
      } catch (err) {
        recordFailure(err);
        return;
      }
      if (failures.total > 0) {
        try { await writeRecoveryRecord(); } catch (err) { recordFailure(err); }
      }
    });
    return writeQueue;
  }

  function health() {
    if (!enabled) return { id: "audit", enabled: false, ready: true, reason: "disabled" };
    const failing = failures.total > 0;
    return {
      id: "audit",
      enabled: true,
      ready: !failing,
      reason: failing ? "audit-write-failing" : "ok",
      failures: { current: failures.total, lifetime: failures.lifetime, firstFailureAt: failures.firstAt,
        lastFailureAt: failures.lastAt, lastErrorCode: failures.lastErrorCode },
    };
  }

  function onFailureReport(listener) {
    if (typeof listener !== "function") return () => {};
    failureListeners.add(listener);
    return () => failureListeners.delete(listener);
  }

  function flush() {
    return writeQueue;
  }

  // Pre-bound emitter useful for capability registration code that wants a
  // simple `audit("event-name", { outcome, principal, ... })` call site.
  function emitter(event) {
    return (partial = {}) => emit({ event, ...partial });
  }

  return {
    emit,
    emitter,
    flush,
    health,
    onFailureReport,
    path: targetPath,
    enabled,
    sessionId,
    // Expose a correlation-id generator so callers that need to pair related
    // audit records (e.g. an async two-phase operation: attempt-then-delivery)
    // can link them with a stable id. Phase 5 (2026-05-14) added this for
    // dispatch.tier1.ack's attempted/delivered split.
    correlationId: generateCorrelationId,
  };
}

function generateSessionId() {
  return `audit-${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
}

function generateCorrelationId() {
  return `corr-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
}

/**
 * Defensive principal redaction. The plugin's callers can be sloppy and
 * pass things they shouldn't (full message bodies, raw tokens). This is
 * the last line of defence before serialization to the audit stream.
 *
 * Allowed principal fields: source, agentId, channel, sessionKey, messageId,
 * userId (Telegram chat id is fine — it's the identity, not a secret).
 * Anything else is dropped.
 */
function redactPrincipal(principal) {
  if (!principal || typeof principal !== "object") return null;
  const allowed = ["source", "agentId", "channel", "sessionKey", "messageId", "userId"];
  const out = {};
  for (const k of allowed) {
    if (principal[k] !== undefined && principal[k] !== null) {
      out[k] = String(principal[k]).slice(0, 256);
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}
