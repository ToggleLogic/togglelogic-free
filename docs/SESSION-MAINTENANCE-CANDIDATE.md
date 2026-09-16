# Native session-maintenance candidate (host-side, validated)

The plugin's bounded child (`docs/BOUNDED-CHILD-LIMITS.md`) prevents a *routed skill*
from re-incurring the 452K-token fat-main-session amplification. This document adds
the complementary **host-side** control: native OpenClaw 2026.9.4 config that bounds
the MAIN session's transcript growth and defines predictable resets — closing the
amplification at its source, not only for routed skills.

Every key below is a **real 2026.9.4 config key** (verified against
`openclaw config schema --json`) and the whole block was **validated by config
tooling in an isolated profile** — no hand-wavy keys, no live mutation.

## Candidate config (drop into the deployment config's top level)

```json
{
  "agents": {
    "defaults": {
      "compaction": {
        "enabled": true,
        "maxActiveTranscriptBytes": 2000000,
        "keepRecentTokens": 8000,
        "memoryFlush": {
          "enabled": true,
          "softThresholdTokens": 120000,
          "forceFlushTranscriptBytes": 4000000
        }
      },
      "subagents": {
        "runTimeoutSeconds": 600
      }
    }
  },
  "session": {
    "reset": { "mode": "daily", "atHour": 4 },
    "resetTriggers": ["/reset"]
  }
}
```

## What each key does (and why it matters here)

| Key | Type (schema) | Role |
| --- | --- | --- |
| `agents.defaults.compaction.maxActiveTranscriptBytes` | integer\|string | Byte threshold that triggers normal preflight local compaction — the direct backstop against an unbounded main-session transcript (the 2026-09-15 amplification substrate). |
| `agents.defaults.compaction.keepRecentTokens` | integer | Recent-token window preserved across compaction, so context stays useful while old bulk is shed. |
| `agents.defaults.compaction.memoryFlush.softThresholdTokens` | integer | Soft point at which memory is flushed to durable store before it bloats the transcript. |
| `agents.defaults.compaction.memoryFlush.forceFlushTranscriptBytes` | integer | Hard byte cap that forces a memory flush — a second, larger backstop above `maxActiveTranscriptBytes`. |
| `agents.defaults.subagents.runTimeoutSeconds` | integer (0 = none) | Host-side wall-clock cap on EVERY subagent run — the host-enforced complement to the plugin's `waitForRun({timeoutMs})`, bounding a routed child even if the plugin's wait is bypassed. |
| `session.reset.mode` / `atHour` | enum `none\|daily\|idle` / hour 0-23 | Predictable daily reset (here 04:00 local) so a session cannot accrete indefinitely across days. |
| `session.resetTriggers` | string[] | Explicit owner reset phrase (`/reset`) for an on-demand clean slate. |

Tune the byte/token numbers to the deployment's model context window and memory
policy; the values above are conservative defaults for a single-owner SAM.

## Validation evidence (isolated profile, no live mutation)

```
$ OPENCLAW_STATE_DIR=<tmp> OPENCLAW_CONFIG_PATH=<tmp>/session-maintenance.json \
    openclaw config validate --json
{"valid": true, "warnings": [], ... }
```

Re-run it against the live config only as a read-only check
(`OPENCLAW_CONFIG_READONLY=1 openclaw config validate --json`); applying these keys
is a deployment decision and is intentionally **not** performed by this repo.

## Relationship to the plugin

This is host-owned config, not plugin behavior. It does not replace and is not
replaced by the plugin's bounded-child limits — the two compose: the host bounds the
main session and every subagent's wall-clock; the plugin bounds the routed child's
tool surface, tool-call count, and re-entrancy, and refuses to start an over-budget
plan. Together they cover both the main-session and routed-skill amplification paths.
