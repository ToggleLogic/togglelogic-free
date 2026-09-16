# Host-integration closure — ToggleLogic 1.6.1-rc.4 (paired Intelligence 1.4.1-rc.4)

Durable release-candidate cut over rc.3, carrying the just-verified
**explicit-calendar-inspection precedence** correction. All work is durable
implementation on the uncommitted Free/Intelligence trees plus release metadata and
this note; **no live `openclaw.json` / `~/.openclaw` state was mutated, nothing was
installed live / activated / published / committed / tagged, and the live gateway and
4 AM refresh job were not touched.** Supersedes rc.3 without reusing its identifier.
Every rc.3 closure (`docs/HOST-INTEGRATION-CLOSURE-1.6.1-rc.3.md`, and its rc.2
predecessor) remains closed; the model-family lineage / capability-tier architecture
is unchanged and the Intelligence classifier entrypoint is byte-identical.

---

## The correction — explicit calendar-inspection precedence: CLOSED

**Was (canary defect):** the meeting/calendar contract's cost-saving past-meeting
short-circuit was over-broad. An owner request that EXPLICITLY directs SAM to inspect
the Outlook calendar via Microsoft Graph — "Check my Outlook calendar using Microsoft
Graph and tell me whether I had a 2 pm meeting today" — was wrongly clarified away as
`past_meeting_reference` merely because the referenced 2 pm had already passed,
refusing exactly the authoritative verification the contract exists to protect.

**Now:** `detectCalendarInspectionIntent` (in `src/skill-routing/skill-contracts.js`)
adds a NARROW precedence. When the resolved route contains the authoritative Microsoft
Graph calendar AND the message carries explicit inspection intent — an inspection verb
(check / inspect / search / query / look up / verify / confirm / pull up / review /
read / "tell me whether" / "did I have" …) AND an Outlook / Microsoft Graph / calendar
target — preflight returns `proceed` / `explicit_calendar_inspection`. It runs through
the Graph skill/bridge under the SAME meeting/calendar contract (Outlook is the one
authoritative calendar; never fabricate), reporting the truth whether or not the
meeting existed, and proceeds even with no wired calendar port (the child/bridge does
the authoritative check — the precedence is not deferring to a port-confirmed event).

**High-precision by construction.** It requires BOTH the inspection verb and the
calendar/Graph target, so an ordinary ambiguous meeting-PREP request ("prepare me for
my 2 pm meeting") — carrying neither — still takes the cost-saving
`past_meeting_reference` clarification, and a route without the authoritative calendar
(Zoom alone) still clarifies (`subordinate_meeting_skill_not_authoritative`). No model
or bounded child runs before the gate makes this decision.

**Tests:** `tests/skill-contract-intent.test.js` — intent detection (prompt B and
natural inspection phrasings true; prompt A and single-signal near-misses false), the
preflight proceed-vs-clarify matrix on a PAST time (with and without a wired port), the
Zoom-not-rescued case, and the two-prompt canary regression driven through the real
`before_agent_reply` gate (prompt A clarifies before the planner with zero model/child
calls; prompt B proceeds through microsoft-graph to the bounded child).

---

## Paired RC bump: DONE

Free **1.6.1-rc.4** / Intelligence **1.4.1-rc.4** across package identity, OpenClaw
manifest, `PLUGIN_VERSION`, changelogs, README/docs, `validated_versions`, and the
regenerated Intelligence BOM (29 files). The Intelligence classifier entrypoint is
byte-identical (`entrypoint_sha256` unchanged). Pair gate: **PASS (Intelligence
1.4.1-rc.4 + Free 1.6.1-rc.4)**.

---

## Checks run — all green

| Suite | Command | Result |
| --- | --- | --- |
| Free unit/integration | `npm test` | **334 pass / 0 fail** (unchanged from the verified rc.3 tree; the precedence tests were already present) |
| Free quality gate | `npm run quality` | **PASS** — "ToggleLogic release quality gate passed." (syntax + release-identity **rc.4** + pack allowlist) |
| Intelligence quality | `npm run quality` | **PASS** — 36 pass / 0 fail; `release manifest: PASS`; `release BOM: PASS (29 files)` |
| Intelligence canary | `npm run canary:skill-routing` | **PASS** (6 cases; `production_routing_changed: false`) |
| Release pair gate | `TOGGLELOGIC_FREE_PATH=… npm run release:quality` | **PASS (Intelligence 1.4.1-rc.4 + Free 1.6.1-rc.4)** |

---

## Release recommendation

- **Versioning:** keep the paired identifiers **Free 1.6.1-rc.4 / Intelligence
  1.4.1-rc.4**. No tag/publish/commit was performed.
- **Scoped owner canary (Al's SAM Telegram DM, account `default`): GO** — re-affirmed;
  rc.4 only tightens the calendar contract (explicit Outlook/Graph inspection of a past
  time now returns the authoritative truth instead of an unhelpful clarification) with
  no change to the spend ceiling, the fail-closed architecture, or the model-family
  lineage. Not installed live.
- **Global / unattended release: NO-GO** until OpenClaw adds a subagent
  model-token/pass cap + in-flight abort (unchanged blocker). `PUBLICATION_GATE.md`
  still records only the owner's earlier private-release approval; no new owner approval
  was fabricated for rc.4 — that record must be refreshed by the owner.
