# ToggleLogic 1.1.1 developer notes

Release date: 2026-08-14

## Purpose

Version 1.1.1 is a metadata-only compatibility patch for the current ClawHub
plugin-manifest validator. It does not change routing, fleet metering, cost
visibility, configuration, or network behavior.

## Change

`openclaw.plugin.json` no longer declares the unsupported top-level `license`
or `categories` fields. The Free-Tier license remains declared in
`package.json`, `LICENSE`, and the package documentation. Package keywords
continue to describe discovery topics.

## Verification

- ClawHub package validation: zero issues and warnings against OpenClaw
  `2026.8.1-beta.1`.
- ClawHub package validation: zero issues and warnings against OpenClaw
  `2026.7.1-2`.
- `npm test`: 12 tests passed.
- `npm pack --dry-run`: package artifact contains the manifest, source,
  license, changelog, and release notes.

## Compatibility

- Minimum OpenClaw remains `>=2026.6.5`.
- Existing 1.1.0 configuration requires no change.
