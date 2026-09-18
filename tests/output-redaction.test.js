import { test } from "node:test";
import assert from "node:assert/strict";

import { redactSensitiveMeetingAccess } from "../src/skill-routing/output-redaction.js";

test("meeting-access details are deterministically removed from a child briefing", () => {
  const source = [
    "Join https://us02web.zoom.us/j/8602082320?pwd=example.",
    "Backup https://teams.microsoft.com/l/meetup-join/example",
    "Government session https://agency.zoomgov.com/j/123456789?pwd=example",
    "Meeting ID: 860 208 2320",
    "with passcode ClickIT and dial-in PIN 123456",
    "Keep the verified title and attendee context.",
  ].join("\n");
  const result = redactSensitiveMeetingAccess(source);
  assert.ok(result.redactions >= 6);
  assert.doesNotMatch(result.text, /zoom\.us|zoomgov\.com|teams\.microsoft\.com|860\s*208|ClickIT|123456/i);
  assert.match(result.text, /meeting join link redacted/i);
  assert.match(result.text, /passcode: \[redacted\]/i);
  assert.match(result.text, /Keep the verified title and attendee context/);
});

test("ordinary meeting content is preserved when no access secret is present", () => {
  const source = "Discuss renewal risks with the client and ask who owns the final decision.";
  assert.deepEqual(redactSensitiveMeetingAccess(source), { text: source, redactions: 0 });
});
