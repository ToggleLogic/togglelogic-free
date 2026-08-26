/* Resolve plugin paths without escaping an OpenClaw named/dev profile. */
import os from "node:os";
import path from "node:path";

function homeDir(env) {
  return typeof env.HOME === "string" && env.HOME.trim() ? env.HOME.trim() : os.homedir();
}

export function resolveOpenClawPath(value, env = process.env) {
  if (typeof value !== "string") return value;
  const home = homeDir(env);
  const rawState = typeof env.OPENCLAW_STATE_DIR === "string" ? env.OPENCLAW_STATE_DIR.trim() : "";
  const stateDir = rawState
    ? path.resolve(rawState === "~" ? home : rawState.startsWith("~/") ? path.join(home, rawState.slice(2)) : rawState)
    : path.join(home, ".openclaw");
  if (value === "~/.openclaw") return stateDir;
  if (value.startsWith("~/.openclaw/")) return path.join(stateDir, value.slice(12));
  if (value === "~") return home;
  if (value.startsWith("~/")) return path.join(home, value.slice(2));
  return value;
}
