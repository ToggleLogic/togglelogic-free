# ToggleLogic three-minute demonstration runbook

## Before the room

1. Confirm the demonstration host is healthy and ToggleLogic is loaded.
2. Preload a Free-tier comparison result and a local execution receipt in the
   presentation channel. Do not spend the presentation waiting for both models.
3. Start a fresh demonstration session and keep the governed-escalation prompt ready.
4. Use fictional information only.

## Live sequence

### 0:00–0:35 — The problem

“An AI model can sound certain while misreporting its own model, routing, or
cost. ToggleLogic keeps those decisions and evidence outside the model.”

Show the preloaded comparison:

- Free comparison: deployment-defined Anthropic Haiku route with recorded cost.
- Governed host: policy-selected local Ollama route with zero external-provider cost.

### 0:35–1:05 — Trigger the governance boundary

Send this synthetic prompt to the governed demonstration host:

> Using fictional information only, compare three competing market-entry
> strategies by risk, tradeoff, and key assumption, then recommend a decision
> framework. Output exactly four bullet points, each no more than 12 words. No
> heading, table, introduction, conclusion, or prose outside the four bullets.

ToggleLogic should respond immediately without calling an external model. Its
short approval invitation names the proposed model and estimated AI cost, then
states that the request and active SAM context will be sent to the named
provider once the owner approves one use.

### 1:05–1:30 — Make the decision visible

Say: “The model cannot approve itself. The owner decides whether this task and
context may cross the boundary.” Reply naturally with `Go for it`. ToggleLogic
should restate the provider, model, context boundary, one-use scope, and cost as
a direct confirmation. Reply `Yes` only after that confirmation is correct.

### 1:30–2:30 — Show governed execution

The result should contain only four short bullets and remain under 90 words. Show the execution
receipt: runtime model, external boundary, one-time approval, tokens, and a
clearly labeled runtime-reported or estimated AI cost.

### 2:30–2:50 — Prove the approval did not stick

Send:

> Reply exactly: Local follow-up completed.

Do not rely on the model's claim about routing. Show the local Ollama receipt
and zero external-provider cost as the runtime evidence.

### 2:50–3:00 — Close

“Plugins give an AI access. ToggleLogic governs which intelligence may act,
what information may leave, what it should cost, and who must approve it.”

## Pass criteria

- No false fallback banner.
- No external call before approval.
- Natural wording produces a separate, explicit yes/no confirmation.
- The final confirmation names the model, provider, estimate, and context boundary.
- Exactly one approved external execution occurs.
- Public pricing is labeled as an estimate, never actual provider billing.
- The next ordinary turn returns to local execution.
