const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const skipDirs = new Set(['.git', 'node_modules']);
const skipFiles = new Set([
  path.resolve(__filename),
  path.join(root, 'skill', 'bossmate', 'scripts', 'privacy-scan.js'),
]);
const patterns = [
  ['private-windows-path', /C:\\Users\\/i],
  ['private-workspace', /D:\\瓦帕迪力工作/i],
  ['private-username', /wapadil/i],
  ['private-portfolio', /portfolio-os-coral/i],
  ['phone-number', /(?:\+?86[-\s]?)?1[3-9]\d{9}/],
  ['id-card-number', /\b\d{17}[\dXx]\b/],
];
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
  'skill/bossmate/scripts/cdp.js'
];
for (const file of required) {
  if (!fs.existsSync(path.join(root, file))) {
    console.error(`RELEASE_CHECK_FAILED missing=${file}`);
    process.exit(2);
  }
}
console.log('RELEASE_CHECK_OK');
