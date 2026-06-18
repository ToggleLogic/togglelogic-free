/*
 * ToggleLogic (Free Tier) — model-routing plugin for OpenClaw.
 * (c) 2026 Motherboard, Inc. Source-available under the ToggleLogic Free-Tier
 * License (see LICENSE): free, limited, REVOCABLE use; all rights reserved.
 * PATENT PENDING. The benchmark Intelligence engine + Toggle Registry are NOT
 * in this package.
 */

import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { resolveOwnerOverride } from "../routing/owner-override.js";

function expandTilde(p) {
  if (typeof p !== "string") return p;
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return homedir() + p.slice(1);
  return p;
}

// User-facing channels only (same generic set as turn-end capture). The
// consumer decides which one is the owner; the engine stays channel-agnostic.
const NOTIFY_CHANNELS = new Set(["telegram", "slack", "discord"]);
// Skip short acks ("On it.") — only a substantive outbound counts as a task
// completion worth prompting about. Same threshold class as turn-end capture.
const MIN_TURN_CHARS = 80;
const PY = "/usr/bin/python3"; // production interpreter (stock macOS)

/**
 * Build the message_sending handler. Contract: (event, ctx) => Promise<void>.
 * Always returns undefined — observe + notify only; never rewrites outbound.
 */
export function createOwnerOverrideAskHandler({ config, fallbackLogger }) {
  const oo = (config && config.ownerOverride) || {};
  const consumer = expandTilde(oo.askConsumer);

  return async function ownerOverrideAskHandler(event, ctx) {
    try {
      if (!consumer || typeof consumer !== "string") return;
      const channelId = (ctx && ctx.channelId) || "";
      if (!NOTIFY_CHANNELS.has(channelId)) return;
      const content =
        event && typeof event.content === "string" ? event.content : "";
      if (!content || content.length < MIN_TURN_CHARS) return; // skip acks

      const owner = resolveOwnerOverride(oo);
      if (!owner.applied) return; // no active override → nothing to ask about

      // Generic state for the consumer. The engine supplies facts; the
      // consumer supplies all policy/wording/targeting.
      const payload = JSON.stringify({
        override_model: owner.modelRef,
        set_by: owner.state?.set_by ?? null,
        set_at_ms: owner.state?.set_at_ms ?? null,
        family_input: owner.state?.family_input ?? null,
        channel: channelId,
        completed_turn_chars: content.length,
      });

      // Fire-and-forget. stdout/stderr ignored; errors swallowed.
      const child = spawn(PY, [consumer], { stdio: ["pipe", "ignore", "ignore"] });
      child.on("error", () => {});
      try {
        child.stdin.write(payload);
        child.stdin.end();
      } catch {
        /* ignore */
      }
    } catch {
      try {
        fallbackLogger?.warn?.("togglelogic ownerOverrideAsk: handler error (suppressed)");
      } catch {
        /* ignore */
      }
    }
  };
}
