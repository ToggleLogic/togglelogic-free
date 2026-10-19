/*
 * ToggleLogic (Free Tier) — OpenClaw session-store reader.
 * (c) 2026 Motherboard, Inc. Source-available under the ToggleLogic Free-Tier
 * License (see LICENSE). PATENT PENDING.
 *
 * Reads the host's per-agent session state to recover a protected user/session
 * model selection (a "pin"). GENERIC mechanism: it reads through the host's
 * read-only session accessor when present, else a host-supplied JSON file, and
 * inspects deployment-supplied DATA; it never writes, and holds no model values. Used by the interceptor to honor a user-pinned model ABOVE the
 * classifier. Fail-soft: any read/parse issue yields a status, never throws.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function normalizeOptionalString(value) {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function normalizeAgentId(value) {
  return (normalizeOptionalString(value) ?? "main").toLowerCase();
}

function resolveHomeDir(env = process.env) {
  return env.HOME || os.homedir();
}

function expandUserPath(value, env = process.env) {
  const raw = normalizeOptionalString(value);
  if (!raw) return null;
  if (raw === "~") return resolveHomeDir(env);
  if (raw.startsWith("~/")) return path.join(resolveHomeDir(env), raw.slice(2));
  return raw;
}

function resolveStateDir(env = process.env) {
  const override = normalizeOptionalString(env.OPENCLAW_STATE_DIR);
  if (override) return path.resolve(expandUserPath(override, env));
  return path.join(resolveHomeDir(env), ".openclaw");
}

export function resolveSessionStorePath(hostConfig, hookContext, env = process.env) {
  const agentId = normalizeAgentId(hookContext?.agentId);
  const configuredStore = normalizeOptionalString(hostConfig?.session?.store);
  if (configuredStore) {
    const expanded = configuredStore.replaceAll("{agentId}", agentId);
    return path.resolve(expandUserPath(expanded, env));
  }
  return path.join(resolveStateDir(env), "agents", agentId, "sessions", "sessions.json");
}

// 2.1.4: prefer the host's own read-only session accessor
// (api.runtime.agent.session.getSessionEntry, available to every plugin on
// OpenClaw releases that keep sessions in SQLite). It returns the same session
// entry fields the legacy JSON file held, including modelOverrideSource, so a
// user pin is recognised whatever model it names. The legacy sessions.json reader
// is kept for older hosts that still have the file. Fail-soft throughout.
function readFromHostRuntime(hostSession, hookContext, sessionKey) {
  if (typeof hostSession?.getSessionEntry !== "function") return null;
  try {
    const entry = hostSession.getSessionEntry({ agentId: normalizeAgentId(hookContext?.agentId), sessionKey });
    if (!entry || typeof entry !== "object") {
      return { status: "missing_session_entry", source: "host_runtime", sessionKey };
    }
    return { status: "found", source: "host_runtime", sessionKey, entry };
  } catch (err) {
    return { status: "read_error", source: "host_runtime", sessionKey, error: String(err?.message ?? err) };
  }
}

function readFromLegacyFile(hostConfig, hookContext, sessionKey) {
  const storePath = resolveSessionStorePath(hostConfig, hookContext);
  try {
    const raw = fs.readFileSync(storePath, "utf8");
    const store = JSON.parse(raw);
    const entry = store && typeof store === "object" ? store[sessionKey] : null;
    if (!entry || typeof entry !== "object") {
      return { status: "missing_session_entry", source: "legacy_file", sessionKey, storePath };
    }
    return { status: "found", source: "legacy_file", sessionKey, storePath, entry };
  } catch (err) {
    return { status: "read_error", source: "legacy_file", sessionKey, storePath, error: String(err?.message ?? err) };
  }
}

export function readSessionSelection(hostConfig, hookContext, { hostSession = null } = {}) {
  const sessionKey = normalizeOptionalString(hookContext?.sessionKey);
  if (!sessionKey) return { status: "missing_session_key" };
  const fromHost = readFromHostRuntime(hostSession, hookContext, sessionKey);
  if (fromHost && fromHost.status !== "read_error") return fromHost;
  const fromFile = readFromLegacyFile(hostConfig, hookContext, sessionKey);
  if (fromFile.status !== "read_error" || !fromHost) return fromFile;
  return { ...fromFile, hostError: fromHost.error };
}

export function hasSessionAutoModelFallbackProvenance(entry) {
  return Boolean(
    (normalizeOptionalString(entry?.providerOverride) ||
      normalizeOptionalString(entry?.modelOverride)) &&
    normalizeOptionalString(entry?.modelOverrideFallbackOriginProvider) &&
    normalizeOptionalString(entry?.modelOverrideFallbackOriginModel)
  );
}

export function isProtectedUserSessionSelection(entry) {
  const source = normalizeOptionalString(entry?.modelOverrideSource);
  if (source === "user") return true;
  if (source === "auto" || source === "default") return false;
  return Boolean(
    normalizeOptionalString(entry?.modelOverride) &&
    !hasSessionAutoModelFallbackProvenance(entry)
  );
}
