# ToggleLogic Free 1.4.1-rc.3

This private release candidate adds a human-like, two-stage consent flow for
external-model use. The owner may answer the initial invitation naturally. A
positive or uncertain response does not execute anything; ToggleLogic restates
the provider, model, active-context boundary, one-use scope, and estimated cost
as a direct yes/no confirmation.

The confirmation makes SAM's interpretation visible: it says either that the
reply was understood as approval or that its meaning was uncertain. In both
cases, interpretation alone has no authority to execute the request.

Only a clear affirmative response to that second question authorizes the single
execution. A negative response cancels, anything else remains paused, and no
language model—not even a local one—has authority to infer consent.
