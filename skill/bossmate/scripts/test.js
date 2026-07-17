#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bossmate-test-'));

function run(script, args = [], extraEnv = {}) {
  return spawnSync(process.execPath, [path.join(__dirname, script), ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, BOSSMATE_HOME: home, ...extraEnv },
  });
}

try {
  let result = run('setup.js', [`--home=${home}`]);
  assert.equal(result.status, 0, result.stderr);
  assert(fs.existsSync(path.join(home, 'profile.md')));
  assert(fs.existsSync(path.join(home, 'preferences.json')));
  assert(fs.existsSync(path.join(home, 'data', 'ledger.json')));

  const browserHome = path.join(home, 'browser-dry-run');
  result = run('setup-browser.js', [
    '--dry-run',
    `--home=${browserHome}`,
    `--executable=${process.execPath}`,
  ]);
  assert.equal(result.status, 0, result.stderr);
  const browserPlan = JSON.parse(result.stdout);
  assert.equal(browserPlan.dryRun, true);
  assert.equal(browserPlan.port, 9222);
  assert.equal(browserPlan.profile, path.join(browserHome, 'browser-profile'));
  assert.equal(fs.existsSync(browserHome), false, 'browser dry-run must not create files');

  const preferencesFile = path.join(home, 'preferences.json');
  const preferences = JSON.parse(fs.readFileSync(preferencesFile, 'utf8'));
  preferences.onboarding = { confirmed: true, confirmedAt: new Date().toISOString() };
  preferences.mode = 'review';
  fs.writeFileSync(preferencesFile, JSON.stringify(preferences, null, 2) + '\n');
  fs.writeFileSync(path.join(home, 'profile.md'), '# Confirmed facts\n\n- Built and shipped one real software project.\n');

  if (process.argv.includes('--live-check')) {
    result = run('boss.js', ['check']);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /"login": "ok"/);
  }

  const job = {
    jobId: 'fixture-job',
    url: 'https://www.zhipin.com/job_detail/fixture-job.html',
    title: '软件开发',
    company: '示例公司',
    salary: '100-150元/时',
    sources: ['fixture'],
    decisions: [],
    jd: {
      status: 'read',
      liveStatus: 'complete',
      hash: 'fixture-hash',
      structured: {
        title: '软件开发',
        company: '示例公司',
        salary: '100-150元/时',
        description: '负责软件开发、测试和交付，支持远程办公。',
        incomplete: false,
        recruiter: {}
      }
    },
    review: {
      remote: { status: 'pending', evidence: '' },
      pay: { status: 'pending', evidence: '' },
      risk: { status: 'pending', evidence: '' }
    },
    preScreen: { status: 'priority', profile: 'primary', score: 60, activityRank: 0, reasons: [] },
    opener: { status: 'none', message: '', profile: '', jdHash: '' },
    approval: { status: 'not_required', approvedAt: '' },
    outreach: { status: 'not_sent', message: '', verify: null },
    reply: { status: 'unknown' }
  };
  const ledgerFile = path.join(home, 'data', 'ledger.json');
  const ledger = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
  ledger.jobs.push(job);
  fs.writeFileSync(ledgerFile, JSON.stringify(ledger, null, 2) + '\n');

  result = run('boss.js', ['self-test']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /SELF_TEST_OK/);

  result = run('boss.js', [
    'review', 'fixture-job',
    '--remote=pass', '--remote-evidence=支持远程办公',
    '--pay=pass', '--pay-evidence=100-150元/时',
    '--risk=pass', '--risk-evidence=未发现用户配置的风险'
  ]);
  assert.equal(result.status, 0, result.stderr);

  result = run('boss.js', ['opener-context', 'fixture-job']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Built and shipped one real software project/);

  const message = '我独立交付过一个真实软件项目，想了解这个岗位目前最希望优先解决哪类开发问题？';
  result = run('boss.js', ['save-opener', 'fixture-job'], { MSG: message });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /OPENER_SAVED/);

  result = run('boss.js', ['send', 'fixture-job']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /尚未批准/);

  result = run('boss.js', ['approve', 'fixture-job']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /APPROVED/);

  result = run('boss.js', ['validate']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /VALID/);

  const source = fs.readFileSync(path.join(__dirname, 'boss.js'), 'utf8');
  assert(!source.includes('--force'), 'force-send option must not exist');
  assert(!/codex(?:\.ps1)?/i.test(source), 'runtime must not invoke Codex');
  assert(!/C:[/\\]Users[/\\]/i.test(source), 'runtime must not contain a private Windows path');

  console.log('TEST_OK setup + browser launcher + review + opener + approval gate + validation');
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}
