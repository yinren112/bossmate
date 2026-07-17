#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const skip = new Set(['privacy-scan.js']);
const patterns = [
  ['private-windows-path', /C:\\Users\\/i],
  ['source-workspace', /D:\\瓦帕迪力工作/i],
  ['private-username', /wapadil/i],
  ['private-portfolio', /portfolio-os-coral/i],
  ['phone-number', /(?:\+?86[-\s]?)?1[3-9]\d{9}/],
  ['id-card-number', /\b\d{17}[\dXx]\b/],
];
const hits = [];

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full);
      continue;
    }
    if (skip.has(entry.name) || !/\.(?:js|json|md|yaml|yml|ps1)$/i.test(entry.name)) continue;
    const text = fs.readFileSync(full, 'utf8');
    for (const [name, pattern] of patterns) {
      const match = text.match(pattern);
      if (match) hits.push(`${path.relative(root, full)}: ${name}: ${match[0]}`);
    }
  }
}

walk(root);
if (hits.length) {
  console.error(`PRIVACY_FAIL hits=${hits.length}`);
  for (const hit of hits) console.error(hit);
  process.exit(2);
}
console.log('PRIVACY_OK');
