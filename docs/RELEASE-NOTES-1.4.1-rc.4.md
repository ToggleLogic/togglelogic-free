# ToggleLogic Free 1.4.1-rc.4

This private release candidate hardens the execution receipt against false-zero
external cost data. A runtime-reported zero is not accepted for an external
model when positive token usage proves that work occurred. ToggleLogic instead
calculates a labeled estimate from its public pricing catalog, or reports the
cost as unavailable if it cannot price the model.

Local execution still reports zero external-provider cost. Tiny positive
external costs display as less than `$0.0001` rather than rounding to zero.
