#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseCliArgs, positionals } = require('./cli-args');
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
  assert.deepEqual(positionals(['--profile=frontend', 'fixture-job', '--brief']), ['fixture-job']);
  assert.deepEqual(parseCliArgs(['--profile', 'frontend', 'fixture-job', '--brief']), {
    options: { profile: 'frontend' }, flags: new Set(['brief']), positionals: ['fixture-job'],
  });

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
  preferences.profiles = {
    primary: {
      label: '测试目标岗位',
      titleKeywords: ['软件开发'],
      jdKeywords: ['开发', '测试', '交付'],
      factFocus: '从已确认事实中选择最相关的一项'
    }
  };
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
      fit: { status: 'pending', evidence: '' },
      remote: { status: 'pending', evidence: '' },
      pay: { status: 'pending', evidence: '' },
      risk: { status: 'pending', evidence: '' }
    },
    preScreen: { status: 'priority', profile: 'primary', score: 60, activityRank: 0, reasons: [] },
    opener: { status: 'none', message: '', profile: '', jdHash: '' },
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

  result = run('boss.js', ['doctor']);
  assert.equal(result.status, 0, result.stderr);
  const doctor = JSON.parse(result.stdout);
  assert.equal(doctor.ok, true);
  assert.equal(doctor.mode, 'offline');
  assert.equal(doctor.consumesBossBudget, false);

  result = run('boss.js', ['help', 'job-workbench']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /单个岗位完整状态/);

  result = run('boss.js', ['daily-options']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).needsChoice, true);
  result = run('boss.js', ['daily-options', '--resume=explicit']);
  assert.equal(result.status, 0, result.stderr);
  const dailyOptions = JSON.parse(result.stdout);
  assert.equal(dailyOptions.resumeMode, 'explicit');
  assert.equal(dailyOptions.automaticSendingImplemented, false);

  result = run('boss.js', ['rehash-jd']);
  assert.equal(result.status, 0, result.stderr);
  const rehashResult = JSON.parse(result.stdout);
  assert.equal(rehashResult.rehashed, 1);
  const rehashedLedger = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
  assert.notEqual(rehashedLedger.jobs[0].jd.hash, 'fixture-hash');

  // jd：离线取回审核所需的全部字段（含正文），让 agent 永远不必去读 ledger.json
  result = run('boss.js', ['jd', 'fixture-job']);
  assert.equal(result.status, 0, result.stderr);
  const jdPayload = JSON.parse(result.stdout);
  assert.equal(jdPayload.description, '负责软件开发、测试和交付，支持远程办公。');
  for (const field of ['salary', 'remoteHint', 'review', 'outreachStatus']) {
    assert(field in jdPayload, `jd 输出缺少审核所需字段 ${field}`);
  }

  result = run('boss.js', [
    'review', 'fixture-job',
    '--fit=pass', '--fit-evidence=目标软件开发方向且职责匹配已确认事实',
    '--remote=pass', '--remote-evidence=支持远程办公',
    '--pay=pass', '--pay-evidence=100-150元/时',
    '--risk=pass', '--risk-evidence=未发现用户配置的风险'
  ]);
  assert.equal(result.status, 0, result.stderr);
  const reviewedLedger = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
  assert.equal(reviewedLedger.jobs[0].review.location.status, 'pass', '旧版 --remote 命令应写入新版地点审核');
  assert.equal('remote' in reviewedLedger.jobs[0].review, false, '台账应清洗为新版地点审核字段');

  result = run('boss.js', ['job-workbench', 'fixture-job']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).next.stage, 'opener');

  result = run('boss.js', ['review-audit']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).count, 0);

  result = run('boss.js', ['opener-context', 'fixture-job']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Built and shipped one real software project/);
  const fullContextSize = result.stdout.length;

  // --brief 去掉重复的事实档案和 JD 正文，但保留写开场白必需的字段
  result = run('boss.js', ['opener-context', 'fixture-job', '--brief']);
  assert.equal(result.status, 0, result.stderr);
  assert(!/Built and shipped one real software project/.test(result.stdout), '--brief must not resend the fact profile');
  assert(!/负责软件开发、测试和交付/.test(result.stdout), '--brief must not resend the JD body');
  assert(result.stdout.length < fullContextSize, '--brief must be smaller than the full context');
  const briefContext = JSON.parse(result.stdout);
  assert.equal(briefContext.job.jobId, 'fixture-job');
  assert(briefContext.openerRules, '--brief must still carry opener rules');

  const message = '我独立交付过一个真实软件项目，想了解这个岗位目前最希望优先解决哪类开发问题？';
  result = run('boss.js', ['save-opener', 'fixture-job'], { MSG: message });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /OPENER_SAVED/);

  result = run('boss.js', ['next-work']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).next.stage, 'send');

  result = run('boss.js', ['validate']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /VALID/);

  // preflight 汇总本轮所需状态；即使浏览器不可达（CI 环境）也必须给出可解析的报告而不是崩掉
  result = run('boss.js', ['preflight']);
  const preflightReport = JSON.parse(result.stdout);
  assert(preflightReport.rate, 'preflight must report rate-limit state');
  assert(preflightReport.queue, 'preflight must report the work queue');
  assert.equal(typeof preflightReport.ledger.jobs, 'number');

  const source = fs.readFileSync(path.join(__dirname, 'boss.js'), 'utf8');
  assert(!source.includes('--force'), 'force-send option must not exist');
  assert(!source.includes('assertApprovalReady'), 'obsolete approval gate must not return');
  assert(!/codex(?:\.ps1)?/i.test(source), 'runtime must not invoke Codex');
  assert(!/C:[/\\]Users[/\\]/i.test(source), 'runtime must not contain a private Windows path');

  console.log('TEST_OK setup + browser launcher + review + opener + direct-send gates + validation');
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}
