// Per-registration, bounded correlation state. Never guess from a session alone:
// overlapping or later turns in the same session must not inherit another ID.
const clean = (value) => typeof value === "string" && value.trim() ? value.trim() : null;
function keyOf(event, context) {
  const run = clean(context?.runId) || clean(event?.runId);
  if (run) return JSON.stringify(["run", run]);
  const turn = clean(context?.turnId) || clean(event?.turnId);
  const session = clean(context?.sessionKey) || clean(event?.sessionKey)
    || clean(context?.sessionId) || clean(event?.sessionId);
  return turn && session ? JSON.stringify(["turn", session, turn]) : null;
}

export function createRequestCorrelation({ now = Date.now, ttlMs = 3_600_000, maxEntries = 4096 } = {}) {
  const entries = new Map();
  function prune() {
    for (const [key, entry] of entries) {
      if (now() - entry.at >= ttlMs) entries.delete(key);
    }
  }
  return {
    remember(decision, event, context) {
      prune();
      const key = keyOf(event, context);
      if (!key || !decision?.requestId) return;
      entries.delete(key);
      entries.set(key, { requestId: decision.requestId, at: now() });
      while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
    },
    lookup(event, context) {
      prune();
      const key = keyOf(event, context);
      const entry = key && entries.get(key);
      return entry ? { requestId: entry.requestId } : {
        requestId: null,
        requestIdReason: key ? "routing-decision-unavailable" : "turn-identity-unavailable",
      };
    },
  };
}
