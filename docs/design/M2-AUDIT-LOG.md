# M2 design — Tamper-evident audit log

Status: **approved design** (2026-10-13). Part 1 shipped in **ToggleLogic Free 2.1.5**; targets:
(loud failures) and **ToggleLogic Free 2.4.0** (chain, retention, export; moved from 2.3.0 by the 2026-10-19 M1 split).
Baseline before part 1: Free 2.1.4.

Purpose: give deployers an audit trail they can retain, verify and export —
the kind of automatic, retained logging that high-risk-system rules (for
example the EU AI Act's record-keeping and deployer log-retention duties)
expect. ToggleLogic supplies the capability; whether a given deployment meets a
legal obligation is the deployer's determination.

## 1. Today (2.1.4, from source)

- `src/audit/audit-logger.js` appends one JSON line per event to
  `~/.openclaw/logs/togglelogic-audit.jsonl` (configurable), serialized through
  a promise chain.
- **Failure handling:** the first write failure logs one `warn`; every later
  failure is silently dropped for the life of the process.
- **Rotation:** size-only (default 50 MiB), cascading renames to `.1`–`.5`; the
  oldest file is overwritten. Records are lost by size, regardless of age.
- **Content:** `principal` is allowlisted (`source`, `agentId`, `channel`,
  `sessionKey`, `messageId`, `userId`); `subject` and `details` pass through
  unfiltered.
- **Integrity:** none. An edit, deletion or reorder is undetectable.

## 2. Part 1 — loud audit-write failures (Free 2.1.5)

Same pattern as 2.1.2's conversation-access readiness: error log, not-ready
capability gate, counted event.

Behavior on each failed write:

1. Increment `failures.total` and record `lastError`, `firstFailureAt`,
   `lastFailureAt`.
2. `hostLogger.error(...)` on the first failure, then at most once per 60 s with
   the cumulative count and the count since the last report. Every failure is
   counted; reports are coalesced, never suppressed.
3. Set the `audit` capability gate to `{ ready: false, reason:
   "audit-write-failing" }`, exposed through `audit.health()` and the
   `GET /v1/health` endpoint once M1 lands.
4. Emit `audit_write_failed` on the usage-events stream (an independent file
   sink), with the count and error code — never record content.
5. On the first successful write after failures, write an
   `audit.write.recovered` record into the audit stream itself with
   `{ failedCount, firstFailureAt, lastFailureAt, lastErrorCode }`, so the gap
   is visible to anyone reading the log, and set the gate ready again.

No config change. Dispatch remains fail-soft. Records that failed to write are
not buffered indefinitely (that would turn a disk problem into a memory
problem); the recovery record states exactly how many were lost.

New events: `audit.write.recovered` (audit stream), `audit_write_failed`
(usage events). Both map to controls `AU-2`, `AU-3`, `AU-5`.

Tests: read-only directory, `ENOSPC` via an injected `fs`, intermittent
failure; assert error-log cadence, gate transitions, event counts and the
recovery record contents.

## 3. Part 2 — audit schema v2 (Free 2.4.0)

`auditSchema: "togglelogic-audit/v2"`. All v1 fields are kept; v2 adds `chain`.

### 3.1 Streams and the hash chain

A **stream** is one writer instance (one audit logger in one process context).
Each stream has its own chain, so several writers on one host cannot fork a
chain.

```json
"chain": {
  "stream": "s-<26 char ULID>",
  "seq": 1042,
  "prev": "sha256:<64 hex>",
  "hash": "sha256:<64 hex>"
}
```

- `hash = sha256( prev_hash_bytes || canonical(record_without_chain.hash) )`.
- `canonical()` = JSON with lexicographically sorted object keys, no
  insignificant whitespace, UTF-8, numbers in shortest round-trip form (a
  subset of RFC 8785 sufficient for the values ToggleLogic writes).
- The first record of a stream is `audit.stream.open` with `seq: 0` and
  `prev = sha256("togglelogic-audit/v2:" + stream)`. It records the plugin
  version, adapter id, and the last known heads of other streams read from the
  head registry (best-effort cross-linking).
- Clean shutdown writes `audit.stream.close`. Its absence is reported by
  `verify` as "stream ended without close" (warning, not failure — crashes
  happen).

### 3.2 Head registry

`<stateDir>/togglelogic/audit-heads.json`, updated with an atomic rename after
each batch: `{ stream: { seq, hash, segment, updatedAt } }`. It is the local
anchor that makes tail truncation detectable. It can be shipped elsewhere (see
§3.6) to become an anchor an attacker on the host cannot rewrite.

### 3.3 Segments, rotation and retention

- The active segment stays at the configured `audit.path`, so existing tailers
  keep working.
- When the active segment reaches `rotateSizeMb` or crosses a UTC day boundary,
  it is sealed: a final `audit.segment.seal` record (segment's last hash and
  record count) is written, and the file is renamed into `<audit.path>.d/` as
  `<stream>.<firstSeq>-<lastSeq>.jsonl`. Sealed segments are mode `0400`.
- **Retention:** `audit.retention.minDays` (default **183**, minimum 1).
  A sealed segment is deleted only when its newest record is older than the
  window. Deletion writes `audit.retention.prune` (segment name, last hash,
  record count) into the live stream before unlinking, so `verify` can accept a
  legitimately pruned prefix.
- **Size pressure:** `audit.retention.maxTotalMb` (default unset). If exceeded
  and nothing is old enough to prune, nothing is deleted: error log, gate
  `{ ready:false, reason:"audit-retention-pressure" }`, and an
  `audit.retention.pressure` record. Records inside the window are never
  dropped.
- **v1 files** (`.1`–`.5`) are left in place, untouched and unchained. `verify`
  reports them as `legacy-unverifiable`. Rotation no longer cascades over them.

### 3.4 Write-time field allowlists

Per-event allowlists for `subject` and `details` in
`src/audit/field-allowlist.js` (one entry per `EVENTS` value). Rules: listed
keys only; strings capped at 512 chars; depth ≤ 4; arrays ≤ 64 items. Unlisted
keys are dropped and counted in `details._droppedKeys` (count only, never the
names' values). A test fails if an event is emitted without an allowlist entry.
Prompt text, completions, credentials and the Decision API `content` field are
never on any allowlist.

### 3.5 Verification

`togglelogic-audit verify [--path <audit.path>] [--heads <file>] [--expect-head <stream>:<seq>:<hash>] [--json]`

Checks, per stream, in sequence order across sealed segments and the active
segment:

| Tamper | Detection |
|---|---|
| Edit any field | recomputed `hash` ≠ stored `hash` |
| Delete a record | `seq` gap and `prev` mismatch |
| Reorder records | non-monotonic `seq` / `prev` mismatch |
| Insert a record | `prev` mismatch on the following record |
| Truncate the tail | last `seq`/`hash` behind the head registry or `--expect-head` |
| Delete a sealed segment | `seq` gap not covered by an `audit.retention.prune` record |
| Delete a whole stream | stream listed in the head registry or another stream's `open` record but no segments found |

Exit codes: `0` verified, `1` integrity failure, `2` warnings only (unclosed
stream, legacy files), `3` usage error. `--json` emits a machine-readable
report for the evidence bundle.

**Limit, stated plainly:** an unsigned hash chain proves the log is internally
consistent and matches an anchor. Someone who can rewrite both the log and
every copy of the anchor can rewrite history. Anchors outside the host and
signed checkpoints close that gap; signing and hosted verification are the
licensed tier (owner to confirm placement).

### 3.6 Checkpoints and export

- `audit.checkpoint.everyMinutes` (default 60): writes `audit.checkpoint`
  `{ stream, seq, hash }` to the audit stream and to the usage-events stream,
  so any shipper that collects either file carries the anchor off-host.
- `togglelogic-audit export --format json|csv|jsonl [--since] [--until]
  [--profile minimal|standard|forensic] [--out <file>|-]`.
  - `minimal`: timestamp, event, outcome, controls, correlationId, tenant,
    decision ref and reason, cost estimate.
  - `standard` (default): `minimal` plus principal and allowlisted
    `subject`/`details`.
  - `forensic`: `standard` plus the `chain` block; requires `--forensic`.
  - `jsonl` uses SIEM-friendly field names (`@timestamp`, `event.action`,
    `event.outcome`, `labels.*`) one record per line, for Vector/Fluent
    Bit/Filebeat. Free ships no network sender.
  - CSV flattens with dotted column names and a fixed column order per profile.

### 3.7 Optional fail-closed policy

`audit.failurePolicy: "continue" | "block"` (default `continue`). With `block`,
while the `audit` gate is not ready the core returns `decision.action:
"block"`, `reason: "blocked"`, `rationale.matchedRule: "audit_unavailable"`.
The OpenClaw adapter maps block to the host's refusal path; the sidecar returns
`403`. Intended for regulated deployments that must not process without a
record.

### 3.8 Config additions

```json
"audit": {
  "enabled": true,
  "path": "...",
  "rotateSizeMb": 50,
  "retention": { "minDays": 183, "maxTotalMb": null },
  "checkpoint": { "everyMinutes": 60 },
  "failurePolicy": "continue"
}
```

All additive; unspecified values take the defaults above. `openclaw.plugin.json`
`configSchema` gains the same properties.

## 4. Placement (owner to confirm)

| Capability | Recommended |
|---|---|
| Loud failure, gates, recovery record | Free |
| Chain format, head registry, `verify` | Free |
| Retention, sealed segments, pruning | Free |
| Export and field allowlists | Free |
| Fail-closed policy | Free |
| Managed signing keys, signed checkpoints, hosted verification, long-term evidence vault | Licensed |

Rationale: an auditor or customer must be able to verify integrity with
source-available tooling; key custody and hosted attestation are services.

## 5. Test and proof plan

- `tests/audit-loud-failure.test.js` (2.1.5).
- `tests/audit-chain.test.js`: golden vectors for `canonical()` and `hash`;
  tamper suite (edit, delete, insert, reorder, truncate, segment deletion,
  stream deletion) — each fails with the expected code and message; clean log
  passes.
- `tests/audit-retention.test.js` with an injected clock: rotation by size and
  by day; no deletion inside the window under any `maxTotalMb`; pressure is
  loud; pruning is audited and verifiable.
- `tests/audit-export.test.js`: byte-stable fixtures per format and profile;
  forbidden fields never appear.
- `tests/audit-field-allowlist.test.js`: every event has an allowlist; unknown
  keys dropped and counted.
- Multi-writer test: two loggers on one path produce two verifiable streams.
- Performance check: chained write cost per record recorded in the test
  output, with an upper bound asserted.

## 6. Canary-host acceptance

- **2.1.5:** in a scratch profile on the canary host, point `audit.path` at a
  read-only directory; capture the error log, gate state, `audit_write_failed`
  events; restore; capture `audit.write.recovered`.
- **2.4.0:** after at least three days on the canary host:
  `togglelogic-audit verify --json` exit 0 on the live log; one sealed segment
  and one checkpoint observed; one export per format delivered to the owner; a
  tamper drill on a copied log fails verification.

## 7. Risks

- **Layout change** (sealed segments in `<path>.d/` instead of `.1`–`.5`). If
  ruled a public contract, this becomes Free 3.0.0, which first requires a
  licensed-layer release accepting Free `<4.0.0`.
- **Multiple writers per host** — handled by streams; a spike first confirms
  how many audit loggers a gateway process creates.
- **Disk growth** from time-based retention — surfaced, never silently resolved.
- **Clock skew** affects day rotation and retention, not integrity (integrity
  is by `seq`/`prev`, not time).
- **Unsigned-chain limits** — documented in §3.5.
