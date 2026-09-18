/*
 * Deterministic outbound minimization for meeting-access secrets.
 * The bounded child may need to read calendar bodies and locations to prepare
 * the owner, but join links, meeting IDs, passcodes, and dial-in PINs are not
 * part of an owner-facing briefing. Redact them in the trusted parent before
 * any child result is returned to the delivery path.
 */

const MEETING_URL_RE = /https?:\/\/(?:[a-z0-9-]+\.)*(?:zoom\.us|zoomgov\.com|zoomgov\.us|teams\.microsoft\.com|teams\.live\.com|meet\.google\.com|webex\.com)\/[^\s<>"'\])}]*/gi;
const MEETING_ID_RE = /\b(meeting\s+(?:id|number))\s*(?::|#|=|is)?\s*\d(?:[\s-]?\d){5,}\b/gi;
const ACCESS_CODE_RE = /\b((?:meeting\s+)?passcode|password|dial[-\s]?in\s+pin)\b(\s*(?::|=|is|was)?\s*)(["']?)[a-z0-9._-]{4,}\3/gi;

function replaceCount(text, pattern, replacement) {
  let count = 0;
  const value = text.replace(pattern, (...args) => {
    count += 1;
    return typeof replacement === "function" ? replacement(...args) : replacement;
  });
  return { value, count };
}

export function redactSensitiveMeetingAccess(value) {
  let text = String(value || "");
  let redactions = 0;

  let result = replaceCount(text, MEETING_URL_RE, "[meeting join link redacted]");
  text = result.value;
  redactions += result.count;

  result = replaceCount(text, MEETING_ID_RE, (_match, label) => `${label}: [redacted]`);
  text = result.value;
  redactions += result.count;

  result = replaceCount(text, ACCESS_CODE_RE, (_match, label) => `${label}: [redacted]`);
  text = result.value;
  redactions += result.count;

  return { text, redactions };
}
