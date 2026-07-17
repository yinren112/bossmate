#!/usr/bin/env node
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline/promises');

const SKILL_NAME = 'bossmate';
const source = path.resolve(__dirname, '..', 'skill', SKILL_NAME);
const argv = process.argv.slice(2);

function value(name) {
  const equals = argv.find(arg => arg.startsWith(`--${name}=`));
  if (equals) return equals.slice(name.length + 3);
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] || '' : '';
}

function hashDirectory(dir) {
  const hash = crypto.createHash('sha256');
  const walk = current => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name);
      const relative = path.relative(dir, full).replace(/\\/g, '/');
      hash.update(relative);
      if (entry.isDirectory()) walk(full);
      else hash.update(fs.readFileSync(full));
    }
  };
  walk(dir);
  return hash.digest('hex');
}

function targets(agent, scope, cwd, home) {
  const project = scope === 'project';
  const map = {
    codex: project ? path.join(cwd, '.agents', 'skills', SKILL_NAME) : path.join(home, '.agents', 'skills', SKILL_NAME),
    claude: project ? path.join(cwd, '.claude', 'skills', SKILL_NAME) : path.join(home, '.claude', 'skills', SKILL_NAME),
    opencode: project ? path.join(cwd, '.opencode', 'skills', SKILL_NAME) : path.join(home, '.config', 'opencode', 'skills', SKILL_NAME),
    hermes: path.join(home, '.hermes', 'skills', 'job-search', SKILL_NAME),
    workbuddy: project ? path.join(cwd, '.workbuddy', 'skills', SKILL_NAME) : path.join(home, '.workbuddy', 'skills', SKILL_NAME),
  };
  const names = agent === 'all' ? Object.keys(map) : [agent];
  return names.map(name => ({ agent: name, target: map[name] }));
}

function installOne(item, update) {
  const target = path.resolve(item.target);
  const parent = path.dirname(target);
  fs.mkdirSync(parent, { recursive: true });
  if (fs.existsSync(target)) {
    if (hashDirectory(target) === hashDirectory(source)) return { ...item, status: 'up-to-date' };
    if (!update) return { ...item, status: 'exists', hint: 'rerun with --update to replace it with a timestamped backup' };
  }

  const temp = `${target}.tmp-${process.pid}`;
  fs.rmSync(temp, { recursive: true, force: true });
  fs.cpSync(source, temp, { recursive: true });
  const skill = fs.readFileSync(path.join(temp, 'SKILL.md'), 'utf8');
  if (!/^---[\s\S]*?\nname:\s*bossmate\s*$/m.test(skill)) {
    fs.rmSync(temp, { recursive: true, force: true });
    throw new Error('Bundled SKILL.md failed validation');
  }

  let backup = '';
  if (fs.existsSync(target)) {
    backup = `${target}.backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.renameSync(target, backup);
  }
  fs.renameSync(temp, target);
  return { ...item, status: backup ? 'updated' : 'installed', backup };
}

function help() {
  console.log(`
BossMate — install the AI-native BOSS job-search skill

Usage:
  npx github:yinren112/bossmate
  bossmate --agent <all|codex|claude|opencode|hermes|workbuddy>

Options:
  --agent <name>       Agent target; default is interactive
  --scope <user|project>  Install for the current user or project
  --update             Replace an existing different copy after making a backup
  --yes                Use defaults without prompts (all agents, user scope)
  --help               Show this help
`.trim());
}

async function choose() {
  if (argv.includes('--help') || argv.includes('-h')) {
    help();
    return null;
  }
  const allowedAgents = ['all', 'codex', 'claude', 'opencode', 'hermes', 'workbuddy'];
  let agent = value('agent');
  let scope = value('scope');
  const yes = argv.includes('--yes') || !process.stdin.isTTY;

  if (yes) {
    agent ||= 'all';
    scope ||= 'user';
  } else {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      if (!agent) {
        const answer = (await rl.question('Install for all agents, or one agent? [all] ')).trim();
        agent = answer || 'all';
      }
      if (!scope) {
        const answer = (await rl.question('Install for this user or current project? [user] ')).trim();
        scope = answer || 'user';
      }
    } finally {
      rl.close();
    }
  }

  if (!allowedAgents.includes(agent)) throw new Error(`Unknown agent: ${agent}`);
  if (!['user', 'project'].includes(scope)) throw new Error(`Unknown scope: ${scope}`);
  return { agent, scope, update: argv.includes('--update') };
}

async function main() {
  const options = await choose();
  if (!options) return;
  const results = targets(options.agent, options.scope, process.cwd(), os.homedir())
    .map(item => installOne(item, options.update));
  let blocked = false;
  for (const result of results) {
    const suffix = result.backup ? ` (backup: ${result.backup})` : result.hint ? ` (${result.hint})` : '';
    console.log(`${result.agent.padEnd(10)} ${result.status.padEnd(10)} ${result.target}${suffix}`);
    if (result.status === 'exists') blocked = true;
  }
  console.log('\nNext: ask your agent, "Use $bossmate to configure my resume and job preferences."');
  if (blocked) process.exitCode = 2;
}

main().catch(error => {
  console.error(`BossMate install failed: ${error.message}`);
  process.exit(1);
});
