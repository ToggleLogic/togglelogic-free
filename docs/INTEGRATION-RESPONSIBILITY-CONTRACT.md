# Who Guarantees What: Using a Model Router Without Shifting the Hard Problems Into Your Own Code

## The question every integrator eventually asks

You install a model router—a component that decides which AI model handles each
request—and then encounter a failure that appears to implicate the router. An
assistant says an email was saved, but no draft exists. A real cloud-model run is
reported as `$0.00`. An owner asks to switch models, but the selection does not
change.

These failures usually expose an unwritten agreement about who is responsible for
what. A router's job is narrow: choose a model according to policy and record the
decision. It cannot see whether an email was saved, invent a receipt for work it
did not perform, or decide who is authorized to approve an action. If those duties
are not assigned explicitly, they fall into a gap where an agent can make a
confident but unverified claim.

This guide defines the three parties, their contract, the request lifecycle,
common failure modes, and the tests an integration should pass before release.

## The three parties

1. **Host runtime** — The platform that invokes the AI provider, runs tools,
   measures tokens, computes or supplies runtime cost, and reports whether a
   fallback occurred. It is the source of execution facts.
2. **Router** — A generic policy layer that requests a model, keeps an explicit
   model choice in force, and records why it made that choice. ToggleLogic occupies
   this layer.
3. **Deployment or agent policy** — The specific product built around the host and
   router. It authenticates the owner, interprets commands, executes business
   actions, verifies their receipts, and owns the words shown to a user.

Think of the router as a switchboard operator. It can connect a call to Billing
instead of Sales. It cannot pay the invoice, confirm that payment cleared, or
promise that a refund was processed.

## Responsibility matrix

| Concern | Host runtime | Router | Deployment / agent |
|---|---:|---:|---:|
| Invoke the selected AI model | Yes | No | No |
| Request a model according to routing policy | Honors request | Yes | Defines policy |
| Measure real tokens, runtime cost, and fallback | Yes | Reads only | No |
| Authenticate the owner and channel | Provides identity data | No | Yes |
| Interpret plain-language owner commands | No | Receives configured decisions | Yes |
| Perform an email, CRM, accounting, or publishing action | Runs the tool | No | Owns the workflow |
| Prove that the business action happened | Returns tool facts | No | Validates the receipt |
| Define user-facing wording and product terminology | No | Renders supplied values | Yes |
| Maintain decision and execution audit records | Yes | Yes | Yes |

The most important row is **prove that the business action happened**. A router is
not the proof source. That is the correct boundary, not a limitation to hide.

## The integration contract

### ToggleLogic MUST

- Emit a model override only from an explicit routing decision.
- Return no override when it has no decision, preserving the host default.
- Read owner/model-choice state rather than authoring owner commands itself.
- Keep approvals fail-closed, bound to the confirming turn, and valid for one use.
- Derive receipt facts only from host-supplied execution data.
- Report cost as unavailable when usage or price evidence is missing; never turn
  missing data into a false `$0.00`.
- Keep generic routing independent of arbitrary prompt-text interpretation.

### The host runtime MUST

- Provide a model-selection seam and honor a valid router override.
- Provide a blocking pre-run gate when governed escalation is enabled.
- Attach host-computed execution facts, including usage and fallback state, to the
  final delivery lifecycle.
- Run business tools and return structured results to the deployment.
- Gate conversation access behind explicit permission and maintain a versioned
  hook contract.
- Execute its configured concrete primary/fallback chain in order and expose
  which candidate actually ran.

### The deployment or agent policy MUST

- Authenticate who may issue owner commands and in which channels.
- Convert deployment-specific language into normalized decisions.
- Write authorized owner override state for the router to read.
- Define the canonical tool path and valid receipt schema for each side effect.
- Require current-turn evidence before content-specific webpage, video, audio, or
  document claims.
- Prevent stale claims from an earlier task from being presented as current work.
- Own application wording, provider labels, model labels, and external-data notice.
- Own model-family acceptance records and materialize accepted children into
  the host's concrete primary/fallback fields before startup.

### Ordered family fallbacks

The durable policy may name an ordered series of model families while the host
runtime requires concrete model references. ToggleLogic may resolve and audit
that plan, but it does not mutate host configuration. Discovery is not
acceptance, and an unresolved rung must not be silently removed, reordered, or
replaced across family boundaries. See
[Model-family fallback architecture](./MODEL-FAMILY-FALLBACK-ARCHITECTURE.md).

## A router cannot manufacture host capabilities or execution receipts

**A router can change which model runs. It cannot create an ability the host does
not provide, prove a real-world side effect, or invent an execution receipt.**

- It cannot make a provider faster, cheaper, or more capable.
- It cannot know actual runtime cost unless the host supplies trustworthy usage or
  cost facts. Missing information must remain visibly unavailable.
- It cannot confirm that an email was saved, a video was transcribed, a CRM record
  changed, or an account was reconciled. Only the tool that performed the action
  and the deployment that validates its result can prove that.
- It cannot authenticate the owner merely because a message contains `Yes`.

A travel agent can place a passenger on a better flight. The agent cannot make the
aircraft fly faster, issue a valid boarding pass for an unconfirmed seat, or decide
whether the traveler accepts the fare. When confirmation is missing, the honest
status is *not confirmed*.

## One request across all three layers

Consider: “Draft a reply about the Henderson invoice and put it in my Drafts. Do
not send it.”

1. The deployment verifies that the instruction came from an authorized owner in
   an allowed channel—not from quoted or forwarded text.
2. ToggleLogic applies the configured routing policy. If it has no decision, it
   returns no override and preserves the host's model choice.
3. The host invokes the selected model. The model proposes the canonical draft
   tool.
4. The deployment blocks unverified shortcuts such as an unrelated API, script,
   or link that cannot return the required receipt.
5. The host runs the tool and returns structured evidence such as an operation ID,
   mailbox identity, draft ID, and verified status.
6. The deployment verifies that the receipt belongs to this request and this turn.
   Without it, the deployment prevents a “done” claim.
7. The host supplies runtime usage and fallback facts. ToggleLogic may render those
   facts, but it must show unavailable when they are absent.
8. The deployment produces the concise user-facing result.

Every layer does a different job. Routing success alone never proves draft
creation.

## Generic routing, command interpretation, and application safeguards

These concerns are related but not interchangeable:

- **Generic routing:** “For host-supplied task label X, request model Y.” “Keep an
  explicit model pin active.” “When there is no decision, do nothing.” It does not
  infer a task key from arbitrary prompt text.
- **Owner-command interpretation:** “Switch me back to the fast model” changes the
  authorized model pin. “Yes, go ahead” approves a pending action. This depends on
  identity, language, locale, channel, and product policy; the deployment owns it.
- **Application safeguards:** Require a valid email receipt, fresh webpage fetch,
  video transcript, CRM write confirmation, or accounting reconciliation result
  before claiming success. These rules live with the domain workflow.

ToggleLogic's governed-escalation state machine uses deployment-configured exact
phrases to consume an already-authenticated decision safely. Supplying a phrase
list does not authenticate a speaker or make ToggleLogic the owner-command parser.

## Common failure modes

| User-visible failure | Root cause | Responsible prevention |
|---|---|---|
| “Saved to Drafts,” but no draft exists | Success claim without a receipt | Deployment verifies tool receipt |
| A cloud run displays `$0.00` | Missing evidence rendered as zero | Host supplies facts; router shows unavailable |
| A webpage/video summary was guessed | No current-turn fetch or transcript | Deployment requires evidence |
| “Use the cheap model” changes nothing | No authorized component wrote owner state | Deployment writes; router reads |
| Approval for task A authorizes task B | Approval was not turn-bound | Router enforces one turn and one use |
| No routing decision replaces the host default | Silence was treated as a decision | Router returns passthrough |
| A group member changes the owner's model | Text was accepted without authentication | Deployment validates identity/channel |
| An old completion claim appears on new work | Cross-task state leaked | Deployment suppresses stale claims |

The same boundaries apply outside software development:

- **Bookkeeping:** “March is reconciled” requires confirmation from the accounting
  system.
- **CRM:** “The opportunity is now Won” requires the record ID and confirmed new
  state from the CRM.
- **Web and video review:** A content claim requires a successful current-turn
  fetch or transcript.
- **Long-running business work:** Completion requires the tracked job's completion
  signal, not elapsed time or model confidence.
- **Publishing:** A post is not live until the publishing service returns a valid
  result for the intended account and content.

## Conformance tests before release

### Router tests

- [ ] No decision produces no override and preserves the host default.
- [ ] An approval cannot authorize another turn or be reused.
- [ ] Missing usage/cost is reported as unavailable, never false zero.
- [ ] Runtime receipt values come only from host execution facts.
- [ ] Default messages contain no deployment-specific brand or provider catalog.
- [ ] Deployment-configured phrases and display names are deterministic.

### Host-adapter tests

- [ ] The host honors model/provider overrides at its documented selection seam.
- [ ] The pre-run block prevents provider submission.
- [ ] Final delivery contains host-computed usage and fallback state.
- [ ] Conversation hooks require explicit access permission.
- [ ] A supported-host-version matrix is rerun before production promotion.

### Deployment tests

- [ ] Only an authenticated owner in an allowed channel can write routing state.
- [ ] Quoted, forwarded, group, and unrelated text cannot become an owner command.
- [ ] Every side-effect success claim requires a current matching receipt.
- [ ] Missing webpage/video/document evidence prevents content-specific claims.
- [ ] Interrupted and long-running work cannot claim completion early.
- [ ] User-facing wording remains owned and tested by the deployment.

## Integration checklist

Before enabling ToggleLogic in production:

- [ ] Document the three-party responsibility matrix for your product.
- [ ] Verify the exact host hooks ToggleLogic relies on for the host version used.
- [ ] Configure only provider/model references that exist in the host.
- [ ] Keep governed escalation disabled until the blocking and delivery hooks pass.
- [ ] Configure the deployment's data notice, decision phrases, and display names.
- [ ] Authenticate owner commands outside ToggleLogic.
- [ ] Define a canonical tool and receipt schema for every real-world action.
- [ ] Run routing, host-adapter, and deployment conformance tests together.
- [ ] Canary the complete lifecycle: request, route, execute, verify, deliver, audit.
- [ ] Roll back if any layer must guess a capability, cost, fallback, or receipt.

## Conclusion

A router earns its place by doing one thing deterministically and honestly:
choosing a model and recording the choice. It becomes a liability when it is asked
to invent a cost, confirm an action it never saw, or guess who authorized a task.

Let the host own execution truth, the router own model choice, and the deployment
own identity, intent, business actions, proof, and presentation. Test those
boundaries as a single contract. That turns the router from another layer where
problems can hide into a small, trustworthy component other developers can reuse.
