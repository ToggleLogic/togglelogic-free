# SAM-HQ owner-policy example (scoped canary)

`sam-hq-owner-policy.openclaw.json` is a **candidate distributable template** for the
owner-only scoped canary (ToggleLogic Free 1.6.1-rc.3 / Intelligence 1.4.1-rc.3).
Nothing owner-specific is baked in — no real Telegram peer id, path, or credential.

## Using it

1. Copy the `plugins.entries.togglelogic` block into your `openclaw.json`.
2. Replace every `<PLACEHOLDER>`:
   - `<MANAGED_PLUGIN_ROOT>` → the managed plugin root path.
   - `<OWNER_TELEGRAM_PEER_ID>` → the owner's Telegram peer id.
3. Validate: `openclaw config validate` → **`valid: true`** (verified against the real
   OpenClaw 2026.9.4 schema with the placeholders filled). The template carries **no
   `_comment` keys** — OpenClaw's root config schema is strict (`additionalProperties:
   false`) and rejects unknown root keys, so all annotations live here in this README.
4. The economic policy (amortized $400 / 48 mo = $8.33/mo derived cloud budget) lives
   in the Intelligence skill-routing-profiles doc referenced by
   `intelligence.skillProfilesPath` — see [`../ECONOMIC-PROFILE.md`](../ECONOMIC-PROFILE.md).

## Deterministic platform intent recipes (`skillRouting.intentRecipes`)

Evaluated AFTER exact skill resolution returns none and BEFORE the bounded local
classifier. Each resolves **only when every target skill is installed**; otherwise it
is inert and the turn falls to the universal no-skill fail-safe. The local Gemma
classifier misrouted explicit-platform prompts (e.g. *"Find the latest email from
Chris in Outlook."* → ambiguous `microsoft-graph`/`gog` @0.95), so explicit platform
names are resolved deterministically and never left to the model:

| Recipe | Matches | Resolves to |
| --- | --- | --- |
| `high-precision-meeting-prep` | `meeting` + a prep verb | `microsoft-graph` + `zoom-meetings` |
| `high-precision-meetings-prep` | `meetings` + a prep verb | `microsoft-graph` + `zoom-meetings` |
| `owner-calendar-appointments` | `appointment` or `appointments` | `microsoft-graph` |
| `owner-daily-schedule` | `schedule` + `today`/`tomorrow`/`day` | `microsoft-graph` |
| `outlook-mail` | literal `outlook` + email/mail/inbox term | `microsoft-graph` |
| `zoom-recording` | literal `zoom` + transcript/recording term | `zoom-meetings` |
| `gmail-mail` | literal `gmail` + an email action/object term | `gog` |

High-precision by construction: `outlook-mail` requires the literal `outlook` token
(never fires on generic Gmail/Google), and `zoom-recording` requires `zoom` **plus** a
recording/transcript term (never fires on generic meeting text). `gmail-mail` requires
the literal `gmail` token **plus** an email action/object term (`email`, `mail`,
`inbox`, `send`, `draft`, `reply`, `search`, `read`, `find`, …), so it:

- routes explicit Gmail work — including work naming the exact SAM address
  `clickitco@gmail.com` (which contains the `gmail` token) with an email term — to
  the installed **`gog`** skill (SAM's Gmail service);
- never fires on **Outlook / Microsoft 365** (no `gmail` token → `outlook-mail` /
  Graph still owns those);
- never fires on **generic Google Drive/Docs/Calendar** (no `gmail` token) or on a
  **generic email with no platform** ("email Chris the report" → no `gmail` token →
  falls through to the classifier or the no-skill fail-safe).

A message naming **both** `outlook` and `gmail` matches two recipes that resolve to
different skills (`microsoft-graph` vs `gog`) → the gate **fails closed** with one
clarification (never a silent pick). We deliberately did **not** add a bare
exact-address recipe (`clickitco@gmail.com` with no email term): it would be
redundant with `gmail-mail` (the address already contains the `gmail` token) and a
bare-address rule would risk capturing generic Drive/Sheets work that merely mentions
the address — so `gmail-mail` (address **+** an email term) is the higher-precision
choice.

If **`gog` is not installed**, `gmail-mail` is inert and an explicit Gmail request
returns the exact universal no-skill fail-safe (`I don't have a skill that relates to
what you're asking me to do.`) — never a silent route.

## Per-skill execution identity (`skillRouting.skillIdentities`)

Because ToggleLogic routes each resolved skill through a **bounded child session** it
owns, it attaches the AUTHORITATIVE mailbox/account identity that child must act
under — keyed **only** to the *verified resolved skill id*, never chosen by the model.
The reference host has two distinct mail identities that must never be conflated:

| Skill | Mailbox / account | Sender identity |
| --- | --- | --- |
| `microsoft-graph` | Al Harlow's Microsoft 365 / Outlook mailbox (owner) | **Al Harlow** — compose/send as Al / on behalf of Al |
| `gog` | `clickitco@gmail.com` — SAM's own Gmail | **SAM**, in SAM's own identity — never impersonate Al |

The identity text is **deployment config** — mailbox labels and policy sentences,
**never a credential/token**. It is injected into the routed child's system prompt and
surfaced (credential-free) in the `execution_identity` field of the audit/receipt
metadata. Because an identity is applied **only** to a skill that actually resolved on
the turn, a Graph (owner) identity can never cross onto a Gmail route or vice versa,
and an identity is never supplied for a skill that did not resolve.

**Send policy** (identical for both mailboxes): a **specific owner instruction to send
a named message** authorizes exactly that send; a general **write/compose/draft/reply**
request is **draft-only** until the owner confirms the exact message.

**Honest limitation:** the plugin injects the identity into the child prompt and
records it in the audit/receipt metadata, but does **not** append it to the short
user-facing execution footer (kept deliberately non-invasive). The mailbox address is
included in the child prompt and audit because the deployment requires the child to
know which account it is acting in; it is an account address, not a secret — no OAuth
token or credential is ever placed in config, the prompt, or the audit.

See [`../ECONOMIC-PROFILE.md`](../ECONOMIC-PROFILE.md) and the acceptance tests in
`tests/skill-platform-recipes.test.js` and `tests/skill-mailbox-identity.test.js`.
