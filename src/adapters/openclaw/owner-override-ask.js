/*
 * ToggleLogic (Free Tier) — model-routing plugin for OpenClaw.
 * (c) 2026 Motherboard, Inc. Source-available under the ToggleLogic Free-Tier
 * License (see LICENSE); all rights reserved.
 * PATENT PENDING. The benchmark Intelligence engine + Toggle Registry are NOT
 * in this package.
 */

import { spawn } from "node:child_process";
import { resolveOwnerPins } from "../../routing/owner-pins.js";
import { resolvePath } from "../../path-utils.js";

// User-facing channels only (same generic set as turn-end capture). The
// consumer decides which one is the owner; the engine stays channel-agnostic.
const NOTIFY_CHANNELS = new Set(["telegram", "slack", "discord"]);
// Skip short acks ("On it.") — only a substantive outbound counts as a task
// completion worth prompting about. Same threshold class as turn-end capture.
const MIN_TURN_CHARS = 80;
// The consumer's interpreter: `ownerOverride.askInterpreter`. A bare command
// name ("python3", the default) is resolved from the gateway's PATH; a value
// with a path separator or a leading "~" is a file path (Free 2.1.x always
// used /usr/bin/python3; set askInterpreter to that to keep it).
export function resolveAskInterpreter(value, paths = null) {
  const v = typeof value === "string" && value.trim() ? value.trim() : "python3";
  return v.includes("/") || v.includes("\\") || v.startsWith("~") ? resolvePath(v, paths) : v;
}

/**
 * Build the message_sending handler. Contract: (event, ctx) => Promise<void>.
 * Always returns undefined — observe + notify only; never rewrites outbound.
 */
export function createOwnerOverrideAskHandler({ config, fallbackLogger, paths = null }) {
  const oo = (config && config.ownerOverride) || {};
  const consumer = resolvePath(oo.askConsumer, paths);
  const interpreter = resolveAskInterpreter(oo.askInterpreter, paths);

  return async function ownerOverrideAskHandler(event, ctx) {
    try {
      if (!consumer || typeof consumer !== "string") return;
      const channelId = (ctx && ctx.channelId) || "";
      if (!NOTIFY_CHANNELS.has(channelId)) return;
      const content =
        event && typeof event.content === "string" ? event.content : "";
      if (!content || content.length < MIN_TURN_CHARS) return; // skip acks

      // M6 §2.3: the ask handler keeps reading the single state file by resolving
      // the `all` scope of the owner-pin resolver (which honors v1 files and v2
      // `all` pins alike). A task-only pin leaves `all` null, so it never fires.
      const all = resolveOwnerPins(oo, { paths }).all;
      if (!all || !all.eligible) return; // no active all-tasks pin → nothing to ask

      // Generic state for the consumer. The engine supplies facts; the
      // consumer supplies all policy/wording/targeting.
      const payload = JSON.stringify({
        override_model: all.resolvedRef,
        set_by: all.setBy ?? null,
        set_at_ms: all.setAtMs ?? null,
        family_input: all.family ?? null,
        channel: channelId,
        completed_turn_chars: content.length,
      });

      // Fire-and-forget. stdout/stderr ignored; errors swallowed.
      const child = spawn(interpreter, [consumer], { stdio: ["pipe", "ignore", "ignore"] });
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
