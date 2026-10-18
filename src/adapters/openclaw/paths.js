/*
 * ToggleLogic (Free Tier) — OpenClaw adapter: state locations from the host environment.
 * (c) 2026 Motherboard, Inc. Source-available under the ToggleLogic Free-Tier
 * License (see LICENSE); all rights reserved.
 * PATENT PENDING.
 */
import os from "node:os";
import path from "node:path";
import { createPaths } from "../../core/paths.js";

/**
 * OpenClaw's state locations: HOME (else the OS home), and OPENCLAW_STATE_DIR
 * (with "~" expansion) else <home>/.openclaw. Identical to Free 2.1.x.
 */
export function openClawPaths(env = process.env) {
  const home = typeof env.HOME === "string" && env.HOME.trim() ? env.HOME.trim() : os.homedir();
  const rawState = typeof env.OPENCLAW_STATE_DIR === "string" ? env.OPENCLAW_STATE_DIR.trim() : "";
  const stateDir = rawState
    ? path.resolve(rawState === "~" ? home : rawState.startsWith("~/") ? path.join(home, rawState.slice(2)) : rawState)
    : path.join(home, ".openclaw");
  return createPaths({ home, stateDir });
}
