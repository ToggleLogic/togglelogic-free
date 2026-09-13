# ToggleLogic Free 1.4.1

ToggleLogic Free 1.4.1 makes governed model escalation safer to trust and much
easier to understand in conversation.

Before an external model receives a task, ToggleLogic now responds positively,
names the proposed model, shows the estimated AI cost, and explains that the
request and active SAM context would cross to the named provider. The owner may
reply naturally. SAM states how it interpreted that reply, and ToggleLogic asks
one concise yes/no confirmation. Only the final explicit confirmation
authorizes one external execution; uncertainty remains paused and a negative
response cancels without sending the task.

Approved execution is bound to its confirmation turn. If that turn is
interrupted, approval cannot silently attach itself to a later unrelated
message, and an already consumed approval fails closed with a clear retry note.

Execution receipts are now short and human-readable. Model, location, usage,
and cost appear on separate lines, with the cost emphasized. Detailed provider
references, pricing sources, routing evidence, and one-use approval evidence
remain in the machine-readable audit trail.

Cost reporting is also hardened. A zero reported for a paid external model is
not trusted when positive token usage proves work occurred. ToggleLogic uses a
labeled public-rate estimate when available or reports the cost as unavailable;
local execution still reports zero external-provider cost.

The capability remains opt-in and disabled by default. Version 1.4.1 was
validated on OpenClaw 2026.9.4 with 75 passing tests and live Telegram canaries
covering local routing, natural consent, explicit confirmation, external
execution, false-zero correction, and the final receipt presentation.
