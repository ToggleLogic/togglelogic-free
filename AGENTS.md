# AGENTS.md — ToggleLogic Free

Operating instructions for AI coding agents (and their humans) working in this
repository. This file is self-contained; read it in full before making any
change.

## What this repository is

ToggleLogic Free is a **public, source-available** OpenClaw plugin: generic
model routing, approvals, audit records, and cost visibility. It ships **no**
assistant, memory, skills, or business-workflow policy. It is licensed under the
ToggleLogic Free-Tier License (see `LICENSE`); it is **not** open source.

Because the repository is public, everything committed here is world-readable.
Treat every change as a publication.

## Rules for all agents

These apply to every agent, on every change, without exception.

1. **Generic only.** No SAM- or host-specific logic, machine names, filesystem
   paths, deployment topology, or customer data. Nothing that only makes sense
   inside one operator's environment belongs here. The plugin routes on owner
   overrides, host-supplied structured labels, deployment-declared defaults, or
   the licensed Intelligence seam — never on inspected prompt text.

2. **No Intelligence.** The separately licensed ToggleLogic Intelligence
   package — its code, data, benchmarks, weights, private classifiers, evidence,
   and docs — must never appear in this repo. Only the generic seam/adapter
   already present here may reference it, and only across its public interface.

3. **Lineages, not version pins.** Refer to model *lineages/families*, not
   pinned version strings that go stale. Model identity and pricing are resolved
   from dynamic public data at runtime, not frozen into source.

4. **Dollars, not tokens; loud-fail on unpriced.** Cost visibility is reported
   in **dollars**, never raw token counts. If a model or call cannot be priced,
   **fail loudly** — surface the unpriced call in the summary. Never silently
   report `$0` or drop it.

5. **License header on every code file.** Every source file carries the
   published header:

   ```
   /*
    * ToggleLogic (Free Tier) — <one-line description of this file>.
    * (c) 2026 Motherboard, Inc. Source-available under the ToggleLogic Free-Tier
    * License (see LICENSE); all rights reserved.
    * PATENT PENDING.
    */
   ```

6. **Patents: no numbers, no dates.** Never cite specific patent application
   numbers or filing dates anywhere. The only sanctioned public phrasing is
   **"nine provisional patents pending."** Code headers use `PATENT PENDING`;
   `NOTICE.md` and `LICENSE` are authoritative on the rights actually granted.

7. **No pricing in docs.** Documentation must not contain dollar prices, pricing
   tables, or rate cards. Prices are dynamic and live in code sourced from public
   data — not in prose that goes stale.

## Roles

Two developer agents work this repo, with different authority.

### Claude Code — first developer

Owns the whole lifecycle:

- **Architecture** — designs the plugin's structure and interfaces; sets
  direction.
- **Review** — reviews all changes, including Codex's PRs, before they land.
- **Release** — solely owns releasing: version bump, CHANGELOG finalization,
  tagging from `main`, and publishing. Nothing installs anywhere until the tag is
  pushed. Roll out **canary host first, then the broader fleet.**

### Codex — second developer

Scoped contributor:

- Works **only** on items explicitly assigned to it.
- One short-lived branch per item, named `codex/<item>`.
- **Stops at an open PR.** It opens the PR and hands off for review.
- **Never** bumps versions, tags, publishes, merges, or installs.

## Release procedure

Claude Code only. In order:

1. `npm run quality` is green (syntax check + full test suite).
2. CHANGELOG entry added under a new `## X.Y.Z — YYYY-MM-DD` heading.
3. Version bumped in **all three** places that must agree — `package.json`,
   `openclaw.plugin.json`, and the runtime `PLUGIN_VERSION` label in
   `src/index.js`. This is enforced by `tests/version-consistency.test.js`; a
   mismatch fails `npm run quality`.
4. Tag `vX.Y.Z` created on `main`.
5. Push (tag + branch) — **before any install anywhere.**
6. Install: canary host first, then the fleet.
