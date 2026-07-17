#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const arg = name => {
  const hit = process.argv.slice(2).find(value => value.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : '';
};

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(`BossMate private workspace setup

Usage:
  node scripts/setup.js [--home=<path>]

Options:
  --home=<path>  Private workspace location; defaults to ~/.bossmate
  --help         Show this help without creating files`);
  process.exit(0);
}

const home = path.resolve(arg('home') || process.env.BOSSMATE_HOME || process.env.BOSS_JOB_HOME ||
  path.join(process.env.USERPROFILE || process.env.HOME || process.cwd(), '.bossmate'));
const assets = path.resolve(__dirname, '..', 'assets');
const files = [
  ['profile.template.md', 'profile.md'],
  ['preferences.template.json', 'preferences.json'],
  ['ledger.template.json', path.join('data', 'ledger.json')],
];

fs.mkdirSync(home, { recursive: true });
const created = [];
const kept = [];
for (const [sourceName, targetName] of files) {
  const target = path.join(home, targetName);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (fs.existsSync(target)) {
    kept.push(targetName);
    continue;
  }
  fs.copyFileSync(path.join(assets, sourceName), target);
  created.push(targetName);
}

console.log(JSON.stringify({ home, created, kept, next: '让用户确认 profile.md 和 preferences.json，再把 onboarding.confirmed 改为 true。' }, null, 2));
