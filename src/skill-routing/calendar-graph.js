/*
 * ToggleLogic (Free Tier) — Microsoft Graph /me/calendarView grounding port.
 * (c) 2026 Motherboard, Inc. Source-available under the ToggleLogic Free-Tier
 * License (see LICENSE). PATENT PENDING.
 *
 * The 2026-09-15 incident fabricated a meeting brief from history because there
 * was no authoritative calendar check. This is the deterministic grounding port
 * the meeting-prep contract calls BEFORE any child executes:
 *
 *   - Microsoft Outlook via Microsoft Graph `/me/calendarView` is the ONE
 *     authoritative calendar. Nothing else (memory, chat, Zoom) is a calendar.
 *   - It returns a UNIQUE matching future event only. Zero matches, MULTIPLE /
 *     ambiguous matches, an auth failure, a timeout, or any transport error all
 *     FAIL CLOSED (return null) → the contract then asks the owner to clarify and
 *     never fabricates. A prompt-only "the meeting is in the future" claim is
 *     never trusted.
 *   - Zoom is strictly SUBORDINATE: this port never consults Zoom. Zoom history
 *     may be used only AFTER a real event is confirmed, by the child, per the
 *     injected contract.
 *
 * The port is transport-injected: a deployment wires `transport` to the installed
 * microsoft-graph skill (or a Graph HTTP client). The plugin holds no Graph
 * credentials itself, so it makes no network call here; tests inject a fake
 * transport. `findEvent` matches the calendarPort shape skill-contracts expects
 * and NEVER throws.
 */

const DEFAULT_TIMEOUT_MS = 8000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MATCH_TOLERANCE_MIN = 5;

function localMinutesOfDay(instantMs, timeZone) {
  try {
    const fmt = new Intl.DateTimeFormat("en-US", { timeZone, hour12: false, hour: "2-digit", minute: "2-digit" });
    const parts = {};
    for (const part of fmt.formatToParts(new Date(instantMs))) parts[part.type] = part.value;
    const hour = parts.hour === "24" ? 0 : Number(parts.hour);
    return hour * 60 + Number(parts.minute);
  } catch {
    const d = new Date(instantMs);
    return d.getHours() * 60 + d.getMinutes();
  }
}

// Parse a Graph event start. We request UTC (Prefer header) so dateTime ends in
// Z; explicit offsets are also honored. A named-timezone-without-offset value is
// treated as UNPARSEABLE (returns null) so we never guess an instant — that
// event simply does not count as a confident match (fail-closed).
function eventStartMs(event) {
  const start = event?.start;
  const raw = typeof start === "string" ? start : start?.dateTime;
  if (typeof raw !== "string" || !raw) return null;
  const hasZoneInfo = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(raw.trim());
  if (!hasZoneInfo) {
    // Only trust a bare local time if Graph labeled it UTC.
    const tz = String(start?.timeZone || "").toLowerCase();
    if (tz !== "utc") return null;
    const parsed = Date.parse(`${raw.trim()}Z`);
    return Number.isFinite(parsed) ? parsed : null;
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function withTimeout(promise, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("calendar lookup timed out")), timeoutMs);
    Promise.resolve(promise).then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

/**
 * createGraphCalendarPort({ transport, timeoutMs, logger }) → { findEvent }.
 *
 * transport(request) is deployment-supplied and returns a Graph response:
 *   request = { method:"GET", path:"/me/calendarView", query:{ startDateTime, endDateTime }, headers:{ Prefer } }
 *   response = { value:[ { id, subject, start:{ dateTime, timeZone } }, ... ] }
 * A rejected/timed-out/auth-failed transport (or a non-array `value`) fails
 * closed. If `transport` is not a function the port returns null on every call,
 * so a deployment that has not wired Graph gets clarify-not-fabricate behavior.
 */
export function createGraphCalendarPort({ transport, timeoutMs = DEFAULT_TIMEOUT_MS, logger } = {}) {
  const hasTransport = typeof transport === "function";

  async function findEvent({ minutesOfDay, nowMs, timeZone } = {}) {
    if (!hasTransport || !Number.isFinite(minutesOfDay) || !Number.isFinite(nowMs)) return null;
    // Bounded window: from now to end of the next 24h (the future meeting the
    // owner referenced today). Past references are already clarified upstream.
    const startDateTime = new Date(nowMs).toISOString();
    const endDateTime = new Date(nowMs + DAY_MS).toISOString();
    let response;
    try {
      response = await withTimeout(
        transport({
          method: "GET",
          path: "/me/calendarView",
          query: { startDateTime, endDateTime },
          // Ask Graph to return event times in UTC so eventStartMs is unambiguous.
          headers: { Prefer: 'outlook.timezone="UTC"' },
        }),
        timeoutMs,
      );
    } catch (error) {
      // auth failure / timeout / network / transport throw → fail closed.
      logger?.warn?.(`togglelogic calendar port: lookup failed, failing closed: ${String(error?.message ?? error).slice(0, 200)}`);
      return null;
    }

    const events = Array.isArray(response?.value) ? response.value : null;
    if (!events) return null; // malformed / auth-shaped error body → fail closed

    const matches = [];
    for (const event of events) {
      const startMs = eventStartMs(event);
      if (startMs === null || startMs <= nowMs) continue; // unparseable or not future
      const eventMinutes = localMinutesOfDay(startMs, timeZone);
      if (Math.abs(eventMinutes - minutesOfDay) <= MATCH_TOLERANCE_MIN) {
        matches.push({ id: event.id ?? null, subject: event.subject ?? null, startMs });
      }
    }

    // UNIQUE future event only. Zero or multiple (ambiguous) → fail closed.
    if (matches.length !== 1) {
      if (matches.length > 1) logger?.warn?.(`togglelogic calendar port: ${matches.length} events at the referenced time — ambiguous, failing closed`);
      return null;
    }
    return matches[0];
  }

  return { findEvent, hasTransport };
}
