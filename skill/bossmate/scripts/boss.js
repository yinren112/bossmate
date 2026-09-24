#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  ROOT, DATA_DIR, LEDGER_FILE, FACTS_FILE, PREFERENCES_FILE,
  PREFERENCES, PROFILES, PORT, CITY_CODE, MIN_HOURLY_PAY, REVIEW_FIELDS,
  now, rel,
} = require('./runtime-config');
const { arg, positional, hasFlag, jobIdOf, isRealJobUrl } = require('./cli-args');
const { loadLedger, saveLedger } = require('./ledger-store');
const {
  blankJob, normalizeJob, addDecision, activityRank, includesKeyword, matchProfile,
  parseSearchCard, preScreenJob, recruiterFromButton, conversationKey,
  priorContactReason, ensureJob, assessRemote,
} = require('./job-domain');
const {
  parseJobBody, jdHashOf, normalizeStructuredPage,
  assertReadableDescription, hydrateLegacyStructured,
} = require('./jd-domain');
const {
  validateOpener, assertSendReady, assertAgentReady, reviewPayload, showJd,
  detectSendBlock, buildOpenerContext, openerContext,
} = require('./opener-service');
const { verifyFrom, buildDeliveryVerifyExpr, sentVerification } = require('./delivery-verification');
const { conversationStatus, resumeTrigger } = require('./conversation-domain');
const { loadDailyOptions } = require('./daily-options');
const { HELP, help } = require('./command-help');
const {
  rehashJd, profiles, rateUsage, rateStatus, dailyOptions, jobWorkbench, nextWork,
  reviewAudit, showOpenerContext, saveOpener, discardOpener, review, company,
} = require('./offline-commands');
const {
  search, searchNext, searchClose, favorites, favoritesNext, favoriteStatus, favoriteQueue, recommendations,
  recommendationsNext, recommendationsClose, jobSources,
} = require('./discovery-sources');
const { migrateJd, importLegacy, validate } = require('./maintenance');
const { isClosedJobText, unreadableJobMessage, isExpiredJobRedirect, jobPageExpression } = require('./page-flows');
const {
  LOCK_FILE, BUDGET_FILE, SECURITY_JS_EXPR, ONLINE_COMMANDS, RATE_LIMITS,
  WINDOW_24H, WINDOW_10MIN, NIGHT_PACE, rndInt, humanPause, isNightHour,
  paceMultiplier, matchSecurityPage, loadLock, writeLock, assertNotLocked, throwSecurity,
  unlockRefusal, unlock, loadBudget, saveBudget, budgetCountWithin, reserveAction,
  noteEmptyJd, resetEmptyJd,
} = require('./safety');
const cdpLib = () => require('./cdp');


function assertConfigured() {
  if (!fs.existsSync(PREFERENCES_FILE) || !fs.existsSync(FACTS_FILE)) {
    throw new Error(`尚未初始化私有工作区。先运行 node scripts/setup.js --home="${ROOT}"`);
  }
  if (PREFERENCES.onboarding?.confirmed !== true) {
    throw new Error('用户尚未确认简历事实和求职意向，禁止在线运行');
  }
  const facts = fs.readFileSync(FACTS_FILE, 'utf8');
  if (/状态：待用户确认|由 Agent 从用户简历/.test(facts)) {
    throw new Error('profile.md 仍是未确认模板，禁止在线运行');
  }
  if (!Object.keys(PROFILES).length) throw new Error('preferences.json 至少需要一个岗位方向');
}


async function check() {
  const tabs = await fetch(`http://127.0.0.1:${PORT}/json`).then(r => r.json());
  const boss = tabs.filter(x => x.type === 'page' && /zhipin\.com/.test(x.url || ''));
  const security = boss.filter(x => matchSecurityPage(`${x.url} ${x.title}`));
  console.log(JSON.stringify({ port: PORT, bossTabs: boss.length, securityPages: security.length, urls: boss.map(x => x.url) }, null, 2));
  if (security.length) {
    writeLock('check 发现安全/异常页面', security.map(x => `${x.url} ${x.title}`).join(' ; '));
    console.log(`已写入熔断锁 ${rel(LOCK_FILE)}：所有在线命令拒绝运行，人工确认后 unlock`);
  }
  if (!boss.length || security.length) process.exitCode = 2;
}

async function replies() {
  const { openTab, closeTab } = cdpLib();
  const cdp = await openTab('https://www.zhipin.com/web/geek/chat', PORT);
  try {
    await humanPause(3000, 6500);
    const raw = await cdp.eval(`(()=>{
      let vm=document.querySelector('.friend-content-warp')?.__vue__;
      while(vm&&vm.$options?.name!=='virtual-list')vm=vm.$parent;
      const sources=vm?.$props?.dataSources||vm?.dataSources||[];
      return JSON.stringify(sources.map(s=>({
        name:s.name||'',company:s.brandName||'',time:s.lastTS||0,lastMessage:s.lastText||'',
        statusClass:s.lastIsSelf?(Number(s.lastMsgStatus)===2?'message-status status-read':'message-status status-delivery'):'',
        statusText:s.lastIsSelf?(Number(s.lastMsgStatus)===2?'[已读]':'[送达]'):'',
        unread:String(s.unreadCount||''),encryptBossId:s.encryptBossId||'',encryptJobId:s.encryptJobId||'',
        friendId:String(s.friendId||''),uid:String(s.uid||''),lastMsgId:String(s.lastMsgId||'')
      })));
    })()`);
    const rows = JSON.parse(raw || '[]').map(item => {
      return { ...item, status: conversationStatus(item), checkedAt: now() };
    });
    const ledger = loadLedger();
    const keyed = new Map(ledger.conversations.map(x => [conversationKey(x), x]));
    for (const row of rows) {
      const key = conversationKey(row);
      const legacyKey = `name:${row.company || ''}@@${row.name || ''}`;
      const previous = keyed.get(key) || keyed.get(legacyKey);
      if (key !== legacyKey) keyed.delete(legacyKey);
      keyed.set(key, { ...previous, ...row });
    }
    ledger.conversations = [...keyed.values()];
    saveLedger(ledger);
    const pending = rows.filter(x => x.status === 'needs_reply');
    const review = rows.filter(x => x.status === 'boss_last_review');
    console.log(`会话 ${rows.length}；待回复 ${pending.length}；待判断 ${review.length}`);
    pending.forEach(x => console.log(`- ${x.company} ${x.name}: ${x.lastMessage}`));
    review.forEach(x => console.log(`- [待判断] ${x.company} ${x.name}: ${x.lastMessage}`));
  } finally {
    cdp.close();
    await closeTab(cdp.tabId, PORT);
  }
}

async function interactions() {
  const { openTab, closeTab } = cdpLib();
  const cdp = await openTab('https://www.zhipin.com/web/geek/recommend', PORT);
  const snapshots = [];
  try {
    await humanPause(3000, 6500);
    for (const label of ['谁看过我', '对我感兴趣的']) {
      await cdp.eval(`(()=>{const label=${JSON.stringify(label)};const el=[...document.querySelectorAll('span,a,li')].find(x=>(x.innerText||'').trim()===label&&x.offsetParent);if(!el)return false;el.click();return true})()`);
      await humanPause(1200, 2800);
      const raw = await cdp.eval(`JSON.stringify({text:document.body.innerText.replace(/\\s+/g,' ').slice(0,5000),links:[...document.querySelectorAll('a[href*="/job_detail/"]')].filter(a=>!a.href.includes('personal_added_job')).map(a=>({url:a.href,text:(a.innerText||'').trim()})).slice(0,30)})`);
      snapshots.push({ type: label, capturedAt: now(), ...JSON.parse(raw || '{}') });
    }
    const ledger = loadLedger();
    ledger.interactions = snapshots;
    for (const job of ledger.jobs) job.sources = (job.sources || []).filter(source => !source.startsWith('interaction:'));
    for (const snapshot of snapshots) {
      for (const link of snapshot.links || []) {
        const id = jobIdOf(link.url);
        if (!id) continue;
        const job = ensureJob(ledger, id, link.url);
        if (!job.title) job.title = link.text;
        job.sources = [...new Set([...(job.sources || []), `interaction:${snapshot.type}`])];
      }
    }
    saveLedger(ledger);
    snapshots.forEach(x => console.log(`${x.type}: ${x.links?.length || 0} 个可定位岗位链接`));
  } finally {
    cdp.close();
    await closeTab(cdp.tabId, PORT);
  }
}

async function profile() {
  const { openTab, closeTab } = cdpLib();
  const cdp = await openTab('https://www.zhipin.com/web/geek/resume', PORT);
  try {
    await humanPause(3000, 6500);
    const raw = await cdp.eval(`JSON.stringify({url:location.href,security:${SECURITY_JS_EXPR},expectations:document.querySelector('#purpose')?.innerText.replace(/\\s+/g,' ').trim()||'',advantage:document.querySelector('#summary .advantage-text')?.innerText.trim()||'',attachments:[...document.querySelectorAll('a')].filter(a=>/\\.pdf$/i.test((a.innerText||'').trim())).map(a=>(a.innerText||'').trim())})`);
    const snapshot = { ...JSON.parse(raw || '{}'), checkedAt: now() };
    const ledger = loadLedger();
    ledger.profile = snapshot;
    saveLedger(ledger);
    console.log(JSON.stringify(snapshot, null, 2));
  } finally {
    cdp.close();
    await closeTab(cdp.tabId, PORT);
  }
}

async function readJob() {
const input = positional() || arg('url');
  const id = jobIdOf(input) || (/^[\w-]+$/.test(input || '') ? input : '');
  const ledger = loadLedger();
  const existing = id ? ledger.jobs.find(x => x.jobId === id) : null;
  const url = jobIdOf(input) ? input : existing?.url;
  if (!id) throw new Error('需要有效的 BOSS 岗位详情链接');
  if (!url) throw new Error(`台账中没有岗位 ${id} 的详情链接`);
  await reserveAction('jobReads', id);
  const { openTab, closeTab } = cdpLib();
  const cdp = await openTab(url, PORT);
  try {
    let page = {};
    const deadline = Date.now() + 12000;
    do {
      const raw = await cdp.eval(jobPageExpression());
      page = JSON.parse(raw || '{}');
      if (page.security || (jobIdOf(page.url) === id && String(page.structured?.description || '').trim())) break;
      await humanPause(600, 1200);
    } while (Date.now() < deadline);
    if (page.security) throwSecurity('岗位页进入安全验证', `${id} -> ${page.url || ''}`);
    if (jobIdOf(page.url) !== id) {
      if (!isExpiredJobRedirect(page.url)) throwSecurity('岗位页发生异常跳转', `${id} -> ${page.url || ''}`);
      const ledger = loadLedger();
      const job = ensureJob(ledger, id, url);
      job.jd = { ...(job.jd || {}), status: 'expired', checkedAt: now() };
      job.nextAction = '岗位已失效（详情页跳回首页/列表）';
      job.preScreen = { ...(job.preScreen || {}), status: 'reject', reason: job.nextAction };
      addDecision(job, 'jd_read', 'reject', 'job_expired', job.nextAction, page.url || '');
      saveLedger(ledger);
      console.log(`EXPIRED ${id} 岗位详情页跳回 ${page.url}，已标记失效，未写熔断锁`);
      return;
    }
    if (!String(page.structured?.description || '').trim()) {
      noteEmptyJd(unreadableJobMessage(page));
      throw new Error(unreadableJobMessage(page));
    }
    resetEmptyJd();
    const parsed = normalizeStructuredPage(page);
    const ledger = loadLedger();
    const job = ensureJob(ledger, id, url);
    job.title = parsed.structured.title || job.title;
    job.company = parsed.structured.company || job.company;
    job.salary = parsed.structured.salary || job.salary;
    const recruiter = recruiterFromButton(page.button, parsed.structured.recruiter.name, job.company);
    job.recruiter = { ...recruiter, title: parsed.structured.recruiter.title, activeText: parsed.structured.recruiter.activeText, activityRank: parsed.structured.recruiter.activityRank };
    if (parsed.structured.incomplete) {
      if (job.jd?.status !== 'read') {
        job.jd = { status: 'partial', liveStatus: 'partial', evidencePath: '', remoteHint: parsed.remoteEvidence, hash: parsed.hash, structured: parsed.structured, checkedAt: now() };
      } else {
        job.jd.liveStatus = 'partial';
        job.jd.liveCheckedAt = now();
      }
      addDecision(job, 'jd_read', 'reject', 'incomplete_jd', '职位正文被登录提示截断，不能审核或发送', '登录查看完整内容');
    } else {
      job.jd = { status: 'read', liveStatus: 'complete', evidencePath: '', remoteHint: parsed.remoteEvidence, hash: parsed.hash, structured: parsed.structured, checkedAt: now() };
      addDecision(job, 'jd_read', 'pass', 'complete_jd', '已读取完整结构化 JD', `${parsed.structured.description.length} 字`);
      if (!job.preScreen?.profile) preScreenJob(ledger, job, { title: job.title, text: `${job.title}\n${job.salary}` });
    }
    job.sources = [...new Set([...(job.sources || []), arg('source') || 'manual'])];
    saveLedger(ledger);
    // --jd returns all fields needed for review (including the JD body) in one go,
    // skipping a second round trip. Reviewing a job requires reading the body anyway,
    // so splitting it into two calls just costs an extra tool call.
if (hasFlag('jd')) {
      console.log(JSON.stringify(reviewPayload(job), null, 2));
    } else {
      console.log(JSON.stringify({
        status: job.jd.status, jobId: id, title: job.title, company: job.company, salary: job.salary,
        remoteHint: job.jd.remoteHint, descriptionChars: job.jd.structured?.description?.length || 0,
        recruiterActive: job.recruiter.activeText || '', activityRank: job.recruiter.activityRank || 0,
      }, null, 2));
    }
  } finally {
    cdp.close();
    await closeTab(cdp.tabId, PORT);
  }
}

async function companyJobs() {
const name = positional() || '';
  const ledger = loadLedger();
  const company = ledger.companies.find(x => x.name === name);
  if (!company?.url) throw new Error(`公司池中没有 ${name} 或缺少入口链接`);
  const { openTab, closeTab } = cdpLib();
  const cdp = await openTab(company.url, PORT);
  try {
    await humanPause(3500, 7000);
    let allJobsUrl = await cdp.eval(`(()=>{const a=[...document.querySelectorAll('a')].find(x=>/查看(全部|所有)职位/.test((x.innerText||'').trim()));return a?.href||''})()`);
    if (allJobsUrl) { await cdp.navigate(allJobsUrl); await humanPause(3000, 6500); }
    const raw = await cdp.eval(`JSON.stringify({url:location.href,security:${SECURITY_JS_EXPR},links:[...document.querySelectorAll('a[href*="/job_detail/"]')].map(a=>({url:a.href,text:(a.innerText||'').trim()})).filter(x=>x.text)})`);
    const page = JSON.parse(raw || '{}');
    if (page.security) throwSecurity('公司职位页进入安全验证', name);
    const unique = new Map((page.links || []).map(x => [jobIdOf(x.url), x]).filter(([id]) => id));
    for (const job of ledger.jobs) job.sources = (job.sources || []).filter(source => source !== `company:${name}`);
    for (const [id, link] of unique) {
      const job = ensureJob(ledger, id, link.url);
      if (!job.title) job.title = link.text;
      job.sources = [...new Set([...(job.sources || []), `company:${name}`])];
    }
    company.jobsUrl = page.url;
    company.checkedAt = now();
    saveLedger(ledger);
    console.log(`${name}: 收录 ${unique.size} 个公司职位`);
  } finally {
    cdp.close();
    await closeTab(cdp.tabId, PORT);
  }
}

function list() {
  const ledger = loadLedger();
  const ready = ledger.jobs.filter(x =>
    REVIEW_FIELDS.every(k => x.review?.[k]?.status === 'pass') &&
    x.outreach?.status === 'not_sent' &&
    !priorContactReason(ledger, x)
  );
  const replies = ledger.conversations.filter(x => x.status === 'needs_reply');
  const review = ledger.conversations.filter(x => x.status === 'boss_last_review');
  const pre = Object.fromEntries(['priority', 'review', 'reject'].map(status => [status, ledger.jobs.filter(x => x.preScreen?.status === status).length]));
  console.log(`岗位 ${ledger.jobs.length}｜完整JD ${ledger.jobs.filter(x => x.jd?.status === 'read').length}｜预筛优先 ${pre.priority}｜预筛待看 ${pre.review}｜预筛淘汰 ${pre.reject}｜可发送 ${ready.length}｜待回复 ${replies.length}｜待判断 ${review.length}｜已关注公司 ${ledger.companies.filter(x => x.status === 'pass').length}`);
  const limit = Math.min(100, Number(arg('limit') || 20));
  const grep = arg('grep');
  const queue = arg('queue') || 'ready';
  const awaiting = ledger.jobs.filter(x =>
    x.jd?.status === 'read' &&
    x.outreach?.status === 'not_sent' &&
    REVIEW_FIELDS.some(k => (x.review?.[k]?.status || 'pending') === 'pending') &&
    !REVIEW_FIELDS.some(k => x.review?.[k]?.status === 'fail') &&
    !priorContactReason(ledger, x)
  );
  let rows = queue === 'review' ? awaiting : ready;
  const tag = queue === 'review' ? '待审' : '可发送';
  const remoteRe = /[^。；;\n]{0,20}(远程办公|远程工作|居家办公|在家办公|可远程|纯远程|全职远程|线上办公|不坐班|不用通勤|支持远程)[^。；;\n]{0,20}/;
  const remoteHits = new Map();
if (hasFlag('has-remote')) {
    rows = rows.filter(job => {
      const match = `${job.title || ''} ${job.jd?.structured?.description || ''}`.match(remoteRe);
      if (match) remoteHits.set(job.jobId, match[0].trim());
      return !!match;
    });
  }
  if (grep) rows = rows.filter(job => new RegExp(grep, 'i').test(`${job.title} ${job.company}`));
  const source = arg('source');
  if (source) rows = rows.filter(job => (job.sources || []).some(value => value.includes(source)));
  console.log(`筛后 ${rows.length}`);
  rows.slice(0, limit).forEach(job => console.log(`- [${tag}] ${job.jobId} ${job.salary || '薪资未知'} ${job.title} @ ${job.company}${job.opener?.message ? ' [有开场白]' : ''}${remoteHits.has(job.jobId) ? ` ｜远程原句：${remoteHits.get(job.jobId)}` : ''}`));
}

// Merges the startup checks into one command. Previously this meant running
// self-test/validate/check/replies/interactions/list/rate-status separately -
// seven calls with seven sets of boilerplate output that mostly repeat each other.
// This only prints what's actually needed to decide the next move: can it run,
// where things stand, and what's waiting.
async function preflight() {
  const ledger = loadLedger();
  const lock = loadLock();
  const daily = loadDailyOptions();
  const blocked = lock.locked ? `锁定中：${lock.reason}（${lock.lockedAt}）` : '';

  let browser = { ok: false, bossTabs: 0, securityPages: 0 };
  if (!blocked) {
    try {
      const tabs = await fetch(`http://127.0.0.1:${PORT}/json`).then(r => r.json());
      const boss = tabs.filter(x => x.type === 'page' && /zhipin\.com/.test(x.url || ''));
      const security = boss.filter(x => matchSecurityPage(`${x.url} ${x.title}`));
      browser = { ok: boss.length > 0 && security.length === 0, bossTabs: boss.length, securityPages: security.length };
      if (security.length) {
        writeLock('preflight 发现安全/异常页面', security.map(x => `${x.url} ${x.title}`).join(' ; '));
        browser.note = '已写入熔断锁，所有在线命令拒绝运行';
      }
    } catch (error) {
      browser.note = `CDP 端口 ${PORT} 不可达：${error.message}`;
    }
  }

  const ready = ledger.jobs.filter(x =>
    REVIEW_FIELDS.every(k => x.review?.[k]?.status === 'pass') &&
    x.outreach?.status === 'not_sent' &&
    !priorContactReason(ledger, x)
  );
  const needsReadReview = ledger.jobs.filter(x =>
    x.jd?.status === 'read' && x.outreach?.status === 'not_sent' &&
    !REVIEW_FIELDS.every(k => x.review?.[k]?.status === 'pass') &&
    !REVIEW_FIELDS.some(k => x.review?.[k]?.status === 'fail')
  );

  console.log(JSON.stringify({
    blocked: blocked || undefined,
    readiness: {
      jobWorkflow: !blocked && browser.ok ? 'ready' : 'blocked',
      autoResume: daily.needsChoice ? 'choice_required_non_blocking' : 'policy_recorded_not_implemented',
    },
    dailyOptions: daily,
    browser,
    rate: { night: isNightHour(), paceMultiplier: paceMultiplier(), used: rateUsage() },
    consecutiveEmptyJd: loadBudget().consecutiveEmptyJd || 0,
    ledger: {
      jobs: ledger.jobs.length,
      completeJd: ledger.jobs.filter(x => x.jd?.status === 'read').length,
      delivered: ledger.jobs.filter(x => x.outreach?.status === 'delivered').length,
      deliveryUnverified: ledger.jobs.filter(x => x.outreach?.status === 'delivery_unverified').map(x => x.jobId),
    },
    queue: {
      readyToSend: ready.length,
      readyToSendIds: ready.slice(0, 20).map(x => x.jobId),
      awaitingReview: needsReadReview.length,
      awaitingReviewIds: needsReadReview.slice(0, 20).map(x => x.jobId),
    },
    conversations: {
      needsReply: ledger.conversations.filter(x => x.status === 'needs_reply').length,
      needsJudgement: ledger.conversations.filter(x => x.status === 'boss_last_review').length,
    },
  }, null, 2));
  if (blocked || !browser.ok) process.exitCode = 2;
}

function candidates() {
  const ledger = loadLedger();
  const limit = Math.min(100, Number(arg('limit') || 30));
  const profile = arg('profile');
  if (profile && !PROFILES[profile]) throw new Error(`未知岗位方向 ${profile}`);
  const rows = ledger.jobs
    .filter(job => ['priority', 'review'].includes(job.preScreen?.status) && (!profile || job.preScreen.profile === profile))
    .filter(job => !['read', 'partial'].includes(job.jd?.status) && !priorContactReason(ledger, job))
    .sort((a, b) => (b.preScreen.score - a.preScreen.score) || (b.preScreen.activityRank - a.preScreen.activityRank))
    .slice(0, limit);
  console.log(`待读完整 JD 候选 ${rows.length}`);
  rows.forEach(job => console.log(`- ${job.jobId} [${job.preScreen.profile || '待归类'} ${job.preScreen.score}] ${job.title} ${job.salary || ''}｜${job.preScreen.reasons.map(x => x.message).join('；')}`));
}

async function sendMessage(url, message) {
  const id = jobIdOf(url);
  if (!id || !message) throw new Error('需要岗位链接和 MSG/--message');
  message = validateOpener(message);
  const ledger = loadLedger();
  const index = ledger.jobs.findIndex(x => x.jobId === id);
  const job = index >= 0 ? hydrateLegacyStructured(ledger.jobs[index]) : null;
  if (!job) throw new Error('岗位未进入台账，请先 read');
  ledger.jobs[index] = job;
  assertSendReady(job);

  const staticReason = priorContactReason(ledger, job);
  if (staticReason) {
    job.outreach = { status: 'skipped_communicated', message, evidencePath: '', verify: null, target: { title: job.title, company: job.company }, sentAt: now() };
    job.nextAction = staticReason;
    addDecision(job, 'dedup', 'reject', 'prior_contact', staticReason, job.recruiter?.encryptBossId || '');
    saveLedger(ledger);
    console.log(`STATIC_SKIPPED (${staticReason}) ${id} ${job.title} @ ${job.company}`);
    return;
  }

  // A static dedup hit doesn't go online or count against the rate limit; only an actual send counts toward sends
  await reserveAction('sends', `${id} ${job.title}`, BUDGET_FILE, ['jobReads']);
  const { openTab, closeTab } = cdpLib();
  const cdp = await openTab(url, PORT);
  try {
    await humanPause(5000, 10000);
    const preflight = JSON.parse(await cdp.eval(jobPageExpression()) || '{}');
    if (preflight.security) throwSecurity('发送前岗位页进入安全验证', `${id} ${job.url}`);
    if (isClosedJobText(preflight.bodyText)) {
      job.outreach = { status: 'skipped_closed', message, evidencePath: '', verify: null, target: { title: job.title, company: job.company }, sentAt: now() };
      job.nextAction = '职位已关闭';
      addDecision(job, 'send_gate', 'reject', 'closed', job.nextAction, '职位已关闭');
      saveLedger(ledger);
      console.log(`SKIPPED_CLOSED ${id} ${job.title} @ ${job.company}`);
      return;
    }
    if (jobIdOf(preflight.url) !== id || !preflight.button?.text) throw new Error('发送前岗位页或沟通按钮核验失败');
    // Reloading the detail page before sending still counts as a page view on BOSS's side;
    // recording only sends and not this view would undercount jobReads' 24-hour total.
    job.jd.liveCheckedAt = now();
    const actual = normalizeStructuredPage(preflight);
    if (actual.structured.incomplete) throw new Error('发送前 JD 变为不完整，已停止');
    if (job.jd.hash && actual.hash !== job.jd.hash) throw new Error('JD 自上次审核后已变化，请重新 read 和 review');
    const liveRecruiter = recruiterFromButton(preflight.button, actual.structured.recruiter.name, actual.structured.company);
    job.recruiter = liveRecruiter;
    if (job.title && actual.structured.title && job.title !== actual.structured.title) throw new Error(`岗位标题不一致：${job.title} / ${actual.structured.title}`);
    if (job.company && actual.structured.company && job.company !== actual.structured.company) throw new Error(`公司不一致：${job.company} / ${actual.structured.company}`);
    const liveReason = priorContactReason(ledger, job, liveRecruiter);
    if (liveReason || preflight.button.text.includes('继续') || preflight.button.text.includes('聊过') || preflight.button.text.includes('已沟通')) {
      job.outreach = { status: 'skipped_communicated', message, evidencePath: '', verify: null, target: { title: actual.structured.title, company: actual.structured.company }, sentAt: now() };
      job.nextAction = liveReason || '页面显示已沟通';
      addDecision(job, 'dedup', 'reject', 'prior_contact', job.nextAction, liveRecruiter.encryptBossId || '');
      saveLedger(ledger);
      console.log(`SKIPPED (${job.nextAction}) ${id} ${actual.structured.title} @ ${actual.structured.company}`);
      return;
    }
    await cdp.eval(`document.querySelector('.btn-startchat').click();true`);
    // Poll until the chat page is ready instead of a fixed sleep, to avoid chat-not-ready
    // from occasional slow loads or a popup injected late.
    let chatReady = false;
    for (let i = 0; i < 25; i++) {
      await humanPause(800, 1400);
      // Try to close the "number privacy protection / security risk" popup on every poll (it can be injected more than once)
      await cdp.eval(`(function(){const cancel=[...document.querySelectorAll('button,a,span')].find(x=>{const t=(x.innerText||'').trim();return t==='取消'&&/隐私保护|安全风险/.test(document.body.innerText);});if(cancel){cancel.click();return 'closed';}return 'none';})()`);

      const dismissedResumeNotice = await cdp.eval(`(function(){const body=document.body.innerText||'';if(!/完善在线简历|请先完善(在线)?简历|简历不完整|去完善简历|完善简历后/.test(body))return false;const ok=[...document.querySelectorAll('button,a,span')].find(x=>x.offsetParent&&(x.innerText||'').trim()==='好的');if(!ok)return false;ok.click();return true;})()`);
      if (dismissedResumeNotice) { await humanPause(300, 700); continue; }

      const probe = await cdp.eval(`(function(){try{return {input:!!document.querySelector('#chat-input'),chat:location.href.includes('/web/geek/chat'),text:document.body.innerText};}catch(e){return {input:false,chat:false,text:''};}})()`);
      if (probe && probe.input && probe.chat) { chatReady = true; break; }
      // Detect a hard block from BOSS (e.g. asking to exchange contact info) and skip cleanly instead of looping into delivery_unverified
      const block = detectSendBlock(probe ? (probe.text || '') : '');
      if (block) {
        job.outreach = { status: 'blocked', message, evidencePath: '', verify: null, target: { title: job.title, company: job.company }, sentAt: now() };
        job.nextAction = block;
        addDecision(job, 'send_gate', 'reject', 'blocked_by_boss', block, '');
        saveLedger(ledger);
        console.log(`BLOCKED (${block}) ${id} ${job.title} @ ${job.company}`);
        return;
      }
    }
    if (!chatReady) {
      // One last check for a BOSS block (as opposed to just a slow load)
      const finalText = await cdp.eval(`document.body.innerText`).catch(() => '');
      const block = detectSendBlock(finalText || '');
      if (block) {
        job.outreach = { status: 'blocked', message, evidencePath: '', verify: null, target: { title: job.title, company: job.company }, sentAt: now() };
        job.nextAction = block;
        addDecision(job, 'send_gate', 'reject', 'blocked_by_boss', block, '');
        saveLedger(ledger);
        console.log(`BLOCKED (${block}) ${id} ${job.title} @ ${job.company}`);
        return;
      }
      throw new Error('chat-not-ready: 点击沟通后 25 轮轮询内聊天页未就绪');
    }
    await humanPause(400, 900);
    const sent = await cdp.eval(`(async()=>{
      const hasDialog = [...document.querySelectorAll('button,a,span')].some(x => /已沟通过|沟通新职位/.test(x.innerText || ''));
      if (hasDialog) {
        const cancelBtn = [...document.querySelectorAll('button,a,span')].find(x => (x.innerText || '').trim() === '取消');
        if (cancelBtn) cancelBtn.click();
        return { error: 'already-communicated' };
      }
      const msg=${JSON.stringify(message)};
      // Close the "number privacy protection" popup again right before sending, in case it's covering the input box
      const pv=[...document.querySelectorAll('button,a,span')].find(x=>{const t=(x.innerText||'').trim();return t==='取消'&&/隐私保护|安全风险/.test(document.body.innerText);});if(pv)pv.click();
      await new Promise(r=>setTimeout(r,300));
      const input=document.querySelector('#chat-input');
      if(!input||!location.href.includes('/web/geek/chat'))return {error:'chat-not-ready'};
      input.focus();
      input.innerHTML='';
      const div=document.createElement('div');
      div.innerText=msg;
      input.appendChild(div);
      input.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:msg}));
      await new Promise(r=>setTimeout(r,700));
      const button=[...document.querySelectorAll('button,a')].find(x=>x.offsetParent&&!x.disabled&&(x.innerText||'').trim()==='发送');
      if(!button)return {error:'send-button'};
      button.click();
      const targetBossId=${JSON.stringify(liveRecruiter.encryptBossId || '')};
      const findMatches=()=>{
        let vm=document.querySelector('.friend-content-warp')?.__vue__;
        while(vm&&vm.$options?.name!=='virtual-list')vm=vm.$parent;
        const sources=vm?.$props?.dataSources||vm?.dataSources||[];
        return targetBossId?sources.filter(s=>s&&String(s.encryptBossId||'')===targetBossId):[];
      };
      let matches=[],entry,confirmed=false;
      for(let attempt=0;attempt<15;attempt++){
        matches=findMatches();
        entry=matches[0];
        confirmed=!!(entry&&entry.lastIsSelf&&(entry.lastText||'').trim()===msg);
        if(confirmed)break;
        if(attempt<14)await new Promise(r=>setTimeout(r,1000));
      }
      const currentInput=document.querySelector('#chat-input')||input;
      return {inputEmpty:!currentInput||(currentInput.innerText||'').trim()==='',identityMatchCount:matches.length,matchedText:confirmed,readOrDelivered:confirmed?Number(entry.lastMsgStatus)>=1:false,companyVisible:document.body.innerText.includes(${JSON.stringify(job.company || actual.structured.company)})}
    })()`);
    if (sent && sent.error === 'already-communicated') {
      job.outreach = { status: 'skipped_communicated', message, evidencePath: '', verify: null, target: { title: actual.structured.title, company: actual.structured.company }, sentAt: now() };
      job.nextAction = '已沟通过，跳过';
      addDecision(job, 'dedup', 'reject', 'chat_already_communicated', job.nextAction, liveRecruiter.encryptBossId || '');
      saveLedger(ledger);
      console.log(`SKIPPED (already communicated) ${id} ${actual.structured.title} @ ${actual.structured.company}`);
      return;
    }
    const verify = sentVerification(sent);
    if (!Object.values(verify).every(Boolean)) throw new Error(`送达核验失败：${JSON.stringify({ sent, verify })}`);
    job.outreach = { status: 'delivered', message, evidencePath: '', verify, target: { title: actual.structured.title, company: actual.structured.company }, sentAt: now() };
    job.nextAction = '等待回复';
    addDecision(job, 'delivery', 'pass', 'delivered', '完整消息已在本人同一气泡显示送达或已读，且输入框已清空', message);
    saveLedger(ledger);
    console.log(`DELIVERED ${id} ${actual.structured.title} @ ${actual.structured.company}`);
  } catch (error) {
    addDecision(job, 'send_gate', 'reject', 'send_blocked', error.message, '');
    job.nextAction = error.message;
    if (/送达核验失败/.test(error.message)) {
      job.outreach = { status: 'delivery_unverified', message, evidencePath: '', verify: null, target: { title: job.title, company: job.company }, sentAt: now() };
    }
    saveLedger(ledger);
    throw error;
  } finally {
    cdp.close();
    await closeTab(cdp.tabId, PORT);
  }
}

async function send() {
  const input = positional() || arg('url');
  const id = jobIdOf(input) || input;
  const ledger = loadLedger();
  const job = ledger.jobs.find(x => x.jobId === id);
  if (!job) throw new Error(`台账中没有岗位 ${id}`);
  const message = process.env.MSG || arg('message') || job.opener?.message;
  if (!message) throw new Error('缺少已保存的开场白，请先运行 save-opener');
  if (job.opener?.jdHash && job.opener.jdHash !== job.jd?.hash) throw new Error('开场白绑定的 JD 已变化，禁止发送');
  return sendMessage(job.url, message);
}

async function verifyDelivery() {
  const input = positional() || arg('url');
  const id = jobIdOf(input) || input;
  const ledger = loadLedger();
  const index = ledger.jobs.findIndex(x => x.jobId === id);
  const job = index >= 0 ? hydrateLegacyStructured(ledger.jobs[index]) : null;
  if (!job) throw new Error(`台账中没有岗位 ${id}`);
  ledger.jobs[index] = job;
  if (job.outreach?.status !== 'delivery_unverified' || !job.outreach.message) throw new Error('只允许复核 delivery_unverified 且保留原消息的岗位');
  const { openTab, closeTab } = cdpLib();
  await reserveAction('jobReads', `verify-delivery ${id}`);
  const cdp = await openTab(job.url, PORT);
  try {
    await humanPause(3500, 7000);
    const page = JSON.parse(await cdp.eval(jobPageExpression()) || '{}');
    if (page.security) throwSecurity('送达复核页进入安全验证', `${id} ${job.url}`);
    if (isClosedJobText(page.bodyText)) throw new Error('岗位已关闭，无法复核送达');
    const entered = await cdp.eval(`(()=>{const b=document.querySelector('.btn-startchat');if(!b)return false;b.click();return true})()`);
    if (!entered) throw new Error('无法进入已有聊天页复核送达');
    let chatReady = false;
    for (let i = 0; i < 20; i++) {
      await humanPause(800, 1400);
      const probe = await cdp.eval(`({input:!!document.querySelector('#chat-input'),chat:location.href.includes('/web/geek/chat')})`);
      if (probe?.input && probe.chat) { chatReady = true; break; }
    }
    if (!chatReady) throw new Error('聊天页未就绪，未重发');
    const sent = await cdp.eval(buildDeliveryVerifyExpr(
      JSON.stringify(job.outreach.message),
      JSON.stringify(job.recruiter?.encryptBossId || ''),
      JSON.stringify(job.company),
    ));
    const verify = sentVerification(sent);
    if (Object.values(verify).every(Boolean)) {
      job.outreach = { ...job.outreach, status: 'delivered', verify, target: { title: job.title, company: job.company } };
      job.nextAction = '等待回复';
      addDecision(job, 'delivery', 'pass', 'delivery_verified_late', '延迟复核确认同一完整消息已送达或已读，未重发', job.outreach.message);
      saveLedger(ledger);
      console.log(`DELIVERED_LATE ${id} ${job.title} @ ${job.company}`);
      return;
    }
    job.nextAction = '送达仍待确认，禁止重发';
    addDecision(job, 'delivery', 'pending', 'delivery_still_unverified', JSON.stringify({ sent, verify }), job.outreach.message);
    saveLedger(ledger);
    console.log(`UNVERIFIED ${id} ${JSON.stringify(verify)}`);
  } finally {
    cdp.close();
    await closeTab(cdp.tabId, PORT);
  }
}

async function selfTest({ quiet = false } = {}) {
  PREFERENCES.opener = { ...PREFERENCES.opener, bannedClaims: ['多年经验'] };
  PROFILES['test_mock'] = { label: 'Test', titleKeywords: ['TestTitle'], jdKeywords: ['TestJD'] };
  const firstProfileId = 'test_mock';
  const firstKeyword = 'TestTitle';
  assert.equal(jobIdOf('https://www.zhipin.com/job_detail/abc_123.html'), 'abc_123');
  assert.deepEqual(verifyFrom([{ verify: { inputEmpty: true, hasMyMsg: true, hasSongda: true } }]), { inputEmpty: true, hasMyMsg: true, hasSongda: true });
  const parsed = parseJobBody('招聘中\nAI全栈开发 20-40K\n公司基本信息\n某公司\n职位描述\n支持全程远程办公');
  assert.deepEqual(parsed, { title: 'AI全栈开发', company: '某公司', salary: '20-40K', remoteEvidence: '支持全程远程办公' });
  assert.equal(assessRemote('非远程', '现场办公').status, 'fail');
  assert.equal(assessRemote('可居家', '').status, 'pass');
  assert.equal(assessRemote('非远程', '支持远程').status, 'pass');
  assert.equal(assessRemote('远程诊断测试工程师', '负责 HIL 台架测试').status, 'pending');
  assert.equal(assessRemote('远程诊断测试工程师', '支持远程办公').status, 'pass');
  assert.equal(matchSecurityPage('https://www.zhipin.com/web/geek/jobs?_security_check=1_123'), false);
  assert.equal(matchSecurityPage('/403.html'), true);
  assert.equal(matchSecurityPage('/web/passport/zp/403.html?code=32'), true);
  assert.equal(matchSecurityPage('正常'), false);
  assert.match(unreadableJobMessage({bodyText: '登录查看完整内容'}), /登录态失效/);
  assert.match(unreadableJobMessage({bodyText: '正常'}), /JD 正文在 12 秒内未渲染/);

  // -- 24-hour rolling rate limit --
  const stamp = minutesAgo => new Date(Date.now() - minutesAgo * 60000).toISOString();
  const tmpBudgetFile = path.join(os.tmpdir(), `bossmate-selftest-budget-${process.pid}.json`);
  const tmpLockFile = path.join(os.tmpdir(), `bossmate-selftest-lock-${process.pid}.json`);

  const writeBudgetEvents = events => fs.writeFileSync(tmpBudgetFile, JSON.stringify({ port: PORT, consecutiveEmptyJd: 0, events }));
  writeBudgetEvents([{ kind: 'jobReads', at: stamp(5) }, { kind: 'jobReads', at: stamp(60) }, { kind: 'jobReads', at: stamp(23 * 60) }, { kind: 'jobReads', at: stamp(25 * 60) }]);
  assert.equal(budgetCountWithin(loadBudget(tmpBudgetFile), 'jobReads', WINDOW_24H), 3);
  assert.equal(budgetCountWithin(loadBudget(tmpBudgetFile), 'jobReads', WINDOW_10MIN), 1);

  writeBudgetEvents(Array.from({ length: RATE_LIMITS.searchPages.softLimit24h }, (_, i) => ({ kind: 'searchPages', at: stamp(60 + i) })));
  await assert.rejects(() => reserveAction('searchPages', 'self-test', tmpBudgetFile, [], tmpLockFile), /24 小时滚动额度已用完/);

  writeBudgetEvents(Array.from({ length: RATE_LIMITS.jobReads.burstLimit10min }, (_, i) => ({ kind: 'jobReads', at: stamp(i * 0.1) })));
  await assert.rejects(() => reserveAction('jobReads', 'self-test', tmpBudgetFile, [], tmpLockFile), /10 分钟突发上限/);

  writeBudgetEvents(Array.from({ length: RATE_LIMITS.jobReads.hardCeiling24h }, (_, i) => ({ kind: 'jobReads', at: stamp(i * 0.01) })));
  await assert.rejects(() => reserveAction('jobReads', 'self-test', tmpBudgetFile, [], tmpLockFile), /触到平台硬顶/);
  assert.equal(loadLock(tmpLockFile).locked, true);

  const originalGap = RATE_LIMITS.jobReads.minGapMs;
  RATE_LIMITS.jobReads.minGapMs = 50;
  writeBudgetEvents([{ kind: 'jobReads', at: new Date().toISOString() }]);
  const startedAt = Date.now();
  await reserveAction('jobReads', 'self-test', tmpBudgetFile, [], tmpLockFile);
  assert(Date.now() - startedAt >= 20, '间隔不足时必须实际等待，不能直接放行');
  RATE_LIMITS.jobReads.minGapMs = originalGap;

  writeBudgetEvents([]);
  await reserveAction('sends', 'self-test', tmpBudgetFile, ['jobReads'], tmpLockFile);
  const counted = loadBudget(tmpBudgetFile);
  assert.equal(budgetCountWithin(counted, 'sends', WINDOW_24H), 1);
  assert.equal(budgetCountWithin(counted, 'jobReads', WINDOW_24H), 1);
  fs.rmSync(tmpBudgetFile, { force: true });
  fs.rmSync(tmpLockFile, { force: true });

  // Late night only slows the pace, doesn't cut the total
  assert.equal(isNightHour(new Date(2026, 0, 1, 23, 30)), true);
  assert.equal(isNightHour(new Date(2026, 0, 1, 3, 0)), true);
  assert.equal(isNightHour(new Date(2026, 0, 1, 14, 0)), false);
  assert.equal(paceMultiplier(new Date(2026, 0, 1, 23, 30)), NIGHT_PACE);
  assert.equal(paceMultiplier(new Date(2026, 0, 1, 14, 0)), 1);

  // Random jitter: consecutive samples can't all be the same, or it degrades back into a fixed interval
  assert.equal(new Set(Array.from({ length: 20 }, () => rndInt(3000, 6500))).size > 1, true);

  // -- review payload and context trimming --
  const payloadJob = blankJob('payload');
  payloadJob.title = '岗位标题';
  payloadJob.company = '某公司';
  payloadJob.recruiter = { activeText: '今日活跃' };
  payloadJob.jd = {
    status: 'read', remoteHint: '支持远程', hash: 'h',
    structured: { description: '岗位正文内容', experience: '1-3年', education: '本科', salary: '20-30K', benefits: '远程', incomplete: false },
  };
  const payload = reviewPayload(payloadJob);
  // All fields needed to review a job must be given at once, or the agent has to go back and read the ledger
  for (const field of ['description', 'remoteHint', 'salary', 'experience', 'education', 'recruiterActive', 'review', 'outreachStatus']) {
    assert(field in payload, `reviewPayload 缺少审核所需字段 ${field}`);
  }
  assert.equal(payload.description, '岗位正文内容');
  assert.deepEqual(payload.review, { fit: 'pending', location: 'pending', pay: 'pending', risk: 'pending' });
  const legacyReview = normalizeJob({ jobId: 'legacy-review', review: { remote: { status: 'pass', evidence: '旧版远程记录' } } });
  assert.deepEqual(legacyReview.review.location, { status: 'pass', evidence: '旧版远程记录' });

  const originalRequirements = { ...PREFERENCES.requirements };
  PREFERENCES.requirements.remotePolicy = '';
  const preScreenLedger = { jobs: [], conversations: [] };
  const noRemoteJob = blankJob('prescreen-no-remote');
  noRemoteJob.title = '软件开发';
  assert.equal(preScreenJob(preScreenLedger, noRemoteJob, { title: '软件开发', text: '软件开发岗位' }, 'primary').status, 'priority');
  PREFERENCES.requirements.remotePolicy = '仅远程';
  const remoteUnknownJob = blankJob('prescreen-remote-unknown');
  remoteUnknownJob.title = '软件开发';
  assert.equal(preScreenJob(preScreenLedger, remoteUnknownJob, { title: '软件开发', text: '软件开发岗位' }, 'primary').status, 'review');
  const remoteHintJob = blankJob('prescreen-remote-hint');
  remoteHintJob.title = '软件开发';
  assert.equal(preScreenJob(preScreenLedger, remoteHintJob, { title: '软件开发', text: '软件开发岗位，支持远程办公' }, 'primary').status, 'priority');
  Object.assign(PREFERENCES.requirements, originalRequirements);

  // --brief must drop the duplicated JD body and fact profile, without losing fields needed to write the opener
  PROFILES['brief_mock'] = { label: 'Brief', titleKeywords: ['岗位标题'], jdKeywords: [], factFocus: '选最相关的一项' };
  const fullCtx = buildOpenerContext(payloadJob, 'brief_mock', false);
  const briefCtx = buildOpenerContext(payloadJob, 'brief_mock', true);
  assert.equal('userProfile' in fullCtx, true);
  assert.equal('description' in fullCtx.job, true);
  assert.equal('userProfile' in briefCtx, false, '--brief 不应重发事实档案');
  assert.equal('description' in briefCtx.job, false, '--brief 不应重发 JD 正文');
  assert.equal(briefCtx.userProfileSource, rel(FACTS_FILE));
  for (const field of ['jobId', 'title', 'company', 'salary']) assert(field in briefCtx.job);
  assert.equal(briefCtx.profile.factFocus, '选最相关的一项');
  assert(JSON.stringify(briefCtx).length < JSON.stringify(fullCtx).length, '--brief 必须更小');
  delete PROFILES['brief_mock'];

  // A risk-control lock can't be unlocked the same day; ordinary errors and locks older than 24 hours can be unlocked normally
  const severeLock = { locked: true, reason: '访问受限：账户存在异常行为', evidence: '', lockedAt: new Date().toISOString() };
  assert.match(unlockRefusal(severeLock), /当天不得解锁/);
  assert.equal(unlockRefusal({ ...severeLock, lockedAt: new Date(Date.now() - 3 * WINDOW_24H).toISOString() }), '');
  assert.equal(unlockRefusal({ locked: true, reason: 'check 发现安全/异常页面', lockedAt: new Date().toISOString() }), '');
  assert.equal(unlockRefusal({ locked: false }), '');

  assert.equal(conversationStatus({ lastMessage: '暂时不考虑远程亲' }), 'closed');
  assert.equal(conversationStatus({ lastMessage: '可以先看下样片嘛' }), 'needs_reply');
  assert.equal(conversationStatus({ lastMessage: '' }), 'needs_inspect');
  assert.equal(conversationStatus({ lastMessage: '您的附件简历已发送给Boss' }), 'system_notice');
  assert.equal(resumeTrigger('麻烦发一份附件简历'), 'explicit');
  assert.equal(resumeTrigger('暂时不用发简历'), 'declined');
  assert.deepEqual(
    sentVerification({ inputEmpty: true, identityMatchCount: 1, matchedText: true, readOrDelivered: true, companyVisible: true }),
    { inputEmpty: true, identityMatched: true, delivered: true, companyVisible: true },
  );
  assert.equal(Object.values(sentVerification({ inputEmpty: true, identityMatchCount: 0, matchedText: false, readOrDelivered: false, companyVisible: true })).every(Boolean), false);
  assert.equal(isExpiredJobRedirect('https://www.zhipin.com/'), true);
  assert.equal(isExpiredJobRedirect('https://www.zhipin.com/web/geek/jobs'), true);
  assert.equal(isExpiredJobRedirect('https://www.zhipin.com/web/passport/login'), false);
  assert.equal(isExpiredJobRedirect('https://evil.example.com/'), false);
  const hashBase = { title: '岗位', company: '公司', description: '正文', benefits: '五险一金、年终奖' };
  assert.equal(jdHashOf(hashBase), jdHashOf({ ...hashBase, benefits: '年终奖 五险一金' }));
  assert.notEqual(jdHashOf(hashBase), jdHashOf({ ...hashBase, benefits: '五险一金' }));
  const sameBoss = { version: 1, jobs: [], conversations: [{ encryptBossId: 'boss-a', encryptJobId: 'old-job', company: '甲公司', name: '张三' }] };
  assert.match(priorContactReason(sameBoss, { jobId: 'new-job', recruiter: { encryptBossId: 'boss-a', company: '甲公司', name: '张三' } }), /招聘者/);
  assert.equal(priorContactReason(sameBoss, { jobId: 'new-job', recruiter: { encryptBossId: 'boss-b', company: '甲公司', name: '李四' } }), '');
  assert.match(priorContactReason(sameBoss, { jobId: 'old-job', recruiter: { encryptBossId: 'boss-b', company: '乙公司', name: '王五' } }), /岗位/);
  assert.match(priorContactReason({ jobs: [], conversations: [] }, { jobId: 'new-job', recruiter: { isFriend: true } }), /已沟通/);
  assert.equal(activityRank('本周活跃'), 70);
  assert.equal(activityRank('3月内活跃'), 30);
  assert.equal(matchProfile(firstKeyword), firstProfileId);
  assert.equal(matchProfile('完全不相关的占位岗位', '', firstProfileId), '');
  const screenLedger = { jobs: [], conversations: [] };
  const activeJob = blankJob('active');
  const quietJob = blankJob('quiet');
  screenLedger.jobs.push(activeJob, quietJob);
  preScreenJob(screenLedger, activeJob, { title: firstKeyword, text: `${firstKeyword} 远程 100-150元/时`, activityText: '今日活跃' });
  preScreenJob(screenLedger, quietJob, { title: firstKeyword, text: `${firstKeyword} 远程 100-150元/时`, activityText: '' });
  assert.equal(activeJob.preScreen.status, 'priority');
  assert.equal(quietJob.preScreen.status, 'priority');
  assert.equal(activeJob.preScreen.score, quietJob.preScreen.score);
  assert(activeJob.preScreen.activityRank > quietJob.preScreen.activityRank);
  const lowPay = blankJob('low');
  screenLedger.jobs.push(lowPay);
  preScreenJob(screenLedger, lowPay, { title: '收费', text: `收费 0-1元/时` });
  assert.equal(lowPay.preScreen.status, 'reject');
  assert.equal(lowPay.decisions.at(-1).stage, 'pre_screen');
  assert.equal(validateOpener('我独立完成过一个从需求到上线的真实项目，贵岗位目前最希望先解决哪一块问题？').includes('贵岗位'), true);
  assert.throws(() => validateOpener('我有多年经验，可以结合岗位要求快速完成开发和测试，贵岗位目前最希望先解决哪一块问题？'), /禁止声称/);
  const partial = blankJob('partial');
  partial.jd = { status: 'partial', structured: { description: '截断内容', incomplete: true } };
  assert.throws(() => assertSendReady(partial), /完整结构化/);
  assert.doesNotThrow(() => assertReadableDescription('短 JD'));
  assert.throws(() => assertReadableDescription('   '), /JD 正文为空/);
  const ready = blankJob('ready');
  ready.jd = { status: 'read', structured: { description: '完整岗位正文', incomplete: false } };
  ready.review = Object.fromEntries(REVIEW_FIELDS.map(field => [field, { status: 'pass' }]));
  assert.doesNotThrow(() => assertSendReady(ready));
  if (!quiet) console.log('SELF_TEST_OK');
  return { ok: true };
}

async function doctor() {
  const checks = [];
  const run = async (name, fn) => {
    try {
      const detail = await fn();
      checks.push({ name, ok: true, ...(detail === undefined ? {} : { detail }) });
    } catch (error) {
      checks.push({ name, ok: false, error: String(error.message || error) });
    }
  };
  await run('node', () => ({ version: process.version, supported: Number(process.versions.node.split('.')[0]) >= 22 }));
  await run('modules', () => {
    const modules = ['cdp', 'runtime-config', 'cli-args', 'ledger-store', 'job-domain', 'jd-domain', 'opener-service', 'delivery-verification', 'conversation-domain', 'daily-options', 'workbench', 'offline-commands', 'discovery-sources', 'page-flows', 'maintenance', 'safety', 'command-help'];
    modules.forEach(name => require(`./${name}`));
    return { loaded: modules.length };
  });
  await run('help-coverage', () => {
    const missing = Object.keys(commands).filter(name => !HELP[name]);
    const stale = Object.keys(HELP).filter(name => !commands[name]);
    if (missing.length || stale.length) throw new Error(`缺帮助=${missing.join(',') || '无'}；失效帮助=${stale.join(',') || '无'}`);
    return { commands: Object.keys(commands).length, online: ONLINE_COMMANDS.size };
  });
  await run('workspace', () => ({ configured: fs.existsSync(PREFERENCES_FILE) && fs.existsSync(FACTS_FILE), root: ROOT }));
  await run('ledger', () => validate({ quiet: true }));
  await run('self-test', () => selfTest({ quiet: true }));
  const ok = checks.every(check => check.ok && (check.name !== 'node' || check.detail.supported));
  console.log(JSON.stringify({ ok, mode: 'offline', consumesBossBudget: false, checks }, null, 2));
  if (!ok) process.exitCode = 1;
}

const commands = {
  import: importLegacy, 'migrate-jd': migrateJd, 'rehash-jd': rehashJd, validate, check, preflight, 'daily-options': dailyOptions,
  'next-work': nextWork, 'job-workbench': jobWorkbench, 'review-audit': reviewAudit,
  'job-sources': jobSources, search, 'search-next': searchNext, 'search-close': searchClose,
  favorites, 'favorites-next': favoritesNext, 'favorite-status': favoriteStatus, 'favorite-queue': favoriteQueue,
  recommendations, 'recommendations-next': recommendationsNext, 'recommendations-close': recommendationsClose,
  replies, interactions, profile, profiles, search, candidates,
  read: readJob, jd: showJd, review, 'opener-context': showOpenerContext, 'save-opener': saveOpener, 'discard-opener': discardOpener, send,
  company, 'company-jobs': companyJobs, list, 'self-test': selfTest, unlock, 'verify-delivery': verifyDelivery,
  'rate-status': rateStatus, budget: rateStatus, doctor,
};
const command = process.argv[2];
if (command === 'help' || command === '--help' || process.argv.includes('--help')) {
  help(command === 'help' ? (process.argv[3] || '') : '');
  process.exit(0);
}
if (!commands[command]) {
  help();
  process.exit(command ? 1 : 0);
}
if (['check', 'replies', 'interactions', 'profile', 'search', 'read', 'review', 'opener-context', 'save-opener', 'send', 'verify-delivery', 'company', 'company-jobs'].includes(command)) {
  assertConfigured();
}
if (ONLINE_COMMANDS.has(command)) assertNotLocked();
// preflight itself is responsible for reporting whether it's locked, so it can't be blocked by the lock;
// jd is purely an offline re-read - it's exactly what's needed to recover the JD body after context gets compressed, even while locked.
if (['preflight', 'jd'].includes(command)) assertConfigured();
Promise.resolve(commands[command]()).catch(error => { console.error(`ERROR: ${error.message}`); process.exit(1); });
