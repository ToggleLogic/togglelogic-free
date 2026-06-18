/*
 * ToggleLogic (Free Tier) — model-routing plugin for OpenClaw.
 * (c) 2026 Motherboard, Inc. Source-available under the ToggleLogic Free-Tier
 * License (see LICENSE): free, limited, REVOCABLE use; all rights reserved.
 * PATENT PENDING. The benchmark Intelligence engine + Toggle Registry are NOT
 * in this package.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

/**
 * JSONL routing log writer.
 *
 * One JSON object per line, easy to grep/jq. Writes are serialized through
 * a promise chain so concurrent calls don't interleave. Rotation kicks in
 * when the current file exceeds rotateSizeMb. Disk failures are reported
 * once to api.logger and then suppressed — we never want logging failures
 * to break the routing path.
 *
 * Caller pattern: logger.write(decision).catch(() => {}) — fire and forget.
 * The interceptor returns its override before the disk write completes.
 */

const MAX_ROTATION_INDEX = 4; // keeps .1 through .5

export function createLogger(loggingConfig, fallbackLogger) {
  const config = loggingConfig ?? {};
  const enabled = config.enabled !== false;
  const targetPath = expandTilde(
    config.path ?? "~/.openclaw/logs/togglelogic-routing.log"
  );
  const rotateBytes = Math.max(1, config.rotateSizeMb ?? 50) * 1024 * 1024;

  let writeQueue = Promise.resolve();
  let everFailed = false;

  async function ensureDir() {
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
  }

  async function rotateIfNeeded() {
    let stats;
    try {
      stats = await fs.stat(targetPath);
    } catch {
      return; // file doesn't exist yet — no rotation needed
    }
    if (stats.size < rotateBytes) return;
    // Cascade: .4 -> .5, .3 -> .4, ..., current -> .1
    for (let i = MAX_ROTATION_INDEX; i >= 1; i--) {
      try {
        await fs.rename(`${targetPath}.${i}`, `${targetPath}.${i + 1}`);
      } catch {
        /* missing rotation file — skip */
      }
    }
    try {
      await fs.rename(targetPath, `${targetPath}.1`);
    } catch {
      /* fallthrough: append will create a fresh file */
    }
  }

  async function writeOnce(record) {
    const line = JSON.stringify(record) + "\n";
    await ensureDir();
    await rotateIfNeeded();
    await fs.appendFile(targetPath, line, "utf8");
  }

  async function write(record) {
    if (!enabled) return;
    writeQueue = writeQueue.then(async () => {
      try {
        await writeOnce(record);
      } catch (err) {
        if (!everFailed) {
          everFailed = true;
          try {
            fallbackLogger?.warn?.(
              `togglelogic: file logging failed (${err?.message ?? err}); ` +
                `subsequent failures suppressed for this session.`
            );
          } catch {
            /* ignore */
          }
        }
      }
    });
    return writeQueue;
  }

  async function flush() {
    return writeQueue;
  }

  return { write, flush, path: targetPath };
}

function expandTilde(p) {
  if (typeof p !== "string") return p;
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}
