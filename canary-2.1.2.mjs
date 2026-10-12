// HQ canary for ToggleLogic Free 2.1.2 — proves the hook-permission defect is now observable.
// Runs against the 2.1.2 source with fake denied/granted apis. No gateway, no HQ config touched.
import { registerCapabilities } from "./src/capabilities.js";
import { normalizeConfig } from "./src/config/normalize.js";
import { createConversationAccessCheck } from "./src/health/conversation-access-check.js";

let failures = 0;
const ok = (name, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${name}`); if (!cond) failures++; };

function makeApi({ granted }) {
  const errors = [], handlers = [];
  const hooks = granted ? { allowConversationAccess: true } : {};
  return {
    api: {
      config: { plugins: { entries: { togglelogic: { enabled: true, hooks, config: { mode: "intelligence", features: { routing: { enabled: true } } } } } },
                models: { providers: {} }, agents: { defaults: { models: {} } } },
      pluginConfig: { mode: "intelligence", features: { routing: { enabled: true } } },
      logger: { error: (m) => errors.push(String(m)), warn: () => {}, info: () => {}, debug: () => {} },
      on: (event, handler) => handlers.push({ event, handler }),
    },
    errors, handlers,
  };
}
function makeAudit() { const events = []; return { audit: { emit: (e) => events.push(e) }, events }; }

async function run(label, granted) {
  console.log(`\n=== ${label} (allowConversationAccess ${granted ? "= true" : "absent"}) ===`);
  const { api, errors, handlers } = makeApi({ granted });
  const { audit, events } = makeAudit();
  const config = normalizeConfig(api.pluginConfig);
  const { gates } = registerCapabilities({ api, audit, fallbackLogger: api.logger, version: "2.1.2", config });

  const SETTING = "plugins.entries.togglelogic.hooks.allowConversationAccess";
  const skips = events.filter((e) => e.event === "routing.skipped");
  const routingGate = gates.find((g) => g.id === "routing");
  const beforeResolve = handlers.find((h) => h.event === "before_model_resolve");
  const sessionStart = handlers.find((h) => h.event === "session_start");

  if (!granted) {
    ok("error-level startup message names the exact setting", errors.some((e) => e.includes(SETTING) && /DISABLED/i.test(e)));
    ok("routing.skipped audit emitted at register (outcome=skip)", skips.some((e) => e.outcome === "skip" && e.details?.requiredSetting === SETTING));
    ok("session_start handler registered (non-gated hook)", !!sessionStart);
    // fire session_start -> should emit another routing.skipped
    const before = skips.length; sessionStart && sessionStart.handler({}, {});
    ok("routing.skipped re-emitted on session_start", events.filter((e) => e.event === "routing.skipped").length > before);
    ok("routing gate reports NOT ready", routingGate && routingGate.enabled === false && routingGate.ready === false && routingGate.reason === "conversation-access-denied");
    ok("conversation routing hook NOT registered when denied", !beforeResolve);
  } else {
    ok("no error logged when granted", errors.length === 0);
    ok("no routing.skipped audit when granted", skips.length === 0);
    ok("before_model_resolve routing hook IS registered when granted", !!beforeResolve);
  }

  // Health check (doctor readiness) — tested directly
  const check = createConversationAccessCheck();
  const findings = await check.detect({ cfg: api.config });
  if (!granted) ok("doctor health check returns an ERROR finding when denied", findings.length === 1 && findings[0].severity === "error" && findings[0].ocPath === SETTING);
  else ok("doctor health check returns NO findings when granted", findings.length === 0);
}

console.log(`node ${process.version} — ToggleLogic Free 2.1.2 canary on $(hostname)`);
await run("DENIED", false);
await run("GRANTED", true);
console.log(`\n${failures === 0 ? "CANARY PASS — all assertions held" : "CANARY FAIL — " + failures + " assertion(s) failed"}`);
process.exit(failures === 0 ? 0 : 1);
