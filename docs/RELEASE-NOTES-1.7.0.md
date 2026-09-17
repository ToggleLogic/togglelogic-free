# ToggleLogic Free 1.7.0-rc.13

## RC13 candidate: natural meeting vocabulary and platform aliases

The reference policy now recognizes “meeting preparation” as well as
“prepare/prep/brief,” and explicitly supplements the verified inventory with
`microsoft graph`/`outlook` and `zoom` aliases. The exact owner rerun wording
therefore composes Graph plus Zoom deterministically instead of resolving only
the explicitly named Graph component.

## RC12 candidate: Zoom evidence and truthful role overlap

A composed Graph+Zoom meeting workflow must now perform an actual Zoom search
after confirming the authoritative Outlook event before reporting that no
relevant history exists. Reading the Zoom skill instructions is explicitly not
search evidence. A failed, unavailable, or skipped search must be disclosed as
not checked. The model marketplace also generates overlap text from the actual
roles attached to each displayed model, eliminating the RC11 false statement
that Recommended and Premium shared a model when Economy and Recommended did.

## RC11 candidate: compatible exact-match composition

An explicit component name no longer prevents a deterministic multi-skill
recipe from adding the rest of its required workflow. The owner UAT prompt that
names Microsoft Graph while requesting meeting preparation now resolves both
`microsoft-graph` and `zoom-meetings`. This augmentation is narrow: the recipe's
skill set must contain every exact text match. A contradictory recipe fails
closed, and a single composition may dominate overlapping component recipes
only when it contains every component skill set.

## RC10 candidate: deterministic QuickBooks multi-company reads

The `quickbooks-online` execution contract now sends an all-company A/R request
through one read-only broker command. The broker still authenticates and queries
each QBO realm independently and returns separately labeled results; no ledgers
are merged. Token refresh and live authentication checks happen inside the
report command, so the child does not spend additional model turns on a separate
healthcheck or on one command per company. Explicit ISO dates are mandatory, and
the contract distinguishes verified QBO facts from SAM's prioritization advice.

## RC9 candidate: natural-language path authorization correction

The trusted parent now recognizes an explicitly named absolute source `.pptx`
when ordinary sentence punctuation immediately follows the extension. This
corrects the owner-canary form `deck.pptx. Preserve the original` without
accepting slash-delimited suffixes, descendants, siblings, or unrelated
directories. The exact owner prompt is covered by a regression test.

## RC8: verified artifact delivery boundary

PowerPoint children no longer attempt writes into iCloud or another final owner
location from the bounded sandbox. Each run receives a unique directory below
`skillRouting.artifactStagingRoot`; the child creates, reopens, and hashes its
artifacts there and returns a strict delivery manifest. The trusted parent
prevalidates the complete set, copies with no-overwrite semantics, recomputes
destination hashes, and reports delivery only after they match.

Destinations are not model authority. The parent accepts an exact absolute path
present in the owner prompt, or—for `powerpoint-editor` only—a new filename
directly beside an absolute source `.pptx` explicitly present in that prompt.
Subdirectories, sibling directories, arbitrary child-supplied paths, existing
destinations, outside-stage sources, symlinks, hash drift, malformed/duplicate
manifests, and unverified artifacts fail closed. A multi-file set is validated
before its first copy and rolled back if a later copy or verification fails.

RC7 required edited decks and teleprompters beside the source unless the owner
named another destination; the RC8 boundary makes the trusted parent perform and
verify that delivery. RC6 gave the PowerPoint workflow one bounded correction/reverification cycle
after the RC5 canary exhausted its 24 calls immediately after truthfully finding
a timing miss. RC5 closed the learned-profile identity gap found during the SAM-HQ PowerPoint
canary. Recipe and classifier matches now carry the verified installed skill's
exact version and fingerprint through planning and owner teaching. Missing
identity fails closed instead of creating a wildcard policy.

ToggleLogic 1.7 changes first-use skill teaching from three abstract policies
into an owner-facing model marketplace.

## Meaningful choices

When the accepted pool supports them, the education prompt shows three distinct
durable lineages:

- **Economy** minimizes expected workflow cost while meeting the skill contract.
- **Recommended** is ToggleLogic Intelligence's skill-specific balance of
  capability evidence, reliability, and cost.
- **Premium** favors the strongest eligible evidence even when it costs more.

Each option states the concrete child currently resolved for its lineage, its
estimated whole-workflow cost range, a skill-specific advantage, and its main
trade-off. The recommendation explains why it fits this skill. These descriptions
are evidence supplied by ToggleLogic Intelligence; Free displays and binds them
to the owner's decision without inventing comparative claims.

Two eligible lineages are shown as two choices. One eligible lineage is shown
once as **Only eligible model**. Duplicate policy results are collapsed, so a
single Grok—or any other model—can no longer appear as three fictional choices.

## Safe learning

The owner may reply with the displayed `1`, `2`, or `3`. The pending plan remains
restart-safe, expires on the configured TTL, and is bound to the authenticated
owner, sender, and conversation. ToggleLogic records the exact strategy and
durable lineage behind the displayed choice for the applicable skill version.
Numbered model children remain execution-time resolutions, not permanent pins.

## Truthful execution receipts

Receipts now distinguish:

- the **planned lineage and child**, selected before execution; and
- the **observed execution model**, read only from structured provider/model
  evidence on the completed child assistant event.

If OpenClaw does not expose that evidence, the receipt says so and does not call
the planned model the model actually used. Token and metered-cost limitations
remain explicit.

The planned model is also registered as an execution binding on the bounded
child session. Child model resolution uses that binding directly rather than
reclassifying the child as a non-owner turn. A missing binding or an observed
model mismatch fails closed, and a denied verification tool call marks the
execution incomplete; none of those cases can produce a successful routing
receipt.

PowerPoint editing receives a bounded 32-call workflow floor under the global
tool ceiling. Its contract requires scripts in the requested order (3-minute,
6-minute, then original notes), measured counts and timing from the final saved
text, and reopen/render/content verification before completion is claimed.

## Scope and safety

This release does not expand authority. Active teaching and execution remain
owner-scoped and opt-in. The deterministic skill boundary, sender/session
binding, capability and privacy constraints, cloud budget, bounded child, and
tool-call guard remain in force. Global and unattended enforcement remain
unavailable pending a host-provided in-flight model token/cost/pass safeguard.
