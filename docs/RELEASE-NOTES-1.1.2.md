# ToggleLogic Free 1.1.2

This patch aligns the runtime identity with the package version and adds a
fail-closed pairwise compatibility gate for the separately licensed
ToggleLogic Intelligence product. The public plugin accepts Intelligence only
when its release manifest is released, version-consistent, declares seam ABI 1,
and includes the running plugin in its compatibility interval.

No classifier, model registry, learning system, customer evidence, or private
Intelligence source is included. Routing remains opt-in and unchanged when the
licensed layer is absent or incompatible.
