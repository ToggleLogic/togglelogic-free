#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_dir"

npm test
node --check src/index.js
node --check src/routing/family-resolver.js
node --check src/routing/modes.js
node --check src/usage/pricing.js
node - <<'NODE'
const fs = require('node:fs');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const manifest = JSON.parse(fs.readFileSync('openclaw.plugin.json', 'utf8'));
const source = fs.readFileSync('src/index.js', 'utf8');
const runtime = /const PLUGIN_VERSION = "([^"]+)"/.exec(source)?.[1];
if (!runtime || pkg.version !== manifest.version || pkg.version !== runtime) {
  throw new Error('release identity mismatch');
}
if (!pkg.private || !pkg.version.includes('-rc.')) {
  throw new Error('release-candidate package must remain private and use an rc version');
}
NODE
npm_pack_report="$(mktemp -t togglelogic-pack-dry-run.XXXXXX)"
trap 'rm -f "$npm_pack_report"' EXIT
npm pack --dry-run --json >"$npm_pack_report"
node - "$npm_pack_report" <<'NODE'
const fs = require('node:fs');
const report = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))[0];
const names = report.files.map((file) => file.path);
const forbidden = names.filter((name) => /(^|\/)(tests?|reports?|\.git|node_modules)(\/|$)|normalized\.json|classifier/i.test(name));
if (forbidden.length) throw new Error(`forbidden package files: ${forbidden.join(', ')}`);
if (!names.includes('src/routing/family-resolver.js')) throw new Error('family resolver missing from package');
NODE
echo "ToggleLogic release-candidate quality gate passed."
