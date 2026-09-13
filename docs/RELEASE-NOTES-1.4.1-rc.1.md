# ToggleLogic Free 1.4.1-rc.1

This private release candidate makes governed-escalation approval messages
shorter and more welcoming. ToggleLogic now says it is ready to continue,
shows the estimated AI cost, explains what will be sent and to whom, and asks
for a one-time yes/no decision.

The underlying safety posture is unchanged. ToggleLogic now claims a governed
escalation through OpenClaw's pre-reply hook before any model executes, while
retaining the fail-closed input gate as a backstop. Ordinary routing decisions
are cached for the normal model-resolution hook so Intelligence still
classifies each logical turn only once. Other plugin blocks and denials remain
untouched.
