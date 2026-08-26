# ToggleLogic Free 1.3.1

ToggleLogic Free 1.3.1 is a metadata and documentation compatibility release.
It does not change routing, model selection, cost observation, fleet
attribution, configuration, credentials, or network behavior.

## OpenClaw compatibility

**Backward-compatible with OpenClaw 2026.6.5 and later; validated through
OpenClaw 2026.7.1-2.**

- Minimum gateway: `>=2026.6.5`
- Plugin API: `>=2026.5.2`
- Packaged and validated with: `2026.7.1-2`

The minimum gateway and plugin API values are intentional lower compatibility
bounds. They allow an existing supported deployment to install a current
ToggleLogic release; they do not mean ToggleLogic relies on an obsolete
OpenClaw version. OpenClaw releases newer than the stated validation point
should be verified before production promotion.

## Verification

- Release identity is synchronized across `package.json`,
  `openclaw.plugin.json`, and the runtime constant.
- A regression test locks the minimum gateway, plugin API floor, and validated
  build version to the published values.
- The full test suite, syntax checks, package-content boundary checks, and npm
  pack dry run pass on OpenClaw `2026.7.1-2`.
