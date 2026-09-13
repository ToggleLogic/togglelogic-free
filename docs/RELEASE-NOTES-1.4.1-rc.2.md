# ToggleLogic Free 1.4.1-rc.2

This private release candidate makes the one-time external-model approval flow
natural without weakening its boundary. While an approval is pending, explicit
phrases such as `Yes, approved`, `Approved`, and `Go for it` authorize the same
single execution as `Yes, proceed`.

Recognition is deterministic and limited to an explicit phrase set. Ambiguous
replies do not authorize external execution. The approval remains session-bound,
time-limited, and consumed after one use.
