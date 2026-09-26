# ToggleLogic Free 2.0.4

Corrective release. ToggleLogic Free 2.0.3 reported its version as 2.0.2 in routing
and audit records. 2.0.4 corrects that label and adds a release guard so the
runtime version always matches the package version. Routing behavior is identical
to 2.0.3, including honoring explicit per-request and `/model` selections.
