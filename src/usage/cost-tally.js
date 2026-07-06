/*
 * ToggleLogic (Free Tier) — cost tally + loud-unpriced summary.
 * (c) 2026 Motherboard, Inc. Source-available under the ToggleLogic Free-Tier
 * License (see LICENSE): free, limited, REVOCABLE use; all rights reserved.
 * PATENT PENDING.
 *
 * Accumulates per-model dollar cost and a per-day total from observed usage.
 * The load-bearing invariant: unpriced calls are tracked SEPARATELY and shown
 * LOUDLY (model + token count) — they are never rolled into the dollar total as
 * $0.00, and a day that is entirely unpriced never reads as "no spend."
 */

function dayOf(ts) {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

function round(n, dp = 6) {
  const f = 10 ** dp;
  return Math.round((Number(n) || 0) * f) / f;
}

export function createTally(deps = {}) {
  const now = deps.now ?? (() => Date.now());
  const days = new Map(); // day -> { pricedUsd, callsPriced, perModel:Map, unpriced:{calls,tokens,models:Map} }

  function dayBucket(day) {
    let b = days.get(day);
    if (!b) {
      b = { pricedUsd: 0, callsPriced: 0, perModel: new Map(), unpriced: { calls: 0, tokens: 0, models: new Map() } };
      days.set(day, b);
    }
    return b;
  }

  /**
   * record one observed call.
   * entry: { ts?, ref, provider, inputTok, outputTok, cacheTok?, priced, costUsd? }
   */
  function record(entry) {
    const ts = entry.ts ?? now();
    const day = dayOf(ts);
    const b = dayBucket(day);
    const ref = entry.ref || "unknown";
    const tokens = (entry.inputTok || 0) + (entry.outputTok || 0) + (entry.cacheTok || 0);

    if (entry.priced) {
      const cost = Number(entry.costUsd) || 0;
      b.pricedUsd += cost;
      b.callsPriced += 1;
      const pm = b.perModel.get(ref) || { ref, provider: entry.provider, calls: 0, costUsd: 0, inputTok: 0, outputTok: 0 };
      pm.calls += 1;
      pm.costUsd += cost;
      pm.inputTok += entry.inputTok || 0;
      pm.outputTok += entry.outputTok || 0;
      b.perModel.set(ref, pm);
    } else {
      b.unpriced.calls += 1;
      b.unpriced.tokens += tokens;
      const um = b.unpriced.models.get(ref) || { ref, provider: entry.provider, calls: 0, tokens: 0 };
      um.calls += 1;
      um.tokens += tokens;
      b.unpriced.models.set(ref, um);
    }
  }

  function summarize(day = dayOf(now())) {
    const b = days.get(day) || { pricedUsd: 0, callsPriced: 0, perModel: new Map(), unpriced: { calls: 0, tokens: 0, models: new Map() } };
    return {
      day,
      pricedUsd: round(b.pricedUsd),
      callsPriced: b.callsPriced,
      perModel: [...b.perModel.values()]
        .map((m) => ({ ...m, costUsd: round(m.costUsd) }))
        .sort((a, z) => z.costUsd - a.costUsd),
      unpriced: {
        calls: b.unpriced.calls,
        tokens: b.unpriced.tokens,
        models: [...b.unpriced.models.values()].sort((a, z) => z.tokens - a.tokens),
      },
    };
  }

  /**
   * A single LOUD human line. Priced dollars AND the unpriced warning always
   * appear together — the unpriced can never hide behind the priced subtotal.
   */
  function loudLine(sum = summarize()) {
    const top = sum.perModel.slice(0, 3).map((m) => `${m.ref} $${m.costUsd.toFixed(4)}`).join(", ");
    let line = `ToggleLogic cost — ${sum.day}: $${sum.pricedUsd.toFixed(4)} across ${sum.callsPriced} priced call(s)`;
    if (top) line += ` (top: ${top})`;
    if (sum.unpriced.calls > 0) {
      const models = sum.unpriced.models.map((m) => `${m.ref}(${m.tokens}t)`).join(", ");
      line += `  ·  ⚠️ UNPRICED: ${sum.unpriced.calls} call(s) / ${sum.unpriced.tokens} tokens from ${models} — not in the curated free-tier price set, so NOT counted in the $ total (upgrade for all-model coverage).`;
    } else {
      line += "  ·  all calls priced.";
    }
    return line;
  }

  function reset() { days.clear(); }

  return { record, summarize, loudLine, reset };
}
