/*
 * ToggleLogic (Free Tier) — host-neutral state-path resolution.
 * (c) 2026 Motherboard, Inc. Source-available under the ToggleLogic Free-Tier
 * License (see LICENSE); all rights reserved.
 * PATENT PENDING.
 */
import path from "node:path";

/**
 * Build a path resolver from explicit locations. The core never reads the
 * environment or a default home directory; an adapter supplies both.
 *
 * resolve(value):
 *   "~/.openclaw" and "~/.openclaw/…"  → under stateDir (legacy state-path spelling)
 *   "~" and "~/…"                      → under home
 *   anything else                      → unchanged
 */
export function createPaths({ home, stateDir } = {}) {
  if (typeof home !== "string" || !home) throw new TypeError("createPaths: home is required");
  if (typeof stateDir !== "string" || !stateDir) throw new TypeError("createPaths: stateDir is required");
  const resolvedHome = home;
  const resolvedState = stateDir;
  return Object.freeze({
    home: resolvedHome,
    stateDir: resolvedState,
    resolve(value) {
      if (typeof value !== "string") return value;
      if (value === "~/.openclaw") return resolvedState;
      if (value.startsWith("~/.openclaw/")) return path.join(resolvedState, value.slice(12));
      if (value === "~") return resolvedHome;
      if (value.startsWith("~/")) return path.join(resolvedHome, value.slice(2));
      return value;
    },
  });
}
