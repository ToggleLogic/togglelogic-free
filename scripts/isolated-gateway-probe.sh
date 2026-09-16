#!/usr/bin/env bash
# ToggleLogic (Free Tier) — isolated OpenClaw GATEWAY round-trip probe (Blocker 3).
# (c) 2026 Motherboard, Inc. Source-available under the ToggleLogic Free-Tier License.
#
# Drives a REAL, installed OpenClaw gateway against a THROWAWAY temp state/profile
# (never the live ~/.openclaw config) to gather first-hand evidence of what the
# development plugin actually does on this host. Unlike the earlier revision — which
# proved only the automatable setup half and DOCUMENTED the running-gateway step —
# this version performs a GENUINE automated round trip:
#
#   * starts ONLY its own gateway process on a collision-checked, non-live loopback
#     port (never --force, never the live gateway);
#   * sends an actionable NO-SKILL prompt through that gateway;
#   * asserts the exact universal fail-safe reply, ONE no-skill before_agent_reply
#     audit row, and ZERO before_model_resolve rows (the gate handled the turn with
#     no model resolution);
#   * cleans up ONLY its own PID and temp dir.
#
# If it cannot PROVE the round trip it exits NON-ZERO and labels the round trip
# UNPROVEN, so it can never read as a false green.
#
# Usage: bash scripts/isolated-gateway-probe.sh [plugin-root]
# Requires: `openclaw` (2026.9.4) on PATH, node, python3. No network, no creds.

set -uo pipefail
PLUGIN_ROOT="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
FREE_VERSION="$(node -e "process.stdout.write(require('${PLUGIN_ROOT}/package.json').version)")"
INTEL_VERSION="1.4.1-rc.5"
FAILSAFE="I don't have a skill that relates to what you're asking me to do."
NO_SKILL_PROMPT="Write a limerick about pickles."
CANARY_SESSION="agent:main:qa-canary"

# Capture the LIVE gateway port BEFORE we override the config path, so we can
# explicitly exclude it when choosing our throwaway port (defence in depth on top
# of the live-listener collision check below). Read-only; never connects.
LIVE_GATEWAY_PORT="$(openclaw config get gateway.port 2>/dev/null | grep -oE '[0-9]+' | head -1 || true)"

TMP="$(mktemp -d -t tl-iso-gw-XXXXXX)"
STATE="$TMP/state"; mkdir -p "$STATE"
CFG="$TMP/openclaw.json"
SNAP="$TMP/skill-inventory.snapshot.json"
AUDIT="$TMP/audit.jsonl"
GW_LOG="$TMP/gateway.log"
AGENT_OUT="$TMP/agent.json"
GW_PID=""
export OPENCLAW_STATE_DIR="$STATE" OPENCLAW_CONFIG_PATH="$CFG"
unset ANTHROPIC_API_KEY OPENAI_API_KEY GEMINI_API_KEY GOOGLE_API_KEY XAI_API_KEY

pass=0; fail=0
ok(){ echo "  [PROVEN] $1"; pass=$((pass+1)); }
no(){ echo "  [NOT PROVEN] $1"; fail=$((fail+1)); }
cleanup(){
  # Kill ONLY our own gateway process, never anything else. Then remove ONLY our
  # temp dir. Never touches the live gateway or the live config.
  if [ -n "$GW_PID" ] && kill -0 "$GW_PID" 2>/dev/null; then
    kill "$GW_PID" 2>/dev/null
    for _ in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$GW_PID" 2>/dev/null || break; sleep 0.3; done
    kill -9 "$GW_PID" 2>/dev/null || true
  fi
  rm -rf "$TMP"
}
trap cleanup EXIT INT TERM

# Bind-test a loopback port; exit 0 if FREE, 1 if in use. Loopback only.
port_free(){ node -e "const net=require('net');const s=net.createServer();s.once('error',()=>process.exit(1));s.listen(Number(process.argv[1]),'127.0.0.1',()=>s.close(()=>process.exit(0)));" "$1" 2>/dev/null; }

pick_port(){
  local base=$(( 20000 + (RANDOM % 15000) )) i cand
  for i in $(seq 0 200); do
    cand=$(( base + i ))
    [ "$cand" -gt 65500 ] && continue
    [ -n "$LIVE_GATEWAY_PORT" ] && [ "$cand" = "$LIVE_GATEWAY_PORT" ] && continue
    if port_free "$cand"; then echo "$cand"; return 0; fi
  done
  return 1
}

echo "== ToggleLogic isolated OpenClaw GATEWAY round-trip probe =="
echo "   openclaw:   $(openclaw --version 2>/dev/null | head -1)"
echo "   plugin:     $PLUGIN_ROOT ($FREE_VERSION)"
echo "   profile:    $TMP (throwaway; live config untouched)"
echo "   live port:  ${LIVE_GATEWAY_PORT:-unknown} (excluded)"

PORT="$(pick_port || true)"
if [ -z "${PORT:-}" ]; then
  no "could not find a free non-live loopback port for an isolated gateway"
  echo; echo "== SUMMARY: automated checks proven=$pass  not-proven=$fail =="
  exit 3
fi
echo "   temp port:  $PORT (collision-checked, non-live)"
echo

# 1) Real snapshot generated INSIDE the temp profile from `openclaw skills list`.
node "$PLUGIN_ROOT/scripts/generate-skill-inventory.mjs" --out "$SNAP" --free "$FREE_VERSION" --intelligence "$INTEL_VERSION" >/dev/null 2>&1 \
  && [ -s "$SNAP" ] && ok "in-profile skill snapshot generated ($(python3 -c "import json;print(len(json.load(open('$SNAP'))['skills']))") eligible)" \
  || no "in-profile skill snapshot generation"

# 2) Isolated config: dev plugin via plugins.load.paths + a loopback gateway on our
#    chosen non-live port with auth none (so `openclaw agent` connects to OUR gateway).
python3 - "$TMP" "$PLUGIN_ROOT" "$SNAP" "$PORT" <<'PY'
import json,sys,os
tmp,root,snap,port=sys.argv[1],sys.argv[2],sys.argv[3],int(sys.argv[4])
cfg={"gateway":{"mode":"local","bind":"loopback","port":port,"auth":{"mode":"none"}},
 "agents":{"defaults":{"model":"anthropic/claude-sonnet-5"}},
 "plugins":{"allow":["togglelogic"],"load":{"paths":[root]},
  "entries":{"togglelogic":{"enabled":True,"hooks":{"allowConversationAccess":True},
   "subagent":{"allowModelOverride":True},
   "config":{"mode":"passthrough","intelligence":{"enabled":False},
    "features":{"routing":{"enabled":True},"skillRouting":{"enabled":True}},
    "skillRouting":{"inventorySnapshotPath":snap,"inventoryMarkerPath":os.path.join(tmp,"accepted.json"),
     "scope":{"enabled":True,"allowGlobal":True,"requireOwner":False}},
    "audit":{"enabled":True,"path":os.path.join(tmp,"audit.jsonl")}}}}}}
open(os.path.join(tmp,"openclaw.json"),"w").write(json.dumps(cfg,indent=2))
PY

# 3) Config validates against the real host schema.
openclaw config validate --json 2>/dev/null | grep -q '"valid":true' \
  && ok "isolated config validates against the real 2026.9.4 schema" \
  || no "config schema validation"

# 4) Plugin loads with zero load errors (doctor).
openclaw plugins doctor --json >"$TMP/doctor.json" 2>/dev/null
python3 -c "import json;d=json.load(open('$TMP/doctor.json'));import sys;sys.exit(0 if not d.get('pluginErrors') else 1)" \
  && ok "plugin loads with zero pluginErrors (doctor)" \
  || no "plugin load (doctor pluginErrors present)"

# 5) Runtime registration: hooks DECLARED (incl. the before_agent_reply gate + the
#    before_tool_call bounded-child guard) and tools registered.
openclaw plugins inspect togglelogic --runtime --json >"$TMP/inspect.json" 2>/dev/null
python3 - "$TMP/inspect.json" <<'PY'
import json,sys
d=json.load(open(sys.argv[1]))
typed=[h['name'] for h in d.get('typedHooks',[])]
tools=d.get('plugin',{}).get('toolNames',[])
need={'before_agent_reply','before_tool_call','before_model_resolve'}
sys.exit(0 if need.issubset(set(typed)) and 'togglelogic_skill_run' in tools else 1)
PY
if [ $? -eq 0 ]; then ok "hooks declared (before_agent_reply + before_tool_call + before_model_resolve) and tools registered"; else no "runtime hook/tool registration"; fi

# 6) START OUR OWN GATEWAY (foreground process, backgrounded here). Never --force,
#    never the live port. loopback + auth none. We capture the PID and kill only it.
rm -f "$AUDIT"
openclaw gateway run --port "$PORT" --auth none --bind loopback --allow-unconfigured >"$GW_LOG" 2>&1 &
GW_PID=$!

gw_ready=""
for _ in $(seq 1 40); do
  if ! kill -0 "$GW_PID" 2>/dev/null; then break; fi                 # process died
  if openclaw gateway health --port "$PORT" --json 2>/dev/null | grep -q '"ok":[[:space:]]*true'; then gw_ready=1; break; fi
  sleep 0.5
done
if [ -n "$gw_ready" ]; then ok "isolated gateway is healthy on 127.0.0.1:$PORT (own PID $GW_PID)"; else no "isolated gateway did not become healthy (see $GW_LOG)"; fi

# 7) THE LIVE ROUND TRIP — an actionable NO-SKILL prompt through OUR gateway.
echo
echo "== LIVE before_agent_reply round trip =="
round_trip_proven=0
if [ -n "$gw_ready" ]; then
  openclaw agent --message "$NO_SKILL_PROMPT" --session-key "$CANARY_SESSION" --json --timeout 60 >"$AGENT_OUT" 2>"$TMP/agent.err" || true

  # 7a) Exact fail-safe reply (and ONLY the fail-safe) came back.
  if python3 - "$AGENT_OUT" "$FAILSAFE" <<'PY'
import json,sys
try:
    doc=json.load(open(sys.argv[1]))
except Exception as e:
    print("  parse error:",e); sys.exit(1)
want=sys.argv[2]
# `openclaw agent --json` (2026.9.4) returns the reply under result.payloads[].text
# and mirrors it in result.meta.finalAssistant{Visible,Raw}Text. Collect exactly the
# assistant-visible reply channels — not the whole doc — so a fabricated limerick
# (a different string) fails the exact-match assertion.
cands=[]
def add(v):
    if isinstance(v,str) and v.strip(): cands.append(v.strip())
r=doc.get("result") if isinstance(doc.get("result"),dict) else {}
for p in (r.get("payloads") if isinstance(r.get("payloads"),list) else []):
    if isinstance(p,dict): add(p.get("text"))
meta=r.get("meta") if isinstance(r.get("meta"),dict) else {}
add(meta.get("finalAssistantVisibleText"))
add(meta.get("finalAssistantRawText"))
# Older/alternate shapes, harmless if absent.
for k in ("reply","text","content","message"): add(r.get(k))
if not cands:
    print("  no reply text found in agent JSON"); sys.exit(1)
# The exact fail-safe must be the reply; and no OTHER non-empty assistant text may
# have leaked. status must be ok too.
other=[c for c in cands if c!=want]
if str(doc.get("status")) not in ("ok","success"): print("  agent status:",doc.get("status")); sys.exit(1)
sys.exit(0 if want in cands and not other else 1)
PY
  then ok "gateway reply is EXACTLY the universal no-skill fail-safe"; round_trip_proven=$((round_trip_proven+1)); else no "gateway reply was not exactly the fail-safe (see $AGENT_OUT)"; fi

  # 7b) Exactly ONE no-skill before_agent_reply audit row, and ZERO before_model_resolve rows.
  if python3 - "$AUDIT" <<'PY'
import json,os,sys
p=sys.argv[1]
if not os.path.exists(p): print("  no audit file"); sys.exit(1)
rows=[]
for line in open(p):
    line=line.strip()
    if not line: continue
    try: rows.append(json.loads(line))
    except Exception: pass
def subj(r): return r.get("subject",{}) if isinstance(r.get("subject"),dict) else {}
def det(r):  return r.get("details",{}) if isinstance(r.get("details"),dict) else {}
no_skill=[r for r in rows if subj(r).get("hook")=="before_agent_reply" and det(r).get("mode")=="no_skill_failsafe"]
before_model=[r for r in rows if subj(r).get("hook")=="before_model_resolve"]
print(f"  before_agent_reply no_skill rows={len(no_skill)}  before_model_resolve rows={len(before_model)}")
sys.exit(0 if len(no_skill)==1 and len(before_model)==0 else 1)
PY
  then ok "audit shows ONE no-skill before_agent_reply row and ZERO before_model_resolve rows"; round_trip_proven=$((round_trip_proven+1)); else no "audit did not show the expected no-skill / zero-model-resolve rows"; fi
else
  no "gateway not healthy — LIVE round trip UNPROVEN"
fi

if [ "$round_trip_proven" -eq 2 ]; then
  echo "  => before_agent_reply HANDLED the turn with ZERO provider model calls (PROVEN, live gateway)."
else
  echo "  => LIVE round trip UNPROVEN (see artifacts under the temp profile before cleanup)."
fi

echo
echo "== SUMMARY: automated checks proven=$pass  not-proven=$fail  round-trip-asserts=$round_trip_proven/2 =="
if [ "$fail" -eq 0 ] && [ "$round_trip_proven" -eq 2 ]; then exit 0; else exit 3; fi
