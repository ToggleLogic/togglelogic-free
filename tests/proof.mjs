/* ToggleLogic (Free Tier) — cost-visibility PROOF runner (demonstrative, live). */
import os from "node:os";
import path from "node:path";
import { createPricing } from "../src/usage/pricing.js";
import { createTally } from "../src/usage/cost-tally.js";

const REFS = [
  "google/gemini-3-flash-preview", "google/gemini-3.5-flash",
  "anthropic/claude-opus-4-7", "anthropic/claude-haiku-4-5", "anthropic/claude-sonnet-4-6",
  "xai/grok-4.3", "openai/gpt-5.4-mini", "openai/gpt-5.1",
  "openai-codex/gpt-5.4-mini", "together/meta-llama/Llama-3.3-70B-Instruct-Turbo",
];
const tmp = (n) => path.join(os.tmpdir(), `tl-proof-${n}-${Date.now()}.json`);

console.log("=== PROOF 1+2: LIVE Models.dev fetch resolves real $ prices for the real model set ===");
const live = createPricing({ cachePath: tmp("live") }, { warn: () => {} });
let allPriced = true;
for (const ref of REFS) {
  const r = await live.resolve(ref);
  if (!r.priced) allPriced = false;
  const c = r.priced ? live.costUsd(r, { input: 1_000_000, output: 1_000_000 }) : null;
  console.log(`  ${ref.padEnd(50)} -> ${r.priced ? `$${r.inputPerM}/$${r.outputPerM} /M (src:${r.source})  [1M+1M = $${c.toFixed(2)}]` : "UNPRICED"}`);
}
console.log("  => PROOF 1+2:", allPriced ? "PASS (all real refs resolved live)" : "FAIL");

console.log("\n=== PROOF 3: Models.dev unreachable -> bundled LiteLLM fallback (not a crash, not $0.00) ===");
const fb = createPricing({ cachePath: tmp("nocache") }, { warn: () => {} }, { fetchImpl: async () => { throw new Error("simulated offline"); } });
const fr = await fb.resolve("anthropic/claude-opus-4-7");
console.log(`  anthropic/claude-opus-4-7 (offline) -> ${fr.priced ? `$${fr.inputPerM}/$${fr.outputPerM} /M (src:${fr.source})` : "UNPRICED"}`);
console.log("  => PROOF 3:", fr.priced && fr.source === "bundled" ? "PASS (degraded to bundled)" : "FAIL");

console.log("\n=== PROOF 4: loud-unpriced for an unknown model (never $0.00) ===");
const ur = await live.resolve("acme/unknown-model-9000");
const uc = live.costUsd(ur, { input: 5000, output: 5000 });
const t = createTally();
t.record({ ref: "anthropic/claude-opus-4-7", provider: "anthropic", inputTok: 1000, outputTok: 500, priced: true, costUsd: 0.0175 });
t.record({ ref: "acme/unknown-model-9000", provider: "acme", inputTok: 5000, outputTok: 5000, priced: false });
console.log(`  acme/unknown-model-9000 -> curated:${ur.curated} priced:${ur.priced} cost:${uc === null ? "null (loud — NOT $0.00)" : uc}`);
console.log("  loud line:", t.loudLine());
console.log("  => PROOF 4:", ur.priced === false && uc === null ? "PASS" : "FAIL");
