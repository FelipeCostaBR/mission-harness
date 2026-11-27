#!/usr/bin/env bash
# End-to-end smoke test: drive the CLI against a real throwaway repository.
#
# This asserts the harness's deterministic half actually works — scaffolds,
# validates a config against reality, routes edits, and reaches the right
# advance decision. A test that only checked the help text would pass while
# every one of those was broken.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI="node $ROOT/src/cli.mjs"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }
ok()   { echo "  ok  $*"; }

cd "$TMP"
mkdir -p src/billing src/auth test/billing db packages/core-math
git init -q
git config user.email t@example.com
git config user.name test
for f in src/billing/invoice.ts src/auth/session.ts test/billing/invoice.test.ts \
         db/schema.prisma packages/core-math/bmr.ts src/router.ts; do
  echo "// $f" > "$f"
done
cat > package.json <<'JSON'
{ "name": "smoke", "scripts": { "typecheck": "true", "lint": "true", "test": "true" } }
JSON
git add -A && git commit -qm init

echo "== init =="
$CLI init > /dev/null
[ -f mission.config.json ] || fail "init did not write the config"
ok "config scaffolded"

echo "== doctor rejects the stub =="
if $CLI doctor > /dev/null 2>&1; then
  fail "doctor passed a config with no areas and no gates"
fi
ok "stub config rejected"

echo "== adapt the config =="
node -e '
const fs = require("fs");
const c = JSON.parse(fs.readFileSync("mission.config.json", "utf8"));
c.project = { name: "smoke", description: "" };
c.areas = [
  { slug: "billing", pathGlobs: ["src/billing/**", "test/billing/**"], surface: "service" },
  { slug: "auth", pathGlobs: ["src/auth/**"], surface: "service" }
];
c.surfaces = { service: { gates: ["npm run typecheck"], designSpec: false } };
c.gates = { pre: [], integration: [{ cmd: "npm run typecheck", why: "types" }] };
c.protectedPaths = [
  { glob: "db/schema.prisma", reason: "schema", companionGlobs: ["db/migrations/**"] },
  { glob: "packages/core-math/**", reason: "shared formulas", alwaysDelegate: true }
];
c.testGlobs = ["test/**"];
c.additivePairs = [{ primary: "db/schema.prisma", generated: "db/migrations/**" }];
fs.writeFileSync("mission.config.json", JSON.stringify(c, null, 2));
'
$CLI doctor > /dev/null || fail "doctor rejected a valid config"
ok "doctor passes"

echo "== ownership routing =="
$CLI own src/billing/invoice.ts | grep -q billing || fail "billing path not routed"
$CLI own db/schema.prisma | grep -q unowned || fail "protected path should be unowned"
ok "paths route correctly"

echo "== escalation routing =="
$CLI escalate src/shared/x.ts --additive-only | grep -q INLINE || fail "trivial escalation should be inline"
$CLI escalate packages/core-math/bmr.ts --additive-only | grep -q DELEGATE \
  || fail "alwaysDelegate path should delegate regardless of size"
$CLI escalate src/a.ts src/b.ts | grep -q DELEGATE || fail "multi-file should delegate"
ok "escalations route correctly"

echo "== mission lifecycle =="
$CLI mission new demo > /dev/null
M=docs/prd/demo
[ -f "$M/mission-state.json" ] || fail "mission-state not scaffolded"
[ -f "$M/spec.md" ] || fail "spec template not scaffolded"

$CLI arm "$M" > /dev/null
$CLI status | grep -q ARMED || fail "mission did not arm"
node -e '
const s = require("fs").readFileSync("docs/prd/demo/mission-state.json", "utf8");
if (!JSON.parse(s).queueSubstrate) { console.error("queueSubstrate not recorded at arm time"); process.exit(1); }
' || fail "arm did not record the queue substrate probe"
ok "armed, substrate probed"

echo '{"tool_name":"Edit","tool_input":{"file_path":"src/billing/invoice.ts"},"session_id":"s1"}' | $CLI route
echo '{"tool_name":"Edit","tool_input":{"file_path":"db/schema.prisma"},"session_id":"s1"}' | $CLI route
grep -q '"area": "billing"' "$M/.pending-validation.json" || fail "owned edit was not queued"
grep -q 'schema.prisma' "$M/.pending-validation.json" && fail "unowned edit must NOT be queued"
ok "edit routing queues owned paths only"

echo "== advance decision =="
node -e '
const fs = require("fs");
const p = "docs/prd/demo/mission-state.json";
const s = JSON.parse(fs.readFileSync(p, "utf8"));
s.milestones = [{ id: "M1", order: 1, status: "pending", features: ["F1"], assertions: ["A-1"] }];
s.currentMilestone = "M1";
s.assertionStatus = { "A-1": "failing" };
s.correctiveRounds = { M1: 0 };
s.integrationGate = { passed: false, scope: "M1", ts: "2026-01-01T00:00:00Z" };
fs.writeFileSync(p, JSON.stringify(s, null, 2));
'
# `advance` exits 2 when a milestone is not clean — that is deliberate API
# surface for scripts, so capture the output rather than asserting through a
# pipeline (which would conflate the decision with the exit code).
adv() { $CLI advance 2>&1 || true; }
adv | grep -q CORRECTIVE || fail "a failing assertion should yield CORRECTIVE"

node -e '
const fs = require("fs");
const p = "docs/prd/demo/mission-state.json";
const s = JSON.parse(fs.readFileSync(p, "utf8"));
s.assertionStatus = { "A-1": "failing" };
s.correctiveRounds = { M1: 2 };
fs.writeFileSync(p, JSON.stringify(s, null, 2));
'
adv | grep -q CIRCUIT-BREAK || fail "the cap should yield CIRCUIT-BREAK"

node -e '
const fs = require("fs");
const p = "docs/prd/demo/mission-state.json";
const s = JSON.parse(fs.readFileSync(p, "utf8"));
s.correctiveRounds = { M1: 0 };
s.integrationGate.passed = true;
fs.writeFileSync(p, JSON.stringify(s, null, 2));
fs.writeFileSync("docs/prd/demo/verdicts/incoming/M1-billing-r1.json", JSON.stringify({
  area: "billing",
  verdicts: [{ id: "A-1", verdict: "pass", evidence: "npm test exit 0" }],
  boundaryViolations: [], missingDefaults: [], testGaps: []
}, null, 2));
'
RAW=verdicts/incoming/M1-billing-r1.json
$CLI digest "$M" "$RAW" | grep -q '"passing":1' || fail "raw verdict digest did not report a pass"
adv | grep -q CORRECTIVE || fail "unrecorded verdict must not drive an advance"
if $CLI state "$M" set-assertion A-1 passing > /dev/null 2>&1; then
  fail "unrecorded verdict supplied evidence for a passing assertion"
fi
$CLI state "$M" record-verdict M1 "$RAW" > /dev/null
cmp -s "$M/$RAW" "$M/verdicts/M1-billing-r1.json" || fail "record-verdict did not retain the raw bytes"
adv | grep -q ADVANCE || fail "a clean milestone should yield ADVANCE"
ok "advance decisions correct"

echo "== attempt usage =="
$CLI usage start "$M" '{"id":"first","role":"validator","phase":"validate","model":"gpt-6.2-sol"}' > /dev/null
$CLI usage finish "$M" first interrupted > /dev/null
$CLI usage start "$M" '{"id":"second","role":"validator","phase":"validate","model":"gpt-6.2-sol","retryOf":"first"}' > /dev/null
printf '%s\n' '{"type":"turn.completed","usage":{"input_tokens":1000,"cached_input_tokens":950,"output_tokens":25}}' > usage.jsonl
SOURCE="$(node -pe 'JSON.stringify({format:"codex-exec",path:require("node:path").resolve("usage.jsonl")})')"
$CLI usage finish "$M" second completed "$SOURCE" > /dev/null
$CLI usage report "$M" --json | node -e '
const r = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
if (r.attempts !== 2 || r.retries !== 1 || r.interrupted !== 1 || r.missingUsage !== 1 ||
    r.totals.input !== 1000 || r.totals.standardApiUsdBeforeCacheWrites !== null) process.exit(1);
' || fail "usage report did not account for both attempts"
adv | grep -q ADVANCE || fail "usage report changed the advance decision"
ok "usage includes retries and leaves validation intact"

echo "== gated is not done =="
node -e '
const fs = require("fs");
const p = "docs/prd/demo/mission-state.json";
const s = JSON.parse(fs.readFileSync(p, "utf8"));
s.assertionStatus = { "A-1": "skipped" };
fs.writeFileSync(p, JSON.stringify(s, null, 2));
'
adv | grep -q "must NOT be recorded done" || fail "an unverifiable assertion should gate the mission"
ok "gated state surfaced"

echo "== brief =="
$CLI brief > /tmp/mission-brief.$$ || fail "brief exited non-zero"
grep -q "Mission rehydration brief" /tmp/mission-brief.$$ || fail "brief did not render"
[ "$(wc -c < /tmp/mission-brief.$$)" -le 6000 ] || fail "brief exceeded its hard budget"
rm -f /tmp/mission-brief.$$
ok "brief renders within budget"

echo "== disarm =="
$CLI disarm gated "$M" > /dev/null
$CLI status | grep -q INERT || fail "disarm did not go inert"
grep -q '"missionStatus": "gated"' "$M/mission-state.json" || fail "disarm did not record the honest status"
echo '{"tool_name":"Edit","tool_input":{"file_path":"src/auth/session.ts"}}' | $CLI route
grep -q 'session.ts' "$M/.pending-validation.json" && fail "the hook must be inert once disarmed"
ok "disarmed, hook inert"

echo "== Codex adapter model routing =="
seat_model() { node -pe 'JSON.parse(require("fs").readFileSync(0, "utf8")).model'; }
[ "$($CLI seat resolve '{"role":"worker"}' | seat_model)" = sonnet ] || fail "generic worker tier changed"
cp mission.config.json expected-config.json
printf '%s\n' '# Existing project instructions' > AGENTS.md
$CLI install codex > /dev/null
cmp -s mission.config.json expected-config.json || fail "adapter overwrote the project config"
[ "$(cat AGENTS.md)" = '# Existing project instructions' ] || fail "adapter overwrote project instructions"
for role in worker scout browser-scout; do
  [ "$($CLI seat resolve "{\"role\":\"$role\"}" | seat_model)" = gpt-6.1-terra ] || fail "$role should use Terra"
done
[ "$($CLI seat resolve '{"role":"validator"}' | seat_model)" = gpt-6.2-sol ] || fail "validator should use Sol"
[ "$($CLI seat session orchestrator | seat_model)" = gpt-6.2-sol ] || fail "orchestrator should use Sol"
$CLI prompt seats/browser-scout | grep -q '"observation"' || fail "browser scout prompt is missing URL evidence"

first=$($CLI seat corrective "$M" M1 --cause assertion --triggers '["A-1"]')
node -e 'const s = JSON.parse(process.argv[1]); if (s.model !== "gpt-6.1-terra" || s.rung !== "L4") process.exit(1)' "$first" \
  || fail "first correction should climb one rung on Terra"
$CLI state "$M" bump-round M1 --type corrective --trigger A-1 --seat gpt-6.1-terra/high --rung L4 > /dev/null
second=$($CLI seat corrective "$M" M1 --cause assertion --triggers '["A-2"]')
node -e 'const s = JSON.parse(process.argv[1]); if (s.model !== "gpt-6.1-terra" || s.rung !== "L5") process.exit(1)' "$second" \
  || fail "next correction should resume from the recorded L4 rung"

node -e '
const fs = require("fs");
const cfg = JSON.parse(fs.readFileSync("mission.config.json", "utf8"));
cfg.models.terra = { codex: "terra-new-release" };
cfg.models.sol = { codex: "sol-new-release" };
fs.writeFileSync("mission.config.json", JSON.stringify(cfg));
'
[ "$($CLI seat resolve '{"role":"browser-scout"}' | seat_model)" = terra-new-release ] || fail "Terra override was ignored"
[ "$($CLI seat session planner | seat_model)" = sol-new-release ] || fail "Sol override was ignored"
ok "Codex defaults, corrective rungs and model upgrades resolve"

echo
echo "PASS — CLI smoke test"
