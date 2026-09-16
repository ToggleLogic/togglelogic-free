# ToggleLogic Free — Capability & Consent Surface

This document is the explicit, managed-consent declaration of every host-affecting
capability ToggleLogic Free exercises, so an operator (or a managed install flow)
can grant them knowingly. It is authoritative for `1.6.1-rc.2` and pairs with the
machine-readable declarations in `openclaw.plugin.json`
(`configContracts.dangerousFlags`, `configSchema`, `contracts.tools`).

Every capability below is **opt-in** and **off by default**. Nothing here activates
unless the operator sets the corresponding `features.*.enabled` / config flag.

## 1. Subprocess execution — calendar bridge (NEW in 1.6.1-rc.2)

- **What:** When `features.skillRouting.enabled = true` **and**
  `skillRouting.calendar.enabled = true` **and**
  `skillRouting.calendar.bridge.command` is set, the plugin spawns that configured
  executable as a **child process** to read the owner's Microsoft Outlook calendar
  via `/me/calendarView`. The reference bridge is
  `~/.openclaw/workspace/skills/microsoft-graph/scripts/calendar_bridge.py`.
- **How it is launched:** `child_process.execFile(command, [...args, "--start", …,
  "--end", …, …])` with **`shell: false`**. There is no shell, so every argument —
  including the ISO window bounds — is passed literally and cannot be split,
  globbed, or expanded. See `src/skill-routing/calendar-bridge.js`.
- **Bounds & fail-closed:** a wall-clock `timeoutMs` (the child is `SIGKILL`ed on
  timeout), a 1 MiB stdout cap, strict JSON-envelope validation, and a required
  `ok:true` + `schema` match. A non-zero exit, timeout, non-JSON/oversized output,
  `ok:false`, wrong schema, or a missing events array all **fail closed** → the
  meeting-prep contract clarifies instead of fabricating.
- **Credentials:** the plugin holds **no** Microsoft Graph credentials. The bridge
  reads them from the hardware vault itself; tokens never cross the process
  boundary and are never printed (the bridge emits only sanitized
  `id/subject/start/end`).
- **Managed-consent marker:** `configContracts.dangerousFlags` flags
  `skillRouting.calendar.enabled == true` as a dangerous config value, so a managed
  install surfaces "this enables subprocess execution of a configured command" and
  requires `openclaw plugins install --accept-capabilities` (or an explicit
  operator acknowledgement) before it takes effect.

## 2. Workspace / filesystem access

- **Plugin-owned state only:** the plugin reads/writes under
  `~/.openclaw/togglelogic/` (skill-routing pending state, the deployment skill
  inventory snapshot + accepted marker) and appends to its configured log/audit
  paths under `~/.openclaw/logs/`. All writes are atomic (temp + rename), mode
  `0600`, dirs `0700`.
- **Bridge-owned access (subprocess, not the plugin):** the calendar bridge process
  reads the `microsoft-graph` skill directory and the hardware vault. This is the
  bridge's own capability surface, granted transitively when you configure
  `bridge.command`; the plugin never opens those files itself.
- **Deploy-time only:** `scripts/generate-skill-inventory.mjs` runs
  `openclaw skills list --json` to produce the inventory snapshot. This is a
  deploy-time generator run by the operator — the plugin **never** shells out to
  `openclaw` on a user turn.

## 3. Bounded-child subagent execution (skill routing)

- **What:** resolved-skill turns execute in a **fresh** child session via
  `api.runtime.subagent.run` with `promptMode:"minimal"` + `lightContext:true`, a
  per-skill tool policy, and a `before_tool_call` counter/deny for child sessions
  (see `docs/BOUNDED-CHILD-LIMITS.md`). Requires
  `api.runtime.subagent.{run,waitForRun,getSessionMessages}`; missing, the feature
  forces shadow (loud) and never gates.
- **Model override:** the child is pinned to the owner-taught model. This uses the
  host's `plugins.entries.togglelogic.subagent.allowModelOverride` grant.

## 4. Hooks registered

`session_start`, `before_model_resolve`, `before_agent_reply`
(`eligibleTriggers:["user"]`), `before_tool_call` (child-session enforcement; only
when skill routing is enabled), and — under their own opt-in capabilities —
`llm_output` (cost visibility, observe-only), `message_sending`, and the governed
escalation hooks. `before_agent_reply`/`llm_output` additionally require the
gateway's `plugins.entries.togglelogic.hooks.allowConversationAccess`.

## 5. Network

The plugin itself makes no outbound network calls on a user turn. Cost visibility
(opt-in) fetches public pricing from `models.dev` at startup only. The optional
classifier (off by default) calls a deployment-pinned local Ollama endpoint. The
calendar bridge's network access is the **bridge process's** surface (§1), not the
plugin's.
