#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { getPatterns } = require('./privacy-patterns');

const root = path.resolve(__dirname, '..');
const repoRoot = path.resolve(__dirname, '..', '..', '..');
const skip = new Set(['privacy-scan.js', 'privacy-patterns.js']);
const patterns = getPatterns(repoRoot);
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
