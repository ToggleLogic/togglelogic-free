# ToggleLogic Free 1.3.0

ToggleLogic Free 1.3.0 strengthens safe, transparent model routing while
preserving the public/private product boundary.

Configured deployments can opt into provider-constrained family aliases. A
family selection is made only from explicitly approved providers that are
actually configured in OpenClaw and only when fresh, complete, positive public
pricing is available. Missing, stale, malformed, or unpriced data safely passes
through without changing OpenClaw's selection.

The release also adds a verified seam for the separately licensed ToggleLogic
Intelligence layer. Compatibility, ABI, release identity, and the classifier's
exact SHA-256 must all pass before loading. Shadow mode records the private
layer's recommendation without emitting a model override.

Additional safeguards prevent false zero-dollar cost reports, preserve explicit
owner and session model choices, isolate named OpenClaw profiles, and expand the
release test and reproducibility gates.

The Free package contains no private classifier, proprietary model registry,
customer evidence, credentials, or deployment backups.
