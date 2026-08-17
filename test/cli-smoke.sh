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
[ -f contractor.config.json ] || fail "init did not write the config"
ok "config scaffolded"

echo "== doctor rejects the stub =="
if $CLI doctor > /dev/null 2>&1; then
  fail "doctor passed a config with no areas and no gates"
fi
ok "stub config rejected"

echo "== adapt the config =="
node -e '
const fs = require("fs");
const c = JSON.parse(fs.readFileSync("contractor.config.json", "utf8"));
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
fs.writeFileSync("contractor.config.json", JSON.stringify(c, null, 2));
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
M=.contractor/missions/demo
[ -f "$M/mission-state.json" ] || fail "mission-state not scaffolded"
[ -f "$M/spec.md" ] || fail "spec template not scaffolded"

$CLI arm "$M" > /dev/null
$CLI status | grep -q ARMED || fail "mission did not arm"
node -e '
const s = require("fs").readFileSync(".contractor/missions/demo/mission-state.json", "utf8");
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
const p = ".contractor/missions/demo/mission-state.json";
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
const p = ".contractor/missions/demo/mission-state.json";
const s = JSON.parse(fs.readFileSync(p, "utf8"));
s.assertionStatus = { "A-1": "failing" };
s.correctiveRounds = { M1: 2 };
fs.writeFileSync(p, JSON.stringify(s, null, 2));
'
adv | grep -q CIRCUIT-BREAK || fail "the cap should yield CIRCUIT-BREAK"

node -e '
const fs = require("fs");
const p = ".contractor/missions/demo/mission-state.json";
const s = JSON.parse(fs.readFileSync(p, "utf8"));
s.assertionStatus = { "A-1": "passing" };
s.correctiveRounds = { M1: 0 };
s.integrationGate.passed = true;
fs.writeFileSync(p, JSON.stringify(s, null, 2));
fs.writeFileSync(".contractor/missions/demo/verdicts/M1-billing.json", JSON.stringify({
  area: "billing",
  verdicts: [{ id: "A-1", verdict: "pass", evidence: "npm test exit 0" }],
  boundaryViolations: [], missingDefaults: [], testGaps: []
}, null, 2));
'
adv | grep -q ADVANCE || fail "a clean milestone should yield ADVANCE"
ok "advance decisions correct"

echo "== gated is not done =="
node -e '
const fs = require("fs");
const p = ".contractor/missions/demo/mission-state.json";
const s = JSON.parse(fs.readFileSync(p, "utf8"));
s.assertionStatus = { "A-1": "skipped" };
fs.writeFileSync(p, JSON.stringify(s, null, 2));
'
adv | grep -q "must NOT be recorded done" || fail "an unverifiable assertion should gate the mission"
ok "gated state surfaced"

echo "== brief =="
$CLI brief > /tmp/contractor-brief.$$ || fail "brief exited non-zero"
grep -q "Mission rehydration brief" /tmp/contractor-brief.$$ || fail "brief did not render"
[ "$(wc -c < /tmp/contractor-brief.$$)" -le 6000 ] || fail "brief exceeded its hard budget"
rm -f /tmp/contractor-brief.$$
ok "brief renders within budget"

echo "== disarm =="
$CLI disarm gated "$M" > /dev/null
$CLI status | grep -q INERT || fail "disarm did not go inert"
grep -q '"missionStatus": "gated"' "$M/mission-state.json" || fail "disarm did not record the honest status"
echo '{"tool_name":"Edit","tool_input":{"file_path":"src/auth/session.ts"}}' | $CLI route
grep -q 'session.ts' "$M/.pending-validation.json" && fail "the hook must be inert once disarmed"
ok "disarmed, hook inert"

echo
echo "PASS — CLI smoke test"
