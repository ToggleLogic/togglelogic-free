/*
 * ToggleLogic (Free Tier) — state-path resolution within the active OpenClaw profile.
 * (c) 2026 Motherboard, Inc. Source-available under the ToggleLogic Free-Tier
 * License (see LICENSE); all rights reserved.
 * PATENT PENDING.
 */
import { openClawPaths } from "./adapters/openclaw/paths.js";

/**
 * Compatibility entry point (Free 2.1.x API). Resolves a configured path with
 * the OpenClaw environment defaults. New code receives an injected `paths`
 * object (src/core/paths.js) instead.
 */
export function resolveOpenClawPath(value, env = process.env) {
  return openClawPaths(env).resolve(value);
}

/** Resolve with injected paths when given, else the OpenClaw environment defaults. */
export function resolvePath(value, paths = null) {
  return paths ? paths.resolve(value) : resolveOpenClawPath(value);
}
