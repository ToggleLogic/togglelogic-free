/*
 * ToggleLogic (Free Tier) — subprocess calendar bridge transport.
 * (c) 2026 Motherboard, Inc. Source-available under the ToggleLogic Free-Tier
 * License (see LICENSE). PATENT PENDING.
 *
 * BLOCKER-1 CLOSURE. The plugin holds no Microsoft Graph credentials and the
 * OpenClaw host exposes no synchronous pre-model affordance to invoke the
 * installed microsoft-graph skill from inside before_agent_reply. But the plugin
 * process CAN spawn an explicitly configured, deployment-owned bridge EXECUTABLE
 * as a child process. That bridge (microsoft-graph/scripts/calendar_bridge.py) is
 * the vault-backed, read-only, sanitized `/me/calendarView` reader; this module
 * turns it into the `transport` that createGraphCalendarPort already expects.
 *
 * This is the REAL grounding path: a deterministic subprocess call, NOT a model
 * instruction. Every failure mode fails CLOSED — a non-zero exit, a wall-clock
 * timeout (the child is killed), non-JSON or over-large output, an `ok:false`
 * envelope, or a malformed events array all reject, so createGraphCalendarPort
 * returns null and the meeting-prep contract clarifies instead of fabricating.
 *
 * INJECTION-SAFE: the child is launched with execFile + an explicit argv array
 * (never a shell), so window bounds and any other argument reach the child as
 * literal, un-split, un-interpreted strings.
 */

import { execFile } from "node:child_process";

const MAX_STDOUT_BYTES = 1024 * 1024; // 1 MiB is far more than a sanitized day of events
const DEFAULT_TIMEOUT_MS = 8000;
const EXPECTED_SCHEMA = "togglelogic-calendar-view/v1";

function cleanString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * createSubprocessCalendarTransport(bridge, { timeoutMs, logger }) →
 *   transport(request) | null
 *
 * bridge = {
 *   command : string  (required — the executable, e.g. "python3")
 *   args    : string[] (base args, e.g. ["/abs/path/calendar_bridge.py"])
 *   cwd     : string  (optional working directory)
 *   env     : object  (optional extra env MERGED onto the parent env)
 *   accountArg : string (optional deployment account nickname → "--account <x>")
 *   maxResults : number (optional → "--max-results <n>")
 * }
 *
 * Returns null when no command is configured, so a deployment that has not wired
 * the bridge gets an unwired port (clarify-not-fabricate) rather than a broken one.
 * The returned transport matches the createGraphCalendarPort contract:
 *   request  = { method, path, query:{ startDateTime, endDateTime }, headers }
 *   resolves = { value: [ { id, subject, start:{ dateTime, timeZone } }, ... ] }
 * and REJECTS on any fail-closed condition.
 */
export function createSubprocessCalendarTransport(bridge = {}, { timeoutMs = DEFAULT_TIMEOUT_MS, logger } = {}) {
  const command = cleanString(bridge?.command);
  if (!command) return null;
  const baseArgs = Array.isArray(bridge?.args) ? bridge.args.filter((a) => typeof a === "string") : [];
  const cwd = cleanString(bridge?.cwd) || undefined;
  const accountArg = cleanString(bridge?.accountArg);
  const maxResults = Number.isFinite(bridge?.maxResults) && bridge.maxResults >= 1 ? Math.floor(bridge.maxResults) : null;
  const extraEnv = bridge?.env && typeof bridge.env === "object" && !Array.isArray(bridge.env) ? bridge.env : null;
  const spawnTimeout = Number.isFinite(bridge?.timeoutMs) && bridge.timeoutMs >= 250 ? Math.floor(bridge.timeoutMs) : timeoutMs;

  function runBridge(startDateTime, endDateTime) {
    const argv = [...baseArgs, "--start", String(startDateTime), "--end", String(endDateTime)];
    if (accountArg) argv.push("--account", accountArg);
    if (maxResults) argv.push("--max-results", String(maxResults));
    return new Promise((resolve, reject) => {
      execFile(
        command,
        argv,
        {
          cwd,
          timeout: spawnTimeout,
          killSignal: "SIGKILL",
          maxBuffer: MAX_STDOUT_BYTES,
          windowsHide: true,
          // Keep HOME/PATH etc. (the bridge needs them for the vault + interpreter),
          // then layer any explicitly configured extra env on top.
          env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
          // No shell: argv elements are passed literally (injection-safe).
          shell: false,
        },
        (error, stdout) => {
          // A non-zero exit, a kill-on-timeout, or a spawn failure all fail closed.
          // The child still writes a JSON envelope on failure, but we intentionally
          // do NOT trust a failed process's stdout as a calendar answer.
          if (error) {
            const why = error.killed ? "timed out (child killed)" : `exit ${error.code ?? "?"} (${error.signal ?? error.message})`;
            reject(new Error(`calendar bridge failed: ${why}`));
            return;
          }
          resolve(stdout);
        },
      );
    });
  }

  return async function transport(request) {
    const query = request?.query || {};
    const startDateTime = cleanString(query.startDateTime);
    const endDateTime = cleanString(query.endDateTime);
    if (!startDateTime || !endDateTime) {
      throw new Error("calendar bridge transport requires startDateTime and endDateTime");
    }

    const stdout = await runBridge(startDateTime, endDateTime);

    let envelope;
    try {
      envelope = JSON.parse(String(stdout));
    } catch {
      logger?.warn?.("togglelogic calendar bridge: non-JSON output, failing closed");
      throw new Error("calendar bridge returned non-JSON output");
    }
    if (!envelope || typeof envelope !== "object") throw new Error("calendar bridge output is not an object");
    if (envelope.schema && envelope.schema !== EXPECTED_SCHEMA) {
      throw new Error(`calendar bridge schema mismatch: ${String(envelope.schema).slice(0, 64)}`);
    }
    if (envelope.ok !== true) {
      throw new Error(`calendar bridge reported failure: ${cleanString(envelope.error_class) || "unknown"}`);
    }
    if (!Array.isArray(envelope.events)) throw new Error("calendar bridge output has no events array");

    // Map the sanitized envelope into the { value: [...] } shape the port parses.
    // The bridge already emits ONLY id/subject/start/end; start is a
    // { dateTime, timeZone } object, exactly what eventStartMs consumes.
    const value = [];
    for (const event of envelope.events) {
      if (!event || typeof event !== "object") continue;
      value.push({
        id: cleanString(event.id),
        subject: cleanString(event.subject),
        start: event.start && typeof event.start === "object" ? event.start : null,
      });
    }
    return { value };
  };
}
