/*
 * ToggleLogic — governed model escalation coordinator.
 *
 * The classifier recommends. This coordinator decides whether that recommendation
 * may cross a deployment-defined execution boundary without owner approval.
 * It never asks a language model to remember approval state.
 */

import fs from "node:fs";
import path from "node:path";
import { resolveOpenClawPath } from "../path-utils.js";

const YES = /^(yes|yes please|proceed|please proceed|go ahead|please go ahead|do it|yes[, ]+proceed)[.! ]*$/i;
const NO = /^(no|no thanks|cancel|stop|do not proceed|don't proceed)[.! ]*$/i;

function splitRef(ref) {
  const i = typeof ref === "string" ? ref.indexOf("/") : -1;
  if (i <= 0 || i >= ref.length - 1) return null;
  return { providerOverride: ref.slice(0, i), modelOverride: ref.slice(i + 1) };
}

function keyOf(ctx) {
  return ctx?.sessionKey || ctx?.sessionId || null;
}

function correlationKeys(event, ctx) {
  return [...new Set([
    ctx?.sessionKey,
    ctx?.sessionId,
    ctx?.runId,
    event?.sessionKey,
    event?.sessionId,
    event?.runId,
  ].filter((value) => typeof value === "string" && value.length > 0))];
}

function tokenEstimate(prompt, outputTokens) {
  return {
    input: Math.max(1, Math.ceil(String(prompt || "").length / 4)),
    output: outputTokens,
  };
}

function formatMoney(value) {
  if (!Number.isFinite(value)) return "unavailable (execution remains blocked)";
  return value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
}

function isLocalProvider(provider, ref) {
  return provider === "ollama" || (typeof ref === "string" && ref.startsWith("ollama/"));
}

function formatReceipt(content, receipt) {
  const location = receipt.local
    ? "LOCAL (Ollama; selected by ToggleLogic policy; no external AI model)"
    : "EXTERNAL AI MODEL";
  const approval = receipt.approved ? " | owner approval: verified once" : "";
  let cost;
  if (receipt.actualCostUsd === null) {
    cost = "AI cost: unavailable—not $0";
  } else {
    const amount = `${formatMoney(receipt.actualCostUsd)}${receipt.priceSource ? ` (${receipt.priceSource})` : ""}`;
    if (receipt.local) cost = `external AI provider cost: ${amount}`;
    else if (receipt.priceSource === "openclaw-runtime") cost = `runtime-reported AI cost: ${amount}`;
    else cost = `estimated AI cost: ${amount}`;
  }
  return `${content}\n\n—\nToggleLogic execution receipt: ${receipt.ref} | ${location}${approval} | tokens: ${receipt.input ?? "unknown"} in / ${receipt.output ?? "unknown"} out | ${cost}`;
}

export function createApprovalGate({ config, pricing, now = () => Date.now() } = {}) {
  const cfg = config || {};
  const pending = new Map();
  const receipts = new Map();
  const ttlMs = Math.max(60_000, Number(cfg.ttlMinutes || 10) * 60_000);
  const receiptLimit = 512;
  const statePath = resolveOpenClawPath(cfg.statePath || "~/.openclaw/togglelogic/governed-escalation.json");
  const localRef = cfg.localModel || "";
  const localTiers = new Set(Array.isArray(cfg.localTiers) ? cfg.localTiers : ["general_purpose"]);
  const approvalTiers = new Set(Array.isArray(cfg.approvalTiers) ? cfg.approvalTiers : ["flagship_reasoning"]);
  const outputByTier = { general_purpose: 500, tool_calling_strong: 900, terminal_capable: 1400, flagship_reasoning: 2500 };

  function load() {
    try {
      const data = JSON.parse(fs.readFileSync(statePath, "utf8"));
      for (const [key, value] of Object.entries(data?.pending || {})) {
        if (value && typeof value === "object" && Number.isFinite(value.createdAt)) pending.set(key, value);
      }
    } catch { /* absent or malformed state fails closed to no pending approval */ }
  }

  function save() {
    try {
      fs.mkdirSync(path.dirname(statePath), { recursive: true, mode: 0o700 });
      const tmp = `${statePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, pending: Object.fromEntries(pending) }), { mode: 0o600 });
      fs.chmodSync(tmp, 0o600);
      fs.renameSync(tmp, statePath);
    } catch { /* gate remains safe in memory; callers still block unapproved work */ }
  }

  function prune() {
    const cutoff = now() - ttlMs;
    let changed = false;
    for (const [key, value] of pending) {
      if (value.createdAt < cutoff) {
        pending.delete(key);
        changed = true;
      }
    }
    if (changed) save();
  }

  function pruneReceipts() {
    const cutoff = now() - ttlMs;
    for (const [key, value] of receipts) {
      if (!Number.isFinite(value?.createdAt) || value.createdAt < cutoff) receipts.delete(key);
    }
    while (receipts.size > receiptLimit) receipts.delete(receipts.keys().next().value);
  }

  function clearReceipt(receipt) {
    if (!receipt) return;
    for (const [candidate, value] of receipts) if (value === receipt) receipts.delete(candidate);
  }

  function beforeRouting(prompt, ctx) {
    prune();
    const key = keyOf(ctx);
    const item = key ? pending.get(key) : null;
    if (!item) return null;
    if (item.status === "consumed") {
      pending.delete(key);
      save();
      return null;
    }
    if (YES.test(String(prompt || "").trim())) {
      item.status = "approved";
      item.approvedAt = now();
      save();
      return { action: "approved", shortCircuit: true, override: splitRef(item.modelRef), item };
    }
    if (NO.test(String(prompt || "").trim())) {
      item.status = "denied";
      save();
      return { action: "denied", shortCircuit: true, override: splitRef(localRef), item };
    }
    pending.delete(key);
    save();
    return null;
  }

  async function afterRouting(prompt, ctx, result) {
    const key = keyOf(ctx);
    const tier = result?.selectionDetails?.required_tier || null;
    const modelRef = result?.selectionDetails?.recommended_model_ref ||
      (result?.selectedProvider && result?.selectedModel
        ? `${result.selectedProvider}/${result.selectedModel}`
        : result?.selectedModel);

    if (localRef && (!tier || localTiers.has(tier))) {
      return { action: "local", override: splitRef(localRef), modelRef: localRef, tier };
    }
    if (!key || !modelRef || !approvalTiers.has(tier)) return null;

    const tokens = tokenEstimate(prompt, outputByTier[tier] || 1000);
    let cost = null;
    let source = null;
    try {
      const price = await pricing.resolve(modelRef);
      if (price?.priced) {
        cost = pricing.costUsd(price, { input: tokens.input, output: tokens.output });
        source = price.source || null;
      }
    } catch { /* an unavailable estimate must stay loud */ }

    const item = {
      status: "awaiting",
      createdAt: now(),
      originalPrompt: prompt,
      modelRef,
      tier,
      reason: result?.selectionDetails?.reasoning || result?.selectionReason || "capability requirement",
      tokens,
      estimatedCostUsd: Number.isFinite(cost) ? cost : null,
      priceSource: source,
    };
    pending.set(key, item);
    save();
    return { action: "approval_required", override: splitRef(localRef), item };
  }

  function beforeAgentRun(event, ctx) {
    const item = pending.get(keyOf(ctx));
    if (!item) return { outcome: "pass" };
    if (item.status === "approved") {
      item.status = "consumed";
      item.consumedAt = now();
      save();
      return { outcome: "pass" };
    }
    if (item.status === "denied") {
      pending.delete(keyOf(ctx));
      save();
      return { outcome: "block", reason: "owner_denied_escalation", category: "model_escalation", message: "Cancelled. No external AI model received the task." };
    }
    return {
      outcome: "block",
      reason: "owner_approval_required",
      category: "model_escalation",
      message:
        `ToggleLogic recommends ${item.modelRef} because this task requires ${item.tier.replaceAll("_", " ")}.\n` +
        `Reason: ${item.reason}\n` +
        `Estimated usage: ~${item.tokens.input} input / ~${item.tokens.output} output tokens.\n` +
        `Estimated AI cost: ${formatMoney(item.estimatedCostUsd)}${item.priceSource ? ` (${item.priceSource})` : ""}.\n` +
        `External-data boundary: ${cfg.externalDataNotice || "the request and active model context would be sent to the named provider"}.\n` +
        `No external model has received the task. Reply “Yes, proceed” to approve this model once, or “No” to cancel.`,
    };
  }

  function prepareTurn(_event, ctx) {
    const item = pending.get(keyOf(ctx));
    if (!item || item.status !== "approved") return;
    return {
      appendContext:
        `ToggleLogic owner approval is verified for one execution on ${item.modelRef}. ` +
        `Perform the original request below now. Do not ask for approval again.\n\nORIGINAL REQUEST:\n${item.originalPrompt}`,
    };
  }

  async function observeOutput(event, ctx) {
    pruneReceipts();
    const keys = correlationKeys(event, ctx);
    if (keys.length === 0) return;
    const usage = event?.usage || {};
    const ref = event?.resolvedRef || (event?.provider && event?.model ? `${event.provider}/${event.model}` : null);
    let actualCostUsd = null;
    let priceSource = null;
    if (isLocalProvider(event?.provider, ref)) {
      actualCostUsd = 0;
      priceSource = "local-provider-api";
    } else if (ref) {
      try {
        const price = await pricing.resolve(ref);
        if (price?.priced) {
          actualCostUsd = pricing.costUsd(price, usage);
          priceSource = price.source || null;
        }
      } catch { /* unavailable stays explicit in the receipt */ }
    }
    const pendingItem = keys.map((key) => pending.get(key)).find(Boolean);
    const receipt = {
      ref,
      provider: event?.provider || null,
      model: event?.model || null,
      input: Number.isFinite(usage.input) ? usage.input : null,
      output: Number.isFinite(usage.output) ? usage.output : null,
      local: isLocalProvider(event?.provider, ref),
      approved: pendingItem?.status === "approved" || pendingItem?.status === "consumed",
      actualCostUsd,
      priceSource,
      createdAt: now(),
    };
    for (const key of keys) receipts.set(key, receipt);
    pruneReceipts();
  }

  function appendReceipt(event, ctx) {
    const key = keyOf(ctx);
    const receipt = key ? receipts.get(key) : null;
    if (!receipt || !receipt.ref || typeof event?.content !== "string") return;
    if (event.content.includes("ToggleLogic execution receipt:")) {
      clearReceipt(receipt);
      return;
    }
    if (event.content.startsWith("↪️ Model Fallback:")) return;
    clearReceipt(receipt);
    if (["approved", "consumed"].includes(pending.get(key)?.status)) {
      pending.delete(key);
      save();
    }
    return { content: formatReceipt(event.content, receipt) };
  }

  async function prepareReplyPayload(event, ctx) {
    pruneReceipts();
    const payload = event?.payload;
    const usageState = event?.usageState;

    // OpenClaw 2026.9.4 compares the configured model with a policy override
    // when composing this notice. A mismatch is not a fallback when the
    // runtime explicitly reports fallbackUsed=false.
    if (payload?.isFallbackNotice === true) {
      if (
        usageState?.fallbackUsed === false &&
        typeof usageState.requested === "string" &&
        typeof usageState.resolvedRef === "string" &&
        usageState.requested !== usageState.resolvedRef
      ) {
        return { cancel: true, reason: "togglelogic_policy_reroute_not_fallback" };
      }
      return;
    }

    if (
      event?.kind !== "final" ||
      !usageState ||
      typeof payload?.text !== "string" ||
      payload.isError ||
      payload.isReasoning ||
      payload.isCommentary ||
      payload.isCompactionNotice ||
      payload.isStatusNotice
    ) return;

    if (payload.text.includes("ToggleLogic execution receipt:")) {
      const existing = correlationKeys(event, ctx).map((key) => receipts.get(key)).find(Boolean);
      clearReceipt(existing);
      return;
    }

    const ref = usageState.resolvedRef || (
      usageState.provider && usageState.model
        ? `${usageState.provider}/${usageState.model}`
        : null
    );
    if (!ref) return;

    const usage = usageState.usage || usageState.lastUsage || {};
    const local = isLocalProvider(usageState.provider, ref);
    let actualCostUsd = null;
    let priceSource = null;
    if (local) {
      actualCostUsd = 0;
      priceSource = "local-provider-api";
    } else if (Number.isFinite(usageState.turnUsd)) {
      actualCostUsd = usageState.turnUsd;
      priceSource = "openclaw-runtime";
    } else {
      try {
        const price = await pricing.resolve(ref);
        if (price?.priced) {
          actualCostUsd = pricing.costUsd(price, usage);
          priceSource = price.source || null;
        }
      } catch { /* unavailable stays explicit in the receipt */ }
    }

    const key = event?.sessionKey || keyOf(ctx);
    const pendingItem = key ? pending.get(key) : null;
    const receipt = {
      ref,
      provider: usageState.provider || null,
      model: usageState.model || null,
      input: Number.isFinite(usage.input) ? usage.input : null,
      output: Number.isFinite(usage.output) ? usage.output : null,
      local,
      approved: pendingItem?.status === "approved" || pendingItem?.status === "consumed",
      actualCostUsd,
      priceSource,
    };

    if (key && receipt.approved) {
      pending.delete(key);
      save();
    }
    const observed = correlationKeys(event, ctx).map((candidate) => receipts.get(candidate)).find(Boolean);
    clearReceipt(observed);
    return { payload: { ...payload, text: formatReceipt(payload.text, receipt) } };
  }

  load();
  prune();
  return {
    beforeRouting,
    afterRouting,
    beforeAgentRun,
    prepareTurn,
    observeOutput,
    appendReceipt,
    prepareReplyPayload,
    _pending: pending,
    _receipts: receipts,
  };
}

export const _internals = { splitRef, tokenEstimate, formatMoney, formatReceipt, correlationKeys, YES, NO };
