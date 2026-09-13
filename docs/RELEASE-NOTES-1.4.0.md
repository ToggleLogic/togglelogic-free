# ToggleLogic Free 1.4.0

ToggleLogic Free 1.4.0 adds an optional governance boundary between a task
classifier and the model that ultimately receives a request. A deployment may
keep ordinary work on a declared local model while requiring one-time owner
approval before configured high-capability tiers cross to an external provider.

Before escalation, ToggleLogic names the proposed model, explains the routing
reason, estimates token usage and AI cost, discloses the external-data boundary,
and confirms that no external model has received the request. After approval,
the original request resumes automatically. The delivered result carries a
runtime-evidence receipt naming the resolved model, execution location, token
usage, and approval state.

Cost language is deliberately bounded by its evidence. Host-provided cost is
labeled runtime-reported; public catalog calculations are labeled estimates;
local Ollama execution reports zero external-provider cost; unavailable pricing
is explicit and is never represented as zero.

The feature is disabled by default. Enabling it requires routing, conversation
access, a compatible separately installed ToggleLogic Intelligence layer, and an
explicit `provider/model` local quarantine target. The Free package includes no
classifier, production Toggle Registry, private benchmark evidence, provider
credential, prompt archive, or customer data.

Validation completed on OpenClaw 2026.9.4 with 64 passing tests, independent
Claude Code review, and a live canary proving block-before-external, one-time
approval, receipt accuracy, false-fallback suppression, and automatic return to
local execution.
