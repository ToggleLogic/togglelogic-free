# Changelog

All notable changes to ToggleLogic (Free Tier) are documented here.

## 1.4.1-rc.6 — 2026-09-13

- Remove the redundant one-use approval line from the human-facing receipt.
- Retain approval scope and verification in the machine-readable audit trail.

## 1.4.1-rc.5 — 2026-09-13

- Replace the dense, pipe-delimited technical receipt with a short multiline
  summary for people: friendly model name, location, approval, usage, and cost.
- Put the cost on its own emphasized final line and keep pricing-source and
  exact model-reference evidence in the machine-readable audit trail.
- Shorten the heading from `ToggleLogic execution receipt` to `Receipt`.

## 1.4.1-rc.4 — 2026-09-13

- Reject a zero runtime-cost claim for an external model when runtime evidence
  shows positive token usage.
- Fall back to a labeled public-catalog estimate when pricing is available;
  otherwise report cost as unavailable rather than presenting a false zero.
- Render tiny positive costs as `<$0.0001` instead of rounding them to `$0.0000`.

## 1.4.1-rc.3 — 2026-09-13

- Add a two-stage consent state for external-model use: an initial natural
  affirmative or uncertain reply produces a plain-language confirmation, and
  only the following explicit approval authorizes the one-time execution.
- Keep uncertain replies paused instead of silently discarding the governed
  request or allowing a model to infer authorization.
- Repeat the provider, model, context boundary, one-use scope, and estimated
  cost in the final confirmation question.
- State whether SAM interpreted the first response as affirmative or uncertain,
  while leaving authorization exclusively to the second explicit answer.

## 1.4.1-rc.2 — 2026-09-13

- Accept common explicit approval phrases, including `Yes, approved`,
  `Approved`, and `Go for it`, while an external-model approval is pending.
- Keep authorization deterministic and fail-closed: ambiguous replies do not
  approve external execution, and approval remains valid for one use only.
- Tell the owner in the invitation that natural approval wording is accepted.

## 1.4.1-rc.1 — 2026-09-13

- Claim governed escalation before model resolution with a short,
  deterministic, positive invitation to approve one external use, avoiding
  OpenClaw's generic negative block envelope.
- Keep the proposed model, estimated AI cost, external data boundary, and
  explicit yes/no choice while omitting internal tier and token details.
- Preserve the fail-closed `before_agent_run` gate; no external model receives
  the request before owner approval.
- Cache ordinary preflight routing decisions for the normal model-resolution
  hook so Intelligence classifies each logical turn only once.

## 1.4.0 — 2026-09-13

- Add an opt-in governed-escalation lifecycle that keeps configured ordinary
  work local and blocks configured external capability tiers until the owner
  approves one execution.
- Show the proposed model, reason, estimated usage, estimated AI cost, and
  external-data boundary before any approved external request is submitted.
- Resume the original request after approval and attach a delivery-time receipt
  naming the runtime model, execution location, approval evidence, token usage,
  and either runtime-reported cost, a labeled public-rate estimate, or an
  explicit unavailable marker.
- Suppress false fallback notices only when runtime evidence proves a
  ToggleLogic policy reroute; preserve real and uncertain fallback warnings.
- Bound transient receipt state, require an explicit local quarantine model,
  and keep governed escalation disabled by default.
- Validate on OpenClaw `2026.9.4` with 64 passing tests, independent review,
  and a live block → approve → external receipt → return-to-local canary.

## 1.4.0-rc.4 — 2026-09-13

- Label public-catalog calculations as estimated AI cost rather than actual
  provider billing.
- Distinguish runtime-reported external cost from zero external-provider cost
  for local Ollama execution.
- Add a timed three-minute demonstration runbook with strict response limits.
- Keep this release candidate private pending live canary evidence.

## 1.4.0-rc.3 — 2026-09-13

- Bound and drain transient execution-receipt correlation state across the
  OpenClaw 2026.9.4 dual-hook delivery sequence.
- Require an explicit provider/model local quarantine target whenever governed
  escalation is enabled, preventing an empty local target on older hosts.
- Add a regression that exercises `llm_output` → `reply_payload_sending` →
  `message_sending` in host order and proves one receipt with no retained state.
- Keep this release candidate private pending owner approval for deployment.

## 1.4.0-rc.2 — 2026-09-13

- Use OpenClaw 2026.9.4's delivery-time runtime evidence to attach the
  governed-execution receipt to the final channel payload.
- Suppress OpenClaw's fallback banner only when runtime evidence proves the
  requested/resolved model difference was a ToggleLogic policy reroute and no
  fallback occurred; preserve real and uncertain fallback notices.
- Clarify local receipts as ToggleLogic policy selections with no external AI
  model, while retaining exact runtime model, tokens, and cost evidence.
- Keep this release candidate private while it is canaried on a controlled host.

## 1.4.0-rc.1 — 2026-09-13

- Add an opt-in governed-escalation lifecycle: local-first routing, a pre-run
  estimate and explicit one-time owner approval before configured external
  capability tiers, automatic resumption of the original request, and a
  post-run execution receipt naming the runtime model, boundary, tokens, and
  actual or explicitly unavailable cost.
- Persist pending approval state locally with owner-only permissions so a
  gateway restart cannot silently lose the governance decision.
- Keep this release candidate private while it is canaried against a live SAM
  deployment; no registry or public package release is implied.

## 1.3.4 — 2026-09-04

- Add a bounded, privacy-safe new-session signal so a separately installed
  Intelligence package can choose its general-purpose default on the first turn.
- Preserve that one-shot signal across OpenClaw gateway and worker processes
  using hashed, expiring local markers; raw session identifiers are never stored.
- Wait for licensed Intelligence detection and registry reachability during cold
  one-shot task startup instead of silently missing the first routing decision.
- Split `provider/model` references into OpenClaw 2026.9.1's separate provider
  and model override fields in configured and cheap modes.
- Keep disabled Intelligence detection awaitable so Free-only routing registers
  cleanly on OpenClaw 2026.9.1.
- Validate the release on OpenClaw `2026.9.1` while preserving the intentional
  `>=2026.6.5` host and `>=2026.5.2` plugin API compatibility floors.

- Publish the coordinated Intelligence public-development references while
  preserving the Free package boundary: no Intelligence engine, production
  Toggle Registry, maintained benchmark intelligence, private evidence,
  credentials, signed packs, or services are included here.
- Adopt the ToggleLogic Free Startup Commercial Use License 2.0, including its
  qualifying-startup commercial permissions, published thresholds, transition
  provisions, stable released-version rights, and breach cure.
- Add standalone product, patent, and trademark notices.

## 1.3.2 — 2026-08-28

- Preserve session intent across a single affirmative confirmation by
  inheriting the preceding high-confidence Intelligence decision within that
  session, with a 15-minute TTL and consume-once semantics.
- Classify each logical host turn only once so OpenClaw fallback candidates are
  not re-routed back to the model that already failed.
- Carry the classifier's required execution surface into routing audit details.
- Record explicit Intelligence unavailability as a failed routing decision,
  while ordinary classifier declines remain safe no-ops.

## 1.3.1 — 2026-08-26

Metadata and documentation compatibility release. Routing, model selection,
cost observation, fleet attribution, configuration, and network behavior are
unchanged from 1.3.0.

- Record OpenClaw `2026.7.1-2` as the host used to package and validate this
  release.
- State prominently that ToggleLogic is backward-compatible with OpenClaw
  `2026.6.5` and later and is validated through OpenClaw `2026.7.1-2`.
- Retain the intentional minimum gateway floor `>=2026.6.5` and plugin API
  floor `>=2026.5.2` for existing deployments.
- Clarify that the minimum version is a compatibility floor, not a dependency
  on an obsolete OpenClaw release.
- Add a regression assertion that release metadata cannot silently change any
  of the three compatibility values.

### Verification

- Full ToggleLogic release quality gate passes on OpenClaw `2026.7.1-2`.
- ClawHub package validation and artifact inspection are required before
  publication.

## 1.3.0 — 2026-08-26

- Add opt-in, provider-constrained family aliases for configured routes, with
  fresh complete pricing required and safe passthrough on uncertainty.
- Preserve explicit owner and session model choices above automatic routing.
- Prevent false `$0.00` reporting from zero, blank, or half-priced catalog rows.
- Verify the separately licensed Intelligence classifier by release-manifest
  identity, compatibility interval, ABI, and exact SHA-256 before loading it.
- Add Intelligence shadow mode so recommendations can be audited without
  changing the model selected by OpenClaw.
- Respect OpenClaw named/dev profile isolation for all legacy default paths.
- Add reproducible packaging, SBOM/provenance checks, and expanded security,
  fallback, pricing, routing, integrity, and isolation regression coverage.
- Keep the Free distribution free of the private classifier, registry,
  customer evidence, credentials, and deployment backups.

## 1.3.0-rc.3 — 2026-08-26

- Respect OpenClaw named/dev profile isolation by remapping legacy
  `~/.openclaw/...` defaults through `OPENCLAW_STATE_DIR`.
- Add regression coverage for profile-scoped paths while preserving ordinary
  home-relative paths.

## 1.3.0-rc.2 — 2026-08-26

Release candidate. Reconstructs the useful family-routing experiment in the
authoritative public source tree without carrying forward the unsafe installed
alpha implementation.

### Added

- Opt-in `familyResolution` for explicit `family:<alias>` values in
  `configuredRoutes` only.
- Provider intersection: candidates must be approved by the alias and present
  in OpenClaw's configured provider map.
- Complete-price and freshness gates with `lowest_cost` or bounded `newest`
  selection. Unresolved aliases safely pass through.

### Fixed

- Reject null, blank, half-priced, and 0/0 placeholder rates instead of
  coercing them into a priced zero-dollar call.
- Preserve the documented static behavior of `cheap` mode; it never performs
  family resolution or silently upgrades to a newer model.
- Keep the release candidate npm-private until independent review passes.

### Verification

- Added family-resolution, provider-filter, stale/corrupt-catalog, safe
  fallback, split override, and false-zero regression tests.
- Added direct owner-override, session-provenance, interceptor-priority, and
  fail-open/fail-closed routing tests after independent review.
- Added fail-closed SHA-256 verification of the paired Intelligence classifier
  before dynamic import.
- Added a reproducible quality gate and CI workflow.

## 1.2.4 — 2026-08-23

Patch release. Preserves the private Intelligence layer’s structured
family-resolution result in the existing local routing audit record. No private
classifier, benchmark data, or prompt content is added to the Free package.

## 1.2.3 — 2026-08-23

Patch release. Makes the Intelligence startup status accurately say when a
deployment is in shadow mode. Routing behavior is unchanged from 1.2.2.

## 1.2.2 — 2026-08-23

Patch release. Adds an explicit no-routing-change shadow gate for the separately
licensed Intelligence layer.

### Added

- **Intelligence shadow mode.** Set `intelligence.shadow: true` to evaluate and
  audit every Intelligence recommendation while returning no model override to
  OpenClaw. This permits a release canary before live routing is enabled.

### Verification

- Added a routing-mode test that proves a shadow recommendation cannot alter
  the host selection while its recommended model remains available in the audit.

## 1.2.1 — 2026-08-22

Release-metadata correction. Runtime behavior is unchanged from 1.2.0.

### Fixed

- **Release provenance.** The CycloneDX SBOM now points at the exact public
  source commit for this release. Version 1.2.0's plugin archive remains
  intact, but its immutable SBOM asset carried an incorrect VCS commit URL.

### Verification

- The source, package, manifest, runtime identity, checksum, and SBOM now
  point to one exact release commit.

## 1.2.0 — 2026-08-22

Minor release. Makes the documented static-route behavior real and makes an
explicit Intelligence selection fail visibly instead of silently changing mode.
No private classifier, registry, learning system, customer evidence, or provider
credential is included in the Free package.

### Fixed

- **Static configured routes now honor host-supplied task labels.** `configured`
  mode checks the documented structured labels, then optional `default`; it
  never reads or classifies message text.
- **Explicit Intelligence mode no longer silently downgrades.** When the
  separately licensed layer is unavailable or incompatible, routing passes
  through to the host and records `explicit Intelligence mode unavailable`.
  `auto` retains its documented safe fallback behavior.

### Verification

- Added routing-mode tests for structured labels, default fallback, prompt
  non-inspection, and explicit-Intelligence unavailability.
- Added a release identity test so package, manifest, and runtime versions must
  agree.

## 1.1.2 — 2026-08-21

Patch release. Aligns runtime identity with package metadata and adds a
fail-closed compatibility contract for the separately licensed ToggleLogic
Intelligence layer. Free routing behavior is unchanged.

### Fixed

- **Consistent release identity.** The running plugin, package metadata, and
  OpenClaw manifest now report the same version.

### Safety

- **Private Intelligence compatibility fails closed.** Intelligence is accepted
  only when its release manifest is released, version-consistent, declares seam
  ABI 1, and explicitly includes the running Free-plugin version in its
  compatibility interval.
- **Public/private boundary remains explicit.** The Free package contains no
  classifier, model registry, learning system, customer evidence, or private
  Intelligence source. Missing or incompatible Intelligence is never activated.

### Verification

- The ToggleLogic test suite passes 14 tests.
- The ClawHub Plugin Inspector reports zero issues and zero warnings.

## 1.1.1 — 2026-08-14

Patch release. Resolves current ClawHub manifest validation findings. Routing,
cost observation, fleet attribution, and all runtime behavior are unchanged.

### Fixed

- **Current OpenClaw manifest compatibility.** Removed unsupported top-level
  `license` and `categories` fields from `openclaw.plugin.json`. License
  information remains in the supported `package.json` package metadata; package
  keywords remain available for discovery.

### Verification

- ClawHub package validation passes with zero issues and warnings against
  OpenClaw `2026.8.1-beta.1` and `2026.7.1-2`.
- The ToggleLogic test suite passes (12 tests).

### Compatibility

- Minimum OpenClaw remains `>=2026.6.5`.
- No configuration or behavior change is required for an existing 1.1.0 user.

## 1.1.0 — 2026-08-11

Minor release. Adds privacy-safe local fleet metering. Routing is unchanged.

### Added

- **Deployment attribution.** Cost-log call and summary rows now carry a stable
  `deploymentId` and optional `costCenter`, configured as non-secret portable
  slugs. When no deployment ID is configured, the local hostname is used.
- **Versioned ledger contract.** Fleet rows declare
  `schema: togglelogic.fleet-usage.v1`, allowing a headquarters collector to
  distinguish and validate compatible deployment records.
- **Invoice-safety markers.** Locally calculated dollar figures declare
  `costBasis: public-rate-estimate` and `invoiceEligible: false`. A fleet
  operator must reconcile totals with authoritative provider billing before
  invoicing a customer.

### Privacy

- The ledger remains local and contains no prompt or assistant text.
- ToggleLogic does not send usage, deployment identifiers, cost centers, or
  customer information to Motherboard or any ToggleLogic endpoint.
- Attribution accepts only short slug values; email addresses, filesystem paths,
  and other free-form customer data are rejected by normalization.

### Tests

- Added regression coverage for attribution normalization, row and summary
  stamping, hostname fallback, schema identity, and invoice-safety markers.

### Compatibility

- Minimum OpenClaw remains `>=2026.6.5`; routing behavior is unchanged.

## 1.0.6 — 2026-08-02

Patch release. Correctness fix to cost visibility. Routing is unchanged.

### Fixed

**Cost visibility was lying for a specific case. It's fixed.**

The cost observer had a hole. It computed a dollar figure any time the
model was priced, without checking whether the call actually reported
token usage. When a priced call came back with no usage, or with
non-finite usage, the missing tokens got treated as zero. The result:
`costUsd: 0.00`. A reported number. Nothing distinguished it from a call
that actually cost nothing.

The whole point of cost visibility is that an unpriced call is loud and
never shows up as a false $0.00. This broke that for the missing-usage
case. A day full of these calls could read as zero spend. That's the
exact thing the feature exists to prevent.

It shipped this way in 1.0.3 on 2026-07-06 and has been in every build
since, including the 1.0.5 you can download today.

**What changed:** There are now three distinguishable outcomes instead
of two. A priced call with valid usage records its real cost. A priced
call with missing or non-finite usage goes loud. It is marked
`usageMissing` with the reason `priced-but-usage-missing`, no dollar
figure is recorded, and it counts in the loud bucket so a day full of
them can't read as $0.00. An unpriced model stays loud, same as before.

### Tests

There was already a test carrying the guarantee's name. It only checked
the missing-price half. The missing-usage half that produced the false
zero had never been tested. That's how it shipped without anyone
catching it.

There is now a test covering all four cases: priced+usage-present,
priced+usage-missing, priced+usage-non-finite, unpriced. It fails on
1.0.5. It passes on 1.0.6. The old test is renamed to its actual scope.

### Compatibility

Unchanged. Minimum OpenClaw `>=2026.6.5`. Validated through 2026.6.11.
OpenClaw's plugin manifest has a minimum floor field only. No ceiling
field exists in the loader, so the validated upper bound lives here,
not in the manifest.

## 1.0.5 — 2026-07-15

Patch release. **Routing behavior is unchanged except for owner-override TTL enforcement.**

### Added
- **Optional owner-override expiry (`expires_at_ms`).** An owner-override state file MAY carry a numeric `expires_at_ms` (epoch milliseconds). Once that deadline passes the override stops applying and routing returns to automatic selection — no file rewrite required. Overrides with **no** `expires_at_ms` behave exactly as before (they hold until cleared).

### Fixed
- **Expired overrides are no longer honored.** An override with a past `expires_at_ms` is now rejected (Codex audit finding); previously it was still applied.
- **Malformed `expires_at_ms` fails closed.** If the field is present but not a finite number, the override is rejected and a structured audit event (`routing.decision`, outcome `failure`, `owner_override_rejected`) is emitted — never silently honored.
- **Plugin version string corrected.** `PLUGIN_VERSION` was stale at `1.0.3`; it now matches the package version.

### Compatibility
- Supported OpenClaw unchanged from 1.0.4.

## 1.0.4 — 2026-07-09

Patch release. **Routing and cost-visibility behavior are unchanged from 1.0.3.**

### Fixed
- **Complete manifest description.** Restores the full plugin description in `openclaw.plugin.json`, which was truncated in the 1.0.3 manifest. The published package and the ClawHub listing now carry the complete description — this corrects listing text only, with no routing, pricing, or behavior change.

### Compatibility
- Supported OpenClaw unchanged from 1.0.3.

## 1.0.3 — 2026-07-06

Adds an opt-in **cost-visibility** capability. **Routing behavior is unchanged from 1.0.2.**

### Added
- **See what your calls cost, in dollars.** A new opt-in capability observes each model call (the `llm_output` hook, observe-only) and reports per-model and per-day dollar cost, using **dynamic public pricing** fetched live from [Models.dev](https://models.dev) — cached locally, refreshed on a slow cadence, never fetched per call. Curated to the major providers' standard lineups (Anthropic, OpenAI, Google, xAI, Meta).
- **Bundled offline fallback.** If the live pricing source is unreachable, pricing degrades to a bundled LiteLLM snapshot (MIT) — last-known-good, not a crash and not $0.00.

### Changed
- **Unpriced usage is loud, never a silent $0.00.** Any model the curated free-tier set can't price is reported explicitly as *unpriced* (model + token count, shown separately) and is never rolled into the dollar total as $0.00. Priced and unpriced always appear together.

### Safety
- **Observe-only. Never enforces.** Cost visibility reports; it never blocks, halts, or downgrades a call. Spend enforcement and all-model / guaranteed-current pricing remain the paid tier.
- **No callback to us.** Pricing is fetched directly from the public source; the plugin never contacts any ToggleLogic/Motherboard endpoint for pricing.

### Compatibility
- The cost observer requires the gateway's `plugins.entries.togglelogic.hooks.allowConversationAccess` (the `llm_output` hook is a conversation hook). Supported OpenClaw unchanged from 1.0.2.

## 1.0.2 — 2026-07-05

Metadata and compatibility release. **Routing behavior is unchanged from 1.0.1.**

### Changed
- **Correct catalog listing.** The plugin now declares its categories, so it lists under model-routing / cost-optimization instead of "Other."
- **Canonical source.** The package is now linked to its home organization repository, github.com/ToggleLogic/togglelogic-free, replacing the earlier personal-account link.
- **Explicit compatibility.** Supported OpenClaw: 2026.6.5 – 2026.6.11, validated on 2026.6.11; minimum gateway `>=2026.6.5`, plugin API `>=2026.5.2`.

## 1.0.1 — 2026-06-23

### Fixed
- **Your model selections now hold reliably.** When you pin a model for a session — or set an owner override — that choice is consistently honored above automatic routing. The routing layer still records when automatic selection *would* have chosen differently (visible in the audit stream), but your selection wins.
- **Richer routing-decision detail.** Each routing decision now records the requested model/provider and its provenance alongside the selected one, so the audit log shows what was asked for versus what was applied.

### Changed
- **Packaging metadata cleanup.** Aligned the declared minimum OpenClaw host version with the build target and removed an unsupported package metadata field, so the plugin validates cleanly against current OpenClaw.

---

## 1.0.0

- Initial public release: free-tier model routing for OpenClaw — owner overrides, static configured routes, a deliberately-simple cheapest-default, the optional licensed-Intelligence detection seam, and a structured audit stream.
