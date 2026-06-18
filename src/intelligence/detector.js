/*
 * ToggleLogic (Free Tier) — licensed-layer detector.
 * (c) 2026 Motherboard, Inc. Source-available under the ToggleLogic Free-Tier
 * License (see LICENSE). PATENT PENDING.
 *
 * Read-only filesystem probe for an OPTIONAL, separately-licensed ToggleLogic
 * Intelligence layer. Never throws. No deployment-specific paths: the model-registry
 * location is config-driven, defaulting to a path RELATIVE to the configured
 * layer (not any deployment's workspace).
 *
 * Checks, in order (first failure short-circuits with a 'reason'):
 *   1. Configured layer path exists and is a directory.
 *   2. package.json exists at that path and is valid JSON.
 *   3. package.json declares a version >= MIN_COMPATIBLE_VERSION.
 *   4. The normalized model registry exists at the configured/derived path.
 *
 * Returns { present: true, resolvedPath, version } or
 *         { present: false, reason, resolvedPath, version? }.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const MIN_COMPATIBLE_VERSION = "1.0.0-alpha.2";

/**
 * @param configuredPath  intelligence.path — where a licensed layer would live.
 * @param registryPath    intelligence.registryPath — optional. When unset,
 *                        defaults to "<layer>/normalized.json" (neutral; the
 *                        registry ships WITH the licensed layer). Deployments
 *                        with a non-standard registry location supply it here
 *                        as DATA — the plugin hardcodes no workspace path.
 */
export async function detectIntelligenceLayer(configuredPath, registryPath) {
  const resolvedPath = expandTilde(configuredPath ?? "~/togglelogic-intelligence");

  // 1. Path must exist and be a directory.
  let stats;
  try {
    stats = await fs.stat(resolvedPath);
  } catch {
    return { present: false, reason: "path not found", resolvedPath };
  }
  if (!stats.isDirectory()) {
    return { present: false, reason: "path is not a directory", resolvedPath };
  }

  // 2. package.json must exist and parse.
  const pkgPath = path.join(resolvedPath, "package.json");
  let pkg;
  try {
    pkg = JSON.parse(await fs.readFile(pkgPath, "utf8"));
  } catch (err) {
    return { present: false, reason: `package.json missing or invalid: ${err.message}`, resolvedPath };
  }

  // 3. Version must be present and compatible.
  const version = typeof pkg.version === "string" ? pkg.version : null;
  if (!version) {
    return { present: false, reason: "package.json has no version field", resolvedPath };
  }
  if (!isVersionCompatible(version, MIN_COMPATIBLE_VERSION)) {
    return { present: false, reason: `version ${version} below minimum ${MIN_COMPATIBLE_VERSION}`, resolvedPath, version };
  }

  // 4. Normalized model registry must exist. Config-driven; neutral default is
  //    RELATIVE to the layer — no deployment/workspace path is hardcoded here.
  const resolvedRegistry =
    typeof registryPath === "string" && registryPath.length > 0
      ? expandTilde(registryPath)
      : path.join(resolvedPath, "normalized.json");
  try {
    await fs.access(resolvedRegistry);
  } catch {
    return { present: false, reason: `model registry missing at ${resolvedRegistry}`, resolvedPath, version };
  }

  return { present: true, resolvedPath, version };
}

function expandTilde(p) {
  if (typeof p !== "string") return p;
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/**
 * Minimal semver-compatible comparison for our prerelease scheme.
 * Format: MAJOR.MINOR.PATCH[-prerelease]. Returns true if `actual` >= `min`.
 */
function isVersionCompatible(actual, min) {
  const a = parseVersion(actual);
  const m = parseVersion(min);
  if (!a || !m) return false;
  if (a.major !== m.major) return a.major > m.major;
  if (a.minor !== m.minor) return a.minor > m.minor;
  if (a.patch !== m.patch) return a.patch > m.patch;
  if (!a.prerelease && !m.prerelease) return true;
  if (!a.prerelease && m.prerelease) return true;
  if (a.prerelease && !m.prerelease) return false;
  return a.prerelease >= m.prerelease;
}

function parseVersion(v) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(v);
  if (!match) return null;
  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10),
    prerelease: match[4] ?? null,
  };
}
