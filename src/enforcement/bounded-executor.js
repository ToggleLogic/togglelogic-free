import crypto from "node:crypto";

const refParts = (ref) => {
  const at = typeof ref === "string" ? ref.indexOf("/") : -1;
  return at > 0 && at < ref.length - 1 ? { providerOverride: ref.slice(0, at), modelOverride: ref.slice(at + 1) } : null;
};

export function validateExecutionEnvelope(raw, { now = Date.now(), sessionKey, requestDigest } = {}) {
  const envelope = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : null;
  if (!envelope || envelope.schema !== "togglelogic.execution-envelope/v1") throw new Error("invalid execution envelope schema");
  if (!Number.isFinite(envelope.expires_at_ms) || envelope.expires_at_ms <= now) throw new Error("execution envelope expired");
  if (envelope.session_key_hash !== crypto.createHash("sha256").update(String(sessionKey || "")).digest("hex")) throw new Error("execution envelope session mismatch");
  if (envelope.request_digest !== requestDigest) throw new Error("execution envelope request mismatch");
  if (!/^[a-f0-9]{32,128}$/.test(String(envelope.nonce || ""))) throw new Error("execution envelope nonce invalid");
  if (!refParts(envelope.selected_model_ref)) throw new Error("execution envelope model invalid");
  const policy = envelope.execution_policy || {};
  if (!Number.isInteger(policy.max_tool_calls) || policy.max_tool_calls < 0 || policy.max_tool_calls > 128) throw new Error("execution envelope tool ceiling invalid");
  if (!Number.isInteger(policy.estimated_tokens) || policy.estimated_tokens < 1) throw new Error("execution envelope token estimate invalid");
  if (!Number.isFinite(policy.max_estimated_cost_usd) || policy.max_estimated_cost_usd < 0) throw new Error("execution envelope cost ceiling invalid");
  return envelope;
}

export function createEnvelopeValidator({ maxRemembered = 1024 } = {}) {
  const consumed = new Map();
  return {
    consume(raw, context = {}) {
      const envelope = validateExecutionEnvelope(raw, context);
      const now = Number.isFinite(context.now) ? context.now : Date.now();
      for (const [nonce, expires] of consumed) if (expires <= now) consumed.delete(nonce);
      if (consumed.has(envelope.nonce)) throw new Error("execution envelope replayed");
      consumed.set(envelope.nonce, envelope.expires_at_ms);
      while (consumed.size > maxRemembered) consumed.delete(consumed.keys().next().value);
      return envelope;
    },
  };
}

export async function executeBoundedEnvelope({ envelope, runtime, parentSessionKey, message, systemPrompt = "", timeoutMs = 600000 }) {
  const parts = refParts(envelope.selected_model_ref);
  if (!parts || !runtime?.subagent?.run || !runtime?.subagent?.waitForRun || !runtime?.subagent?.getSessionMessages) throw new Error("bounded execution runtime unavailable");
  const suffix = crypto.createHash("sha256").update(`${parentSessionKey}\0${envelope.nonce}`).digest("hex").slice(0, 16);
  const childSessionKey = `${parentSessionKey}:togglelogic-workload:${suffix}`;
  const run = await runtime.subagent.run({ sessionKey: childSessionKey, message, extraSystemPrompt: systemPrompt, provider: parts.providerOverride, model: parts.modelOverride, deliver: false, idempotencyKey: `togglelogic-${suffix}`, promptMode: "minimal", lightContext: true, ...(envelope.execution_policy.disable_tools ? { disableTools: true } : {}) });
  const wait = await runtime.subagent.waitForRun({ runId: run.runId, timeoutMs });
  if (wait?.status !== "ok") throw new Error(`bounded execution ${wait?.status || "failed"}`);
  const transcript = await runtime.subagent.getSessionMessages({ sessionKey: run.sessionKey || childSessionKey, limit: 20 });
  return { run, wait, transcript, childSessionKey };
}
