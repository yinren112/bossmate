const { arg, positional, hasFlag, jobIdOf } = require('./cli-args');
const { PROFILES, REVIEW_FIELDS, now } = require('./runtime-config');
const { loadLedger, saveLedger } = require('./ledger-store');
const { addDecision, matchProfile, normalizeJob } = require('./job-domain');
const { jdHashOf, hydrateLegacyStructured } = require('./jd-domain');
const { validateOpener, assertAgentReady, openerContext } = require('./opener-service');
const { loadDailyOptions, saveDailyOptions } = require('./daily-options');
const { jobWorkbenchPayload, nextWorkPayload, reviewAuditPayload } = require('./workbench');
const {
  RATE_LIMITS, WINDOW_24H, WINDOW_10MIN, loadBudget, budgetCountWithin,
  loadLock, isNightHour, paceMultiplier,
} = require('./safety');

function rehashJd() {
  const ledger = loadLedger();
  const result = { scanned: 0, rehashed: 0, openerRebound: 0, skippedNoStructured: 0 };
  for (const job of ledger.jobs) {
    result.scanned++;
    const structured = job.jd?.structured;
    if (!structured?.description) { result.skippedNoStructured++; continue; }
    const previous = job.jd.hash;
    const next = jdHashOf(structured);
    if (previous === next) continue;
    if (job.opener?.jdHash && job.opener.jdHash === previous) {
      job.opener.jdHash = next;
      result.openerRebound++;
    }
    job.jd.hash = next;
    result.rehashed++;
  }
  saveLedger(ledger);
  console.log(JSON.stringify(result, null, 2));
}

function profiles() {
  for (const [id, profile] of Object.entries(PROFILES)) console.log(`${id}\t${profile.label}\t${profile.titleKeywords.join('、')}`);
}

function rateUsage() {
  const budget = loadBudget();
  return Object.fromEntries(Object.keys(RATE_LIMITS).map(kind => {
    const in24h = budgetCountWithin(budget, kind, WINDOW_24H);
    return [kind, {
      in24h,
      in10min: budgetCountWithin(budget, kind, WINDOW_10MIN),
      remainingUntilSoftLimit: Math.max(0, RATE_LIMITS[kind].softLimit24h - in24h),
    }];
  }));
}

function rateStatus() {
  const budget = loadBudget();
  console.log(JSON.stringify({
    lock: loadLock(), night: isNightHour(), paceMultiplier: paceMultiplier(),
    consecutiveEmptyJd: budget.consecutiveEmptyJd || 0,
    used: rateUsage(), limits: RATE_LIMITS,
  }, null, 2));
}

function dailyOptions() {
  const mode = arg('resume');
  const state = mode ? saveDailyOptions(mode) : loadDailyOptions();
  console.log(JSON.stringify({
    ...state,
    prompt: state.needsChoice ? '请询问用户：今天收到积极回复或明确索要后，简历策略选关闭(off)、仅明确索要(explicit)，还是积极回复也允许(positive)？' : '',
    note: '当前公开版只记录每日策略并提供多简历配置，不会自动发送附件。',
  }, null, 2));
}

function jobWorkbench() {
  const ledger = loadLedger();
  const id = positional();
  const job = ledger.jobs.find(item => item.jobId === id);
  if (!job) throw new Error(`未找到岗位 ${id}`);
  console.log(JSON.stringify(jobWorkbenchPayload(ledger, job, { full: hasFlag('full') }), null, 2));
}

const nextWork = () => console.log(JSON.stringify(nextWorkPayload(loadLedger()), null, 2));

function reviewAudit() {
  const limit = Math.min(100, Math.max(1, Number(arg('limit') || 20)));
  console.log(JSON.stringify(reviewAuditPayload(loadLedger(), limit), null, 2));
}

function showOpenerContext() {
  const input = positional() || arg('url');
  const id = jobIdOf(input) || input;
  const ledger = loadLedger();
  const index = ledger.jobs.findIndex(job => job.jobId === id);
  const job = index >= 0 ? hydrateLegacyStructured(ledger.jobs[index]) : null;
  if (!job) throw new Error(`台账中没有岗位 ${id}`);
  ledger.jobs[index] = job;
  assertAgentReady(ledger, job);
  console.log(JSON.stringify(openerContext(job, arg('profile'), hasFlag('brief')), null, 2));
}

function saveOpener() {
  const input = positional() || arg('url');
  const id = jobIdOf(input) || input;
  const ledger = loadLedger();
  const index = ledger.jobs.findIndex(job => job.jobId === id);
  const job = index >= 0 ? hydrateLegacyStructured(ledger.jobs[index]) : null;
  if (!job) throw new Error(`台账中没有岗位 ${id}`);
  ledger.jobs[index] = job;
  assertAgentReady(ledger, job);
  const message = validateOpener(process.env.MSG || arg('message'));
  const profileId = matchProfile(job.title, job.jd.structured.description, arg('profile') || job.preScreen?.profile);
  job.opener = { status: 'generated', message, profile: profileId, jdHash: job.jd.hash, generatedAt: now(), generator: 'host-agent' };
  addDecision(job, 'opener', 'pass', 'agent_generated', `当前 Agent 已按${PROFILES[profileId]?.label || '用户方向'}生成并通过事实门禁`, message);
  saveLedger(ledger);
  console.log(`OPENER_SAVED ${id} ${message}`);
}

function discardOpener() {
  const id = jobIdOf(positional() || arg('url')) || positional() || arg('url');
  const ledger = loadLedger();
  const job = ledger.jobs.find(item => item.jobId === id);
  if (!job) throw new Error(`台账中没有岗位 ${id}`);
  job.opener = { status: 'none', message: '', profile: '', jdHash: '', discardedAt: now() };
  addDecision(job, 'opener', 'pending', 'discarded', '已丢弃当前开场白，需按最新 JD 重新生成', '');
  saveLedger(ledger);
  console.log(`OPENER_DISCARDED ${id}`);
}

function review() {
  const id = positional();
  const ledger = loadLedger();
  const index = ledger.jobs.findIndex(job => job.jobId === id);
  if (index < 0) throw new Error(`台账中没有岗位 ${id}`);
  const job = normalizeJob(ledger.jobs[index]);
  ledger.jobs[index] = job;
  for (const field of REVIEW_FIELDS) {
    const status = arg(field) || (field === 'location' ? arg('remote') : '');
    if (!status) continue;
    if (!['pending', 'pass', 'fail'].includes(status)) throw new Error(`${field} 只能是 pending/pass/fail`);
    const evidence = arg(`${field}-evidence`) || (field === 'location' ? arg('remote-evidence') : '') || job.review[field]?.evidence || '';
    if (status !== 'pending' && !String(evidence).trim()) throw new Error(`${field} 为 ${status} 时必须提供证据`);
    job.review[field] = { status, evidence };
    addDecision(job, `jd_${field}`, status === 'fail' ? 'reject' : status, `${field}_review`, `${field} 审核为 ${status}`, evidence);
  }
  if (arg('next')) job.nextAction = arg('next');
  saveLedger(ledger);
  console.log(`${id}: ${REVIEW_FIELDS.map(field => `${field}=${job.review[field].status}`).join(', ')}`);
}

function company() {
  const name = positional();
  if (!name) throw new Error('缺少公司名');
  const ledger = loadLedger();
  const existing = ledger.companies.find(item => item.name === name) || { name };
  Object.assign(existing, { status: arg('status') || existing.status || 'pending', evidence: arg('evidence') || existing.evidence || '', url: arg('url') || existing.url || '', checkedAt: now() });
  if (!ledger.companies.includes(existing)) ledger.companies.push(existing);
  saveLedger(ledger);
  console.log(`${name}: ${existing.status}`);
}

module.exports = {
  rehashJd, profiles, rateUsage, rateStatus, dailyOptions, jobWorkbench, nextWork,
  reviewAudit, showOpenerContext, saveOpener, discardOpener, review, company,
};
