const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const bin = path.join(root, 'bin', 'bossmate.js');
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'bossmate-install-'));
const home = path.join(sandbox, 'home');
const project = path.join(sandbox, 'project');
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(project, { recursive: true });

function run(args, cwd = project) {
  return spawnSync(process.execPath, [bin, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home },
  });
}

try {
  let result = run(['--agent', 'all', '--scope', 'user', '--yes']);
  assert.equal(result.status, 0, result.stderr);
  const targets = [
    path.join(home, '.agents', 'skills', 'bossmate', 'SKILL.md'),
    path.join(home, '.claude', 'skills', 'bossmate', 'SKILL.md'),
    path.join(home, '.config', 'opencode', 'skills', 'bossmate', 'SKILL.md'),
    path.join(home, '.hermes', 'skills', 'job-search', 'bossmate', 'SKILL.md'),
    path.join(home, '.workbuddy', 'skills', 'bossmate', 'SKILL.md'),
  ];
  targets.forEach(file => assert(fs.existsSync(file), file));
  assert(fs.existsSync(path.join(path.dirname(targets[0]), 'scripts', 'setup-browser.js')));
  assert(!fs.existsSync(path.join(path.dirname(targets[0]), 'scripts', 'setup-browser.ps1')));

  result = run(['--agent', 'all', '--scope', 'user', '--yes']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /up-to-date/);

  const codexSkill = targets[0];
  fs.appendFileSync(codexSkill, '\nlocal edit\n');
  result = run(['--agent', 'codex', '--scope', 'user', '--update', '--yes']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /updated/);
  assert(!fs.readFileSync(codexSkill, 'utf8').includes('local edit'));
  const backups = fs.readdirSync(path.dirname(path.dirname(codexSkill)))
    .filter(name => name.startsWith('bossmate.backup-'));
  assert.equal(backups.length, 1);

  result = run(['--agent', 'claude', '--scope', 'project', '--yes']);
  assert.equal(result.status, 0, result.stderr);
  assert(fs.existsSync(path.join(project, '.claude', 'skills', 'bossmate', 'SKILL.md')));

  result = run(['--help']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /npx github:yinren112\/bossmate/);

  const setup = spawnSync(process.execPath, [path.join(root, 'skill', 'bossmate', 'scripts', 'setup.js'), '--help'], {
    cwd: project,
    env: { ...process.env, HOME: home, USERPROFILE: home },
    encoding: 'utf8',
  });
  assert.equal(setup.status, 0, setup.stderr);
  assert.match(setup.stdout, /without creating files/);
  assert.equal(fs.existsSync(path.join(home, '.bossmate')), false, 'setup --help must not create a workspace');

  console.log('INSTALL_TEST_OK all agents + idempotency + backup update + project scope');
} finally {
  fs.rmSync(sandbox, { recursive: true, force: true });
}
