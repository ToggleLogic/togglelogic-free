/*
 * ToggleLogic (Free Tier) — model-routing plugin for OpenClaw.
 * (c) 2026 Motherboard, Inc. Source-available under the ToggleLogic Free-Tier
 * License (see LICENSE): free, limited, REVOCABLE use; all rights reserved.
 * PATENT PENDING. The benchmark Intelligence engine + Toggle Registry are NOT
 * in this package.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

import { AUDIT_SCHEMA, OUTCOMES, controlsFor } from "./audit-events.js";

/**
 * Structured audit writer.
 *
 * Separate from the routing log on purpose:
 *   togglelogic-routing.log: routing-decision-specific (only when routing
 *     capability is on)
 *   togglelogic-audit.jsonl: ALL consequential plugin actions, on for the
 *     lifetime of the plugin
 *
 * Writes are serialized through a promise chain. Disk failures are
 * surfaced ONCE to the host logger and then suppressed — audit failures
 * must never break the dispatch path.
 *
 * Rotation cascades just like the routing logger to keep the file count
 * bounded. Audit retention beyond the 5 most recent files is the
 * deployment's job (offload to SIEM / object storage).
 *
 * Caller pattern: audit.emit({...}) is fire-and-forget. The returned
 * promise can be awaited only when the caller specifically needs to
 * guarantee durability before responding.
 */

const MAX_ROTATION_INDEX = 4; // .1 through .5

export function createAuditLogger(auditConfig, hostLogger, runtimeMeta = {}) {
  const config = auditConfig ?? {};
  const enabled = config.enabled !== false;
  const targetPath = expandTilde(
    config.path ?? "~/.openclaw/logs/togglelogic-audit.jsonl"
  );
  const rotateBytes = Math.max(1, config.rotateSizeMb ?? 50) * 1024 * 1024;

  const sessionId = generateSessionId();
  const startedAt = new Date().toISOString();

  let writeQueue = Promise.resolve();
  let everFailed = false;

  async function ensureDir() {
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
  }

  async function rotateIfNeeded() {
    let stats;
    try {
      stats = await fs.stat(targetPath);
    } catch {
      return;
    }
    if (stats.size < rotateBytes) return;
    for (let i = MAX_ROTATION_INDEX; i >= 1; i--) {
      try {
        await fs.rename(`${targetPath}.${i}`, `${targetPath}.${i + 1}`);
      } catch {
        /* missing rotation file — skip */
      }
    }
    try {
      await fs.rename(targetPath, `${targetPath}.1`);
    } catch {
      /* fallthrough: append will create a fresh file */
    }
  }

  async function writeOnce(record) {
    const line = JSON.stringify(record) + "\n";
    await ensureDir();
    await rotateIfNeeded();
    await fs.appendFile(targetPath, line, { encoding: "utf8", mode: 0o600 });
  }

  function shapeRecord(input) {
    const event = input?.event ?? "unknown";
    const outcome = input?.outcome ?? OUTCOMES.SUCCESS;
    const correlationId = input?.correlationId ?? generateCorrelationId();
    return {
      "@timestamp": new Date().toISOString(),
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

  function emit(input) {
    if (!enabled) return Promise.resolve();
    const record = shapeRecord(input);
    writeQueue = writeQueue.then(async () => {
      try {
        await writeOnce(record);
      } catch (err) {
        if (!everFailed) {
          everFailed = true;
          try {
            hostLogger?.warn?.(
              `togglelogic-audit: write failure (${err?.message ?? err}); subsequent failures suppressed for this session.`
            );
          } catch {
            /* ignore */
          }
        }
      }
    });
    return writeQueue;
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

function expandTilde(p) {
  if (typeof p !== "string") return p;
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
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
