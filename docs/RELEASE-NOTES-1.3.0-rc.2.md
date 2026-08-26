# ToggleLogic Free 1.3.0-rc.2

This unpublished release candidate is reconstructed from authoritative Free
1.2.4 source. It is not the hand-edited `2.0.0-alpha.1` installed on a SAM.

The candidate adds opt-in, provider-constrained family aliases to explicit
configured routes. It does not change static cheap routing, inspect prompts,
ship a model catalog, or include ToggleLogic Intelligence. It also closes
false-zero pricing paths for missing usage, incomplete rates, and zero-rate
placeholder rows.

Independent review findings incorporated in rc.2 include direct tests for the
owner-override, protected-session, and interceptor precedence boundaries;
fail-closed classifier-entrypoint SHA-256 verification; an Intelligence BOM
staleness gate; and corrected routing-policy schema documentation.

Validated locally against OpenClaw `2026.7.1-2` and paired, source-controlled
ToggleLogic Intelligence `1.2.0-rc.8`. Intelligence requires an explicitly
configured deployment registry path because no proprietary registry ships in
either Free or the Intelligence code package.

The package remains npm-private until a command-enabled independent review,
artifact inspection, and disabled canary pass.
