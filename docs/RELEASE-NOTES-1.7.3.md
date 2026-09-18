# ToggleLogic Free 1.7.3

Release date: 2026-09-18  
Compatibility pair: ToggleLogic Intelligence 1.5.3

## What changed

ToggleLogic can now grant one explicitly named skill a larger tool-call budget
than the deployment default by setting both `maxToolCalls` and
`allowAboveGlobalMax: true` in that skill's `skillTools` policy.

This closes a production PowerPoint workflow failure in which the routed child
used all 32 allowed calls while building and verifying the deck, then had three
required web-retrieval calls denied. The child correctly failed closed, but the
generic ceiling was too small for the declared artifact workflow.

The exception is narrow and bounded:

- it is disabled unless the deployment explicitly opts in the named skill;
- ordinary and undeclared skills retain `maxChildToolCalls`;
- a composite route cannot add multiple elevated budgets together; and
- ToggleLogic enforces an absolute 128-call ceiling.

Recommended SAM-HQ policy for complex PowerPoint edits:

```json
{
  "maxChildToolCalls": 32,
  "skillTools": {
    "powerpoint-editor": {
      "maxToolCalls": 64,
      "allowAboveGlobalMax": true
    }
  }
}
```

No Intelligence routing-engine change is required; the private 1.5.3 release
advances only the exact compatibility identity and verifiable BOM for Free 1.7.3.
