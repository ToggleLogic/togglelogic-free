# ToggleLogic Free 2.0.1

This maintenance release hardens governed model escalation after real-world owner-chat testing.

- Approval state now remains available for 30 minutes by default.
- An approval received after expiry is intercepted with a clear retry message. It cannot fall through as a new prompt or revive stale conversation work.
- Cost receipts appear by default only for governed escalations. Ordinary conversation no longer receives an unrelated routing receipt.

Set `governedEscalation.receiptMode` to `"always"` only when a deployment intentionally wants a receipt on every final model reply.
