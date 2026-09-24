const fs = require('fs');
const path = require('path');
const { getPatterns } = require('../skill/bossmate/scripts/privacy-patterns');

const root = path.resolve(__dirname, '..');
const skipDirs = new Set(['.git', 'node_modules', 'output']);
const skipFiles = new Set([
  path.resolve(__filename),
  path.join(root, 'skill', 'bossmate', 'scripts', 'privacy-scan.js'),
  path.join(root, 'skill', 'bossmate', 'scripts', 'privacy-patterns.js'),
]);
const patterns = getPatterns(root);
const hits = [];

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (skipDirs.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full);
      continue;
    }
    if (skipFiles.has(path.resolve(full)) || !/\.(?:js|json|md|yaml|yml|ps1|txt)$/i.test(entry.name)) continue;
    const text = fs.readFileSync(full, 'utf8');
    for (const [name, pattern] of patterns) {
      const match = text.match(pattern);
      if (match) hits.push(`${path.relative(root, full)}: ${name}: ${match[0]}`);
    }
  }
}

walk(root);
if (hits.length) {
  console.error(`RELEASE_CHECK_FAILED hits=${hits.length}`);
  hits.forEach(hit => console.error(hit));
  process.exit(2);
}

const required = [
  'README.md', 'LICENSE', 'package.json', 'bin/bossmate.js',
  'skill/bossmate/SKILL.md', 'skill/bossmate/scripts/boss.js',
  'skill/bossmate/scripts/cdp.js', 'skill/bossmate/scripts/runtime-config.js',
  'skill/bossmate/scripts/cli-args.js', 'skill/bossmate/scripts/ledger-store.js',
  'skill/bossmate/scripts/job-domain.js', 'skill/bossmate/scripts/jd-domain.js',
  'skill/bossmate/scripts/opener-service.js', 'skill/bossmate/scripts/delivery-verification.js',
  'skill/bossmate/scripts/conversation-domain.js', 'skill/bossmate/scripts/page-flows.js',
  'skill/bossmate/scripts/daily-options.js', 'skill/bossmate/scripts/workbench.js',
  'skill/bossmate/scripts/command-help.js', 'skill/bossmate/scripts/offline-commands.js',
  'skill/bossmate/scripts/discovery-sources.js',
  'skill/bossmate/scripts/maintenance.js', 'skill/bossmate/scripts/safety.js'
];
for (const file of required) {
  if (!fs.existsSync(path.join(root, file))) {
    console.error(`RELEASE_CHECK_FAILED missing=${file}`);
    process.exit(2);
  }
}
console.log('RELEASE_CHECK_OK');
