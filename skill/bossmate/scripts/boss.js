#!/usr/bin/env node
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DEFAULT_HOME = path.join(process.env.USERPROFILE || process.env.HOME || process.cwd(), '.bossmate');
const ROOT = path.resolve(process.env.BOSSMATE_HOME || process.env.BOSS_JOB_HOME || DEFAULT_HOME);
const ARCHIVE = path.join(ROOT, 'archive');
const DATA_DIR = path.join(ROOT, 'data');
const LEDGER_FILE = path.join(DATA_DIR, 'ledger.json');
const FACTS_FILE = path.join(ROOT, 'profile.md');
const PREFERENCES_FILE = path.join(ROOT, 'preferences.json');
const PREFERENCES = fs.existsSync(PREFERENCES_FILE)
  ? JSON.parse(fs.readFileSync(PREFERENCES_FILE, 'utf8'))
  : {};
const PROFILES = PREFERENCES.profiles || {};
const PORT = Number(process.env.BOSS_CDP_PORT || PREFERENCES.browser?.port || 9222);
const CITY_CODE = String(PREFERENCES.search?.cityCode || '100010000');
const MIN_HOURLY_PAY = Number(PREFERENCES.requirements?.minimumHourlyPay || 0);
const CDP_LIB = './cdp';
let cachedCdp;

function cdpLib() {
  if (cachedCdp) return cachedCdp;
  cachedCdp = require(CDP_LIB);
  cachedCdp.CDP.prototype.eval = async function evalWithClearedTimeout(expr, timeoutMs = 25000) {
    let timer;
    try {
      const command = this._cmd('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('CDP eval timeout')), timeoutMs); });
      const message = await Promise.race([command, timeout]);
      if (message.result?.exceptionDetails) throw new Error('JS 异常: ' + JSON.stringify(message.result.exceptionDetails).slice(0, 300));
      return message.result?.result?.value;
    } finally {
      clearTimeout(timer);
    }
  };
  return cachedCdp;
}

async function assertPageSafe(cdp, label) {
  const raw = await cdp.eval(`JSON.stringify((()=>{
    const body=(document.body?.innerText||'').slice(0,5000);
    const url=location.href;
    return {
      url,
      login:/\\/web\\/user|login|header-login/i.test(url)||/登录后继续|扫码登录/.test(body),
      security:/security_check|captcha|verify/i.test(url)||!!document.querySelector('.security-check,.verify-wrap,.captcha')||/验证码|安全验证|账号异常/.test(body),
      stopCode:(body.match(/code\\s*[=:]\\s*(36|37)/i)||[])[1]||''
    };
  })())`);
  const state = JSON.parse(raw || '{}');
  if (state.stopCode) throw new Error(`${label} 出现 code=${state.stopCode}，已停止`);
  if (state.security) throw new Error(`${label} 进入安全验证或账号异常页，已停止`);
  if (state.login) throw new Error(`${label} 登录态失效，请用户在专用浏览器中重新登录`);
  return state;
}

const now = () => new Date().toISOString();
const rel = file => path.relative(ROOT, file).replace(/\\/g, '/');
const arg = name => {
  const hit = process.argv.slice(2).find(x => x.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : '';
};
const jobIdOf = text => String(text || '').match(/zhipin\.com\/job_detail\/([^/?#]+?)\.html/i)?.[1] || '';
const emptyLedger = () => ({ version: 2, updatedAt: now(), jobs: [], conversations: [], interactions: [], companies: [], runs: [] });

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

function blankJob(id, url = '') {
  return {
    jobId: id, url: url || `https://www.zhipin.com/job_detail/${id}.html`, title: '', company: '', salary: '', sources: [],
    discovery: { firstSeenAt: '', lastSeenAt: '', query: '', page: 0 },
    preScreen: { status: 'unknown', profile: '', score: 0, activityRank: 0, reasons: [], checkedAt: '' },
    decisions: [],
    jd: { status: 'unknown', evidencePath: '', remoteHint: '', hash: '', structured: null },
    review: { remote: { status: 'pending', evidence: '' }, pay: { status: 'pending', evidence: '' }, risk: { status: 'pending', evidence: '' } },
    opener: { status: 'none', message: '', profile: '', jdHash: '', generatedAt: '', generator: '' },
    approval: { status: 'not_required', approvedAt: '' },
    outreach: { status: 'not_sent', message: '', evidencePath: '', verify: null },
    reply: { status: 'unknown', lastMessage: '', checkedAt: '' }, nextAction: '',
  };
}

function normalizeJob(job) {
  const base = blankJob(job.jobId, job.url);
  return {
    ...base,
    ...job,
    discovery: { ...base.discovery, ...(job.discovery || {}) },
    preScreen: { ...base.preScreen, ...(job.preScreen || {}) },
    decisions: Array.isArray(job.decisions) ? job.decisions : [],
    jd: { ...base.jd, ...(job.jd || {}) },
    review: {
      remote: { ...base.review.remote, ...(job.review?.remote || {}) },
      pay: { ...base.review.pay, ...(job.review?.pay || {}) },
      risk: { ...base.review.risk, ...(job.review?.risk || {}) },
    },
    opener: { ...base.opener, ...(job.opener || {}) },
    approval: { ...base.approval, ...(job.approval || {}) },
    outreach: { ...base.outreach, ...(job.outreach || {}) },
    reply: { ...base.reply, ...(job.reply || {}) },
  };
}

function addDecision(job, stage, status, code, message, evidence = '') {
  const decision = { stage, status, code, message, evidence, at: now() };
  job.decisions = (job.decisions || []).filter(x => !(x.stage === stage && x.code === code));
  job.decisions.push(decision);
  return decision;
}

function activityRank(text) {
  const value = String(text || '');
  if (/在线|刚刚活跃/.test(value)) return 100;
  if (/今日活跃|今天活跃/.test(value)) return 90;
  if (/三日内活跃|\d+天内活跃/.test(value)) return 80;
  if (/本周活跃/.test(value)) return 70;
  if (/本月活跃/.test(value)) return 50;
  if (/\d+[周月]内活跃/.test(value)) return 30;
  return 0;
}

function includesKeyword(text, keyword) {
  return String(text || '').toLocaleLowerCase().includes(String(keyword).toLocaleLowerCase());
}

function matchProfile(title, description = '', requested = '') {
  if (requested) {
    if (!PROFILES[requested]) throw new Error(`未知岗位方向 ${requested}`);
    const profile = PROFILES[requested];
    return [...profile.titleKeywords, ...profile.jdKeywords].some(word => includesKeyword(`${title}\n${description}`, word)) ? requested : '';
  }
  const scores = Object.entries(PROFILES).map(([id, profile]) => {
    const titleScore = profile.titleKeywords.filter(word => includesKeyword(title, word)).length * 3;
    const jdScore = profile.jdKeywords.filter(word => includesKeyword(description, word)).length;
    return { id, score: titleScore + jdScore };
  }).sort((a, b) => b.score - a.score);
  return scores[0]?.score > 0 ? scores[0].id : '';
}

function parseSearchCard(card = {}) {
  const text = String(card.text || '').replace(/\r/g, '').trim();
  const lines = text.split('\n').map(x => x.trim()).filter(Boolean);
  const salary = text.match(/(?:\d+(?:\.\d+)?-\d+(?:\.\d+)?K(?:·\d+薪)?|\d+(?:\.\d+)?-\d+(?:\.\d+)?元\/(?:时|天|月))/i)?.[0] || '';
  const linkTitle = /查看更多|查看详情|立即沟通/.test(card.title || '') ? '' : card.title;
  const title = String(linkTitle || lines.find(x => x !== salary && !/^[·•]$/.test(x) && !/查看更多|查看详情|立即沟通/.test(x)) || '').replace(salary, '').trim();
  return { title, salary, text };
}

function hourlyFloor(salary) {
  const match = String(salary || '').match(/(\d+(?:\.\d+)?)-\d+(?:\.\d+)?元\/时/i);
  return match ? Number(match[1]) : null;
}

function preScreenJob(ledger, job, card = {}, requestedProfile = '') {
  const parsed = parseSearchCard(card);
  if (!job.title && parsed.title) job.title = parsed.title;
  if (!job.salary && parsed.salary) job.salary = parsed.salary;
  const profile = matchProfile(job.title, parsed.text, requestedProfile);
  const reasons = [];
  let status = 'review';
  let score = 0;
  const contacted = priorContactReason(ledger, job);
  const payFloor = hourlyFloor(job.salary);
  const hardExclusions = Array.isArray(PREFERENCES.requirements?.hardExclusions)
    ? PREFERENCES.requirements.hardExclusions : [];
  const obviousRedline = hardExclusions.find(word => includesKeyword(job.title, word));
  if (!job.title || /查看更多|查看详情|立即沟通/.test(job.title)) {
    status = 'review';
    reasons.push({ code: 'missing_list_title', message: '列表链接缺少可用标题，放到队尾人工确认', evidence: parsed.text.slice(0, 100) });
  } else if (contacted) {
    status = 'reject';
    reasons.push({ code: 'prior_contact', message: contacted, evidence: contacted });
  } else if (obviousRedline) {
    status = 'reject';
    reasons.push({ code: 'title_redline', message: '岗位标题命中用户明确红线', evidence: obviousRedline });
  } else if (payFloor !== null && payFloor <= MIN_HOURLY_PAY) {
    status = 'reject';
    reasons.push({ code: 'hourly_floor', message: `列表明确时薪不高于用户下限 ${MIN_HOURLY_PAY} 元`, evidence: job.salary });
  } else if (!profile) {
    status = 'reject';
    reasons.push({ code: 'direction_mismatch', message: '标题和列表信息未命中用户配置的岗位方向', evidence: job.title });
  } else {
    score += 30;
    reasons.push({ code: 'direction_match', message: `命中${PROFILES[profile].label}`, evidence: job.title });
    if (/远程|居家|线上/.test(parsed.text)) {
      score += 30;
      status = 'priority';
      reasons.push({ code: 'remote_hint', message: '列表出现远程信号，仍需完整 JD 核实', evidence: parsed.text.match(/.{0,12}(?:远程|居家|线上).{0,12}/)?.[0] || '' });
    } else {
      status = 'review';
      reasons.push({ code: 'remote_unknown', message: '列表没有远程证据，完整 JD 前排在远程信号之后', evidence: '' });
    }
    if (job.salary) score += 10;
  }
  const rank = activityRank(card.activityText || job.jd?.structured?.recruiter?.activeText);
  job.preScreen = { status, profile, score, activityRank: rank, reasons, checkedAt: now() };
  addDecision(job, 'pre_screen', status === 'reject' ? 'reject' : 'pass', reasons[0]?.code || 'review', reasons.map(x => x.message).join('；'), reasons.map(x => x.evidence).filter(Boolean).join('；'));
  return job.preScreen;
}

function findHrName(text, companyName) {
  if (!text) return '';
  const lines = text.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  const activeIdx = lines.findIndex(l => /^(在线|刚刚活跃|今天活跃|三日内活跃|本周活跃|本月活跃|\d+天内活跃|\d+周内活跃|\d+月内活跃)$/.test(l));
  if (activeIdx > 0) return lines[activeIdx - 1];
  const dotIdx = lines.findIndex(l => l === '·');
  if (dotIdx > 0) {
    if (dotIdx >= 2 && lines[dotIdx - 1] === companyName) return lines[dotIdx - 2];
    if (dotIdx >= 3 && lines[dotIdx - 1] === companyName && lines[dotIdx - 3]) return lines[dotIdx - 3];
  }
  return '';
}

function recruiterFromButton(button = {}, name = '', company = '') {
  let encryptBossId = '';
  try {
    encryptBossId = new URL(button.redirectUrl || '', 'https://www.zhipin.com').searchParams.get('id') || '';
  } catch {}
  return {
    encryptBossId,
    name,
    company,
    isFriend: button.isFriend === true || button.isFriend === 'true',
  };
}

function conversationKey(item) {
  if (item.encryptBossId) return `boss:${item.encryptBossId}`;
  if (item.friendId) return `friend:${item.friendId}`;
  return `name:${item.company || ''}@@${item.name || ''}`;
}

function priorContactReason(ledger, job, recruiter = job.recruiter || {}) {
  if (recruiter.isFriend) return 'BOSS 标记该招聘者已沟通';
  const conversations = ledger.conversations || [];
  if (conversations.some(c => c.encryptJobId && c.encryptJobId === job.jobId)) return '该岗位已存在会话';
  if (recruiter.encryptBossId && conversations.some(c => c.encryptBossId === recruiter.encryptBossId)) return '该招聘者已存在会话';
  if (recruiter.encryptBossId && ledger.jobs.some(other =>
    other.jobId !== job.jobId &&
    other.recruiter?.encryptBossId === recruiter.encryptBossId &&
    other.outreach?.status !== 'not_sent'
  )) return '该招聘者已通过其他岗位沟通过';
  if (recruiter.name && recruiter.company && conversations.some(c =>
    c.name === recruiter.name && c.company === recruiter.company
  )) return '同公司同名招聘者已存在会话';
  return '';
}

function ensureJob(ledger, id, url = '') {
  let job = ledger.jobs.find(x => x.jobId === id);
  if (!job) { job = blankJob(id, url); ledger.jobs.push(job); }
  else Object.assign(job, normalizeJob(job));
  if (url) job.url = url;
  return job;
}

function loadLedger() {
  if (!fs.existsSync(LEDGER_FILE)) return emptyLedger();
  return { ...emptyLedger(), ...JSON.parse(fs.readFileSync(LEDGER_FILE, 'utf8')) };
}

function saveLedger(ledger) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  ledger.version = 2;
  ledger.updatedAt = now();
  const tmp = LEDGER_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(ledger, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, LEDGER_FILE);
}

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

function parseJobBody(body) {
  const lines = String(body || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  const recruiting = lines.indexOf('招聘中');
  const titleSalary = recruiting >= 0 ? lines[recruiting + 1] || '' : '';
  const companyAt = lines.indexOf('公司基本信息');
  const company = companyAt >= 0 ? lines[companyAt + 1] || '' : '';
  const salary = titleSalary.match(/(?:\d+(?:\.\d+)?-\d+(?:\.\d+)?K(?:·\d+薪)?|\d+-\d+元\/(?:时|天|月))/i)?.[0] || '';
  const title = salary ? titleSalary.slice(0, titleSalary.indexOf(salary)).trim() : titleSalary;
  const remoteEvidence = lines.find(x => /全程远程|远程办公|居家办公|线上办公|接受远程|可远程|远程工作/.test(x)) || '';
  return { title, company, salary, remoteEvidence };
}

function jobPageExpression() {
  return `(()=>{
    const text=(el)=>(el?.innerText||'').replace(/\\s+/g,' ').trim();
    const section=(name)=>{
      const heading=[...document.querySelectorAll('.job-detail h2,.job-detail h3,.job-detail .job-sec-title')].find(x=>text(x)===name);
      const box=heading?.closest('.detail-section-item,.job-detail-section,.job-sec,.job-box')||heading?.parentElement;
      return box ? text(box).replace(name,'').trim() : '';
    };
    const b=document.querySelector('.btn-startchat');
    const description=text(document.querySelector('.job-sec-text'));
    const primary=text(document.querySelector('.job-primary'));
    const recruiterBox=document.querySelector('.job-boss-info');
    const recruiterNameEl=recruiterBox?.querySelector('.name');
    const recruiterState=text(recruiterBox?.querySelector('.boss-active-time,.boss-online-tag'));
    const recruiterName=recruiterNameEl ? text(recruiterNameEl).replace(recruiterState,'').trim() : '';
    const recruiterAttr=text(recruiterBox?.querySelector('.boss-info-attr'));
    const attrParts=recruiterAttr.split('·').map(x=>x.trim()).filter(Boolean);
    const bodyText=document.body.innerText||'';
    const salary=(description.match(/\\d+(?:\\.\\d+)?-\\d+(?:\\.\\d+)?(?:K(?:·\\d+薪)?|元\\/(?:时|天|月))/i)||bodyText.match(/\\d+(?:\\.\\d+)?-\\d+(?:\\.\\d+)?(?:K(?:·\\d+薪)?|元\\/(?:时|天|月))/i)||[])[0]||'';
    return JSON.stringify({
      url:location.href,bodyText,
      security:location.href.includes('security_check')||!!document.querySelector('.security-check,.verify-wrap,.captcha'),
      structured:{
        title:document.querySelector('.job-banner h1[title]')?.getAttribute('title')||text(document.querySelector('.job-banner h1')),
        company:attrParts[0]||'',
        salary,
        description,
        benefits:[...new Set([...(document.querySelector('.job-tags')?.querySelectorAll('span,li')||[])].map(text).filter(Boolean))].join('、'),
        companyIntroduction:section('公司介绍'),
        businessInformation:section('工商信息'),
        address:section('工作地址'),
        experience:(primary.match(/经验不限|应届生|\\d+-\\d+年|\\d+年以上/)||[])[0]||'',
        education:(primary.match(/学历不限|初中|中专|高中|大专|本科|硕士|博士/)||[])[0]||'',
        tags:[...new Set([...(document.querySelector('.job-tags')?.querySelectorAll('span,li')||[])].map(text).filter(Boolean))],
        recruiter:{name:recruiterName,title:attrParts.slice(1).join(' · '),activeText:recruiterState},
        incomplete:/登录查看完整内容|登录后查看完整职位描述/.test(description)
      },
      button:{text:text(b),redirectUrl:b?.getAttribute('redirect-url')||'',isFriend:b?.dataset?.isfriend||''}
    });
  })()`;
}

function normalizeStructuredPage(page) {
  const structured = page.structured || {};
  const fallback = parseJobBody(page.bodyText || '');
  structured.title ||= fallback.title;
  structured.company ||= fallback.company;
  structured.salary ||= fallback.salary;
  structured.description ||= '';
  structured.tags = Array.isArray(structured.tags) ? structured.tags : [];
  structured.recruiter = structured.recruiter || { name: '', title: '', activeText: '' };
  structured.recruiter.activityRank = activityRank(structured.recruiter.activeText);
  const remoteEvidence = structured.description.split(/\r?\n|(?<=[。；])/).map(x => x.trim()).find(x => /全程远程|远程办公|居家办公|线上办公|接受远程|可远程|远程工作/.test(x)) || '';
  const hashSource = JSON.stringify({
    title: structured.title,
    company: structured.company,
    description: structured.description,
    benefits: structured.benefits || '',
    address: structured.address || '',
    experience: structured.experience || '',
    education: structured.education || '',
  });
  return { structured, remoteEvidence, hash: crypto.createHash('sha256').update(hashSource).digest('hex') };
}

function assertReadableDescription(description) {
  if (!String(description || '').trim()) throw new Error('JD 正文为空，已停止');
}

function hydrateLegacyStructured(job) {
  if (job.jd?.structured?.description || !job.jd?.text) return normalizeJob(job);
  const normalized = normalizeJob(job);
  const body = String(job.jd.text);
  const start = body.indexOf('职位描述');
  const companyAt = body.indexOf('\n公司介绍', start + 4);
  const competitionAt = body.indexOf('\n竞争力分析', start + 4);
  const end = companyAt > start ? companyAt : competitionAt > start ? competitionAt : body.length;
  let description = start >= 0 ? body.slice(start + 4, end).trim() : body;
  if (competitionAt > start && (!companyAt || companyAt < 0)) {
    description = description.replace(/\n[^\n]+\n(?:在线|刚刚活跃|今天活跃|三日内活跃|本周活跃|本月活跃)\n[^\n]+\n·\n[^\n]+$/s, '').trim();
  }
  const primary = body.slice(0, Math.max(0, start));
  const companyIntroEnd = body.indexOf('\n工商信息', companyAt + 1);
  const addressAt = body.indexOf('\n工作地址', Math.max(companyAt, 0) + 1);
  const structured = {
    title: normalized.title,
    company: normalized.company,
    salary: normalized.salary,
    description,
    benefits: '',
    companyIntroduction: companyAt >= 0 ? body.slice(companyAt + 5, companyIntroEnd > companyAt ? companyIntroEnd : body.length).trim() : '',
    businessInformation: '',
    address: addressAt >= 0 ? body.slice(addressAt + 5).split('\n').filter(Boolean)[0] || '' : '',
    experience: (primary.match(/经验不限|应届生|\d+-\d+年|\d+年以上/) || [])[0] || '',
    education: (primary.match(/学历不限|初中|中专|高中|大专|本科|硕士|博士/) || [])[0] || '',
    tags: [],
    recruiter: { name: normalized.recruiter?.name || '', title: normalized.recruiter?.title || '', activeText: normalized.recruiter?.activeText || '', activityRank: normalized.recruiter?.activityRank || 0 },
    incomplete: /登录查看完整内容/.test(description),
  };
  const parsed = normalizeStructuredPage({ structured, bodyText: body });
  normalized.jd = { ...normalized.jd, structured: parsed.structured, hash: parsed.hash, remoteHint: parsed.remoteEvidence };
  return normalized;
}

function validateOpener(message) {
  const value = String(message || '').replace(/^["“]|["”]$/g, '').replace(/\s+/g, ' ').trim();
  const minLength = Number(PREFERENCES.opener?.minLength || 20);
  const maxLength = Number(PREFERENCES.opener?.maxLength || 180);
  if (value.length < minLength || value.length > maxLength) throw new Error(`开场白长度必须在 ${minLength}–${maxLength} 字之间`);
  const bannedClaims = Array.isArray(PREFERENCES.opener?.bannedClaims) ? PREFERENCES.opener.bannedClaims : [];
  const banned = bannedClaims.find(claim => includesKeyword(value, claim));
  if (banned) throw new Error(`开场白含用户禁止声称的经历：${banned}`);
  if (/https?:\/\/|www\./i.test(value)) throw new Error('AI 开场白不得主动附带链接');
  if (!/[?？]/.test(value)) throw new Error('AI 开场白必须包含一个具体问题');
  return value;
}

function assertSendReady(job) {
  if (job.jd?.status !== 'read' || job.jd?.liveStatus === 'partial' || !job.jd?.structured?.description || job.jd.structured.incomplete) throw new Error('未读取完整结构化 JD');
  for (const field of ['remote', 'pay', 'risk']) {
    if (job.review?.[field]?.status !== 'pass') throw new Error(`${field} 尚未通过审核`);
  }
  if (job.outreach?.status !== 'not_sent') throw new Error(`该岗位状态为 ${job.outreach?.status || 'unknown'}，禁止再次发送`);
}

function assertAgentReady(ledger, job) {
  assertSendReady(job);
  const reason = priorContactReason(ledger, job);
  if (reason) throw new Error(reason);
}

function assertApprovalReady(job) {
  if (PREFERENCES.mode !== 'autopilot' && job.approval?.status !== 'approved') {
    throw new Error('当前是审阅模式，用户尚未批准该岗位');
  }
}

// 识别 BOSS 沟通前的硬性拦截（非时序问题，重试无用）：要求补全在线简历、交换联系方式等。
function detectSendBlock(text) {
  if (!text) return '';
  if (/完善在线简历|请先完善(在线)?简历|简历不完整|去完善简历|完善简历后/.test(text)) return 'BOSS 要求先完善在线简历才能沟通';
  if (/交换(微信|手机号)|请先绑定(微信|手机)|先交换/.test(text)) return 'BOSS 要求先交换联系方式才能沟通';
  return '';
}

function buildOpenerContext(job, profileId) {
  const profile = PROFILES[profileId] || PROFILES[matchProfile(job.title, job.jd?.structured?.description || '')];
  if (!profile) throw new Error('岗位未匹配用户配置的求职方向，不能生成开场白');
  const facts = fs.readFileSync(FACTS_FILE, 'utf8');
  const structured = job.jd?.structured || {};
  return {
    instruction: '只写一个与 JD 最相关的真实事实，再问一个具体问题；自然、具体、不写链接，不使用资料之外的经历。',
    profile: { id: profileId, label: profile.label, factFocus: profile.factFocus || '' },
    job: {
      jobId: job.jobId, title: job.title, company: job.company,
      salary: job.salary || structured.salary || '', experience: structured.experience || '',
      education: structured.education || '', description: structured.description,
      benefits: structured.benefits || '',
    },
    userProfile: facts,
    openerRules: PREFERENCES.opener || {},
  };
}

function openerContext(job, requestedProfile = '') {
  if (job.jd?.status !== 'read' || !job.jd?.structured?.description || job.jd.structured.incomplete) throw new Error('未读取完整结构化 JD');
  const profileId = matchProfile(job.title, job.jd.structured.description, requestedProfile || job.preScreen?.profile);
  return buildOpenerContext(job, profileId);
}

function verifyFrom(value) {
  const rows = Array.isArray(value) ? value : [value];
  const verify = rows.find(x => x && x.verify)?.verify || value?.verify || {};
  return {
    inputEmpty: verify.inputEmpty === true,
    hasMyMsg: verify.hasMyMsg === true,
    hasSongda: verify.hasSongda === true,
  };
}

function conversationStatus(item) {
  const ours = /status/.test(item.statusClass || '');
  if (ours) return /read/.test(item.statusClass) ? 'ours_last_read' : 'ours_last_delivered';
  if (/不.{0,2}合适|不考虑|暂不|抱歉|对不起|已招到|停止招聘|不支持远程|早日找到/.test(item.lastMessage || '')) return 'closed';
  if (/[?？]|加.{0,4}(微信|手机号)|发.{0,6}(简历|作品|样片|案例)|看下|提供|方便|可以/.test(item.lastMessage || '')) return 'needs_reply';
  return 'boss_last_review';
}

function sentVerification(sent) {
  return {
    inputEmpty: sent?.inputEmpty === true,
    exactMessage: sent?.exactMessageCount === 1,
    sameRowDelivered: /status-(?:delivery|read)/.test(sent?.sameRowStatusClass || ''),
    companyVisible: sent?.companyVisible === true,
  };
}

function importLegacy() {
  const previous = new Map(loadLedger().jobs.map(job => [job.jobId, job]));
  const jobs = new Map();
  const ensure = (id, url = '') => {
    if (!id) return null;
    if (!jobs.has(id)) jobs.set(id, {
      jobId: id,
      url: url || `https://www.zhipin.com/job_detail/${id}.html`,
      title: '', company: '', salary: '',
      sources: [],
      jd: { status: 'unknown', evidencePath: '', remoteHint: '' },
      review: {
        remote: { status: 'pending', evidence: '' },
        pay: { status: 'pending', evidence: '' },
        risk: { status: 'pending', evidence: '' },
      },
      outreach: { status: 'not_sent', message: '', evidencePath: '', verify: null },
      reply: { status: 'unknown', lastMessage: '', checkedAt: '' },
      nextAction: '',
    });
    return jobs.get(id);
  };

  const files = walk(ARCHIVE);
  for (const file of files.filter(x => /\.(?:md|json)$/i.test(x))) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const urls = text.match(/https?:\/\/(?:www\.)?zhipin\.com\/job_detail\/[^\s)\]"']+?\.html/gi) || [];
    for (const url of urls) {
      const job = ensure(jobIdOf(url), url);
      if (job && !job.sources.includes(rel(file))) job.sources.push(rel(file));
    }

    if (/[/\\]jd_[^/\\]+\.json$/i.test(file)) {
      try {
        const value = JSON.parse(text);
        const id = jobIdOf(value.url) || path.basename(file).match(/^jd_(.+)\.json$/i)?.[1] || '';
        const job = ensure(id, value.url);
        const parsed = parseJobBody(value.body);
        Object.assign(job, Object.fromEntries(Object.entries(parsed).filter(([key, val]) => key !== 'remoteEvidence' && val)));
        job.jd = { status: value.body ? 'read' : 'empty', evidencePath: rel(file), remoteHint: parsed.remoteEvidence };
        if (!job.sources.includes(rel(file))) job.sources.push(rel(file));
      } catch {}
    }

    if (/[/\\](?:send_[^/\\]+|verify_final)\.json$/i.test(file)) {
      try {
        const value = JSON.parse(text);
        const url = (Array.isArray(value) ? value.find(x => x?.url)?.url : value.url) || '';
        const id = jobIdOf(url) || path.basename(file).match(/^send_(.+)\.json$/i)?.[1] || '';
        const job = ensure(id, url);
        const verify = verifyFrom(value);
        if (verify.inputEmpty && verify.hasMyMsg && verify.hasSongda) {
          job.outreach = { ...job.outreach, status: 'delivered_legacy', evidencePath: rel(file), verify };
        }
        if (!job.sources.includes(rel(file))) job.sources.push(rel(file));
      } catch {}
    }
  }

  for (const [id, old] of previous) {
    const imported = ensure(id, old.url);
    jobs.set(id, {
      ...imported,
      ...old,
      sources: [...new Set([...(imported.sources || []), ...(old.sources || [])])],
      jd: { ...imported.jd, ...old.jd },
      review: { ...imported.review, ...old.review },
      outreach: { ...imported.outreach, ...old.outreach },
      reply: { ...imported.reply, ...old.reply },
    });
  }

  const ledger = loadLedger();
  ledger.jobs = [...jobs.values()].sort((a, b) => a.jobId.localeCompare(b.jobId));
  saveLedger(ledger);
  console.log(`已导入 ${ledger.jobs.length} 个历史岗位；有 JD ${ledger.jobs.filter(x => x.jd.status === 'read').length}；有旧送达证据 ${ledger.jobs.filter(x => x.outreach.status === 'delivered_legacy').length}`);
}

function validate() {
  const ledger = loadLedger();
  const errors = [];
  const seen = new Set();
  for (const job of ledger.jobs) {
    if (!job.jobId || seen.has(job.jobId)) errors.push(`重复或空 jobId: ${job.jobId}`);
    seen.add(job.jobId);
    if (jobIdOf(job.url) !== job.jobId) errors.push(`链接不匹配: ${job.jobId}`);
    for (const evidence of [job.jd?.evidencePath, job.outreach?.evidencePath].filter(Boolean)) {
      const full = path.resolve(ROOT, evidence);
      if (!full.startsWith(ROOT + path.sep) || !fs.existsSync(full)) errors.push(`证据路径失效: ${job.jobId} -> ${evidence}`);
    }
    if (/^delivered/.test(job.outreach?.status || '')) {
      const v = job.outreach.verify || {};
      const validLegacy = v.inputEmpty && v.hasMyMsg && v.hasSongda;
      const validCurrent = v.inputEmpty && v.exactMessage && v.sameRowDelivered && v.companyVisible;
      if (!(validLegacy || validCurrent)) errors.push(`送达核验不完整: ${job.jobId}`);
    }
  }
  const conversationKeys = new Set();
  for (const conversation of ledger.conversations) {
    const key = conversationKey(conversation);
    if (conversationKeys.has(key)) errors.push(`重复会话身份: ${key}`);
    conversationKeys.add(key);
  }
  assert.equal(errors.length, 0, errors.join('\n'));
  console.log(`VALID ${ledger.jobs.length} jobs / ${ledger.conversations.length} conversations / ${ledger.companies.length} companies`);
}

async function check() {
  const tabs = await fetch(`http://127.0.0.1:${PORT}/json`).then(r => r.json());
  const boss = tabs.filter(x => x.type === 'page' && /zhipin\.com/.test(x.url || ''));
  const security = boss.filter(x => /security_check|captcha|verify/i.test(`${x.url} ${x.title}`));
  if (!boss.length || security.length) {
    console.log(JSON.stringify({ port: PORT, bossTabs: boss.length, securityPages: security.length, urls: boss.map(x => x.url) }, null, 2));
    process.exitCode = 2;
    return;
  }
  const { CDP } = cdpLib();
  const cdp = new CDP(PORT);
  try {
    await cdp.connectPage(tab => tab.id === boss[0].id);
    const state = await assertPageSafe(cdp, '账号体检');
    console.log(JSON.stringify({ port: PORT, bossTabs: boss.length, securityPages: 0, login: 'ok', url: state.url }, null, 2));
  } finally {
    cdp.close();
  }
}

async function replies() {
  const { openTab, closeTab, sleep } = cdpLib();
  const cdp = await openTab('https://www.zhipin.com/web/geek/chat', PORT);
  try {
    await sleep(3500);
    await assertPageSafe(cdp, '会话页');
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
  const { openTab, closeTab, sleep } = cdpLib();
  const cdp = await openTab('https://www.zhipin.com/web/geek/recommend', PORT);
  const snapshots = [];
  try {
    await sleep(3500);
    await assertPageSafe(cdp, '互动页');
    for (const label of ['谁看过我', '对我感兴趣的']) {
      await cdp.eval(`(()=>{const label=${JSON.stringify(label)};const el=[...document.querySelectorAll('span,a,li')].find(x=>(x.innerText||'').trim()===label&&x.offsetParent);if(!el)return false;el.click();return true})()`);
      await sleep(1500);
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
  const { openTab, closeTab, sleep } = cdpLib();
  const cdp = await openTab('https://www.zhipin.com/web/geek/resume', PORT);
  try {
    await sleep(3500);
    await assertPageSafe(cdp, '在线简历页');
    const raw = await cdp.eval(`JSON.stringify({url:location.href,security:location.href.includes('security_check')||!!document.querySelector('.security-check,.verify-wrap,.captcha'),expectations:document.querySelector('#purpose')?.innerText.replace(/\\s+/g,' ').trim()||'',advantage:document.querySelector('#summary .advantage-text')?.innerText.trim()||'',attachments:[...document.querySelectorAll('a')].filter(a=>/\\.pdf$/i.test((a.innerText||'').trim())).map(a=>(a.innerText||'').trim())})`);
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
  const input = process.argv[3] || arg('url');
  const id = jobIdOf(input) || (/^[\w-]+$/.test(input || '') ? input : '');
  const existing = id ? loadLedger().jobs.find(x => x.jobId === id) : null;
  const url = jobIdOf(input) ? input : existing?.url;
  if (!id) throw new Error('需要有效的 BOSS 岗位详情链接');
  if (!url) throw new Error(`台账中没有岗位 ${id} 的详情链接`);
  const { openTab, closeTab, sleep } = cdpLib();
  const cdp = await openTab(url, PORT);
  try {
    await sleep(4500);
    await assertPageSafe(cdp, '岗位详情页');
    const raw = await cdp.eval(jobPageExpression());
    const page = JSON.parse(raw || '{}');
    if (page.security || jobIdOf(page.url) !== id) throw new Error('岗位页进入安全验证或发生跳转，已停止');
    assertReadableDescription(page.structured?.description);
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
    console.log(JSON.stringify({
      status: job.jd.status, jobId: id, title: job.title, company: job.company, salary: job.salary,
      remoteHint: job.jd.remoteHint, descriptionChars: job.jd.structured?.description?.length || 0,
      recruiterActive: job.recruiter.activeText || '', activityRank: job.recruiter.activityRank || 0,
    }, null, 2));
  } finally {
    cdp.close();
    await closeTab(cdp.tabId, PORT);
  }
}

async function search() {
  const query = process.argv[3] || arg('query');
  const page = Number(arg('page') || 1);
  const requestedProfile = arg('profile');
  if (requestedProfile && !PROFILES[requestedProfile]) throw new Error(`未知岗位方向 ${requestedProfile}`);
  if (!query || !Number.isInteger(page) || page < 1 || page > 10) throw new Error('需要搜索词，page 必须是 1–10');
  const url = `https://www.zhipin.com/web/geek/jobs?query=${encodeURIComponent(query)}&city=${encodeURIComponent(CITY_CODE)}&page=${page}`;
  const { openTab, closeTab, sleep } = cdpLib();
  const cdp = await openTab(url, PORT);
  try {
    await sleep(4500);
    await assertPageSafe(cdp, '搜索页');
    const raw = await cdp.eval(`JSON.stringify({url:location.href,security:location.href.includes('security_check')||!!document.querySelector('.security-check,.verify-wrap,.captcha'),links:[...document.querySelectorAll('a[href*="/job_detail/"]')].map(a=>{const card=a.closest('li,.job-card-wrapper,.job-card-box,.job-list-box')||a.parentElement;return {url:a.href,title:(a.innerText||'').trim(),text:(card?.innerText||a.innerText||'').trim(),activityText:(card?.innerText||'').match(/(?:在线|刚刚活跃|今日活跃|今天活跃|三日内活跃|本周活跃|本月活跃|\\d+[天周月]内活跃)/)?.[0]||''}}).filter(x=>x.title)})`);
    const result = JSON.parse(raw || '{}');
    if (result.security) throw new Error('搜索页进入安全验证，已停止');
    const unique = new Map((result.links || []).map(x => [jobIdOf(x.url), x]).filter(([id]) => id));
    if (!unique.size) throw new Error('搜索页没有可读取岗位，按空结果停止，不继续翻页');
    const ledger = loadLedger();
    let fresh = 0;
    const counts = { priority: 0, review: 0, reject: 0 };
    for (const [id, link] of unique) {
      const existed = ledger.jobs.some(x => x.jobId === id);
      const job = ensureJob(ledger, id, link.url);
      job.sources = [...new Set([...(job.sources || []), `search:${query}`])];
      const capturedAt = now();
      job.discovery = {
        ...job.discovery,
        firstSeenAt: job.discovery?.firstSeenAt || capturedAt,
        lastSeenAt: capturedAt,
        query,
        page,
      };
      const result = preScreenJob(ledger, job, link, requestedProfile);
      counts[result.status]++;
      if (!existed) fresh++;
    }
    ledger.runs.push({ id: `search-${Date.now()}`, type: 'search', source: query, profile: requestedProfile || 'auto', page, found: unique.size, fresh, counts, at: now() });
    saveLedger(ledger);
    console.log(`${query} 第 ${page} 页：${unique.size} 个岗位，新增 ${fresh}；优先 ${counts.priority}，待看 ${counts.review}，预筛淘汰 ${counts.reject}`);
  } finally {
    cdp.close();
    await closeTab(cdp.tabId, PORT);
  }
}

async function companyJobs() {
  const name = process.argv[3] || '';
  const ledger = loadLedger();
  const company = ledger.companies.find(x => x.name === name);
  if (!company?.url) throw new Error(`公司池中没有 ${name} 或缺少入口链接`);
  const { openTab, closeTab, sleep } = cdpLib();
  const cdp = await openTab(company.url, PORT);
  try {
    await sleep(4000);
    await assertPageSafe(cdp, '公司职位页');
    let allJobsUrl = await cdp.eval(`(()=>{const a=[...document.querySelectorAll('a')].find(x=>/查看(全部|所有)职位/.test((x.innerText||'').trim()));return a?.href||''})()`);
    if (allJobsUrl) { await cdp.navigate(allJobsUrl); await sleep(3500); }
    const raw = await cdp.eval(`JSON.stringify({url:location.href,security:location.href.includes('security_check')||!!document.querySelector('.security-check,.verify-wrap,.captcha'),links:[...document.querySelectorAll('a[href*="/job_detail/"]')].map(a=>({url:a.href,text:(a.innerText||'').trim()})).filter(x=>x.text)})`);
    const page = JSON.parse(raw || '{}');
    if (page.security) throw new Error('公司职位页进入安全验证，已停止');
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
    ['remote', 'pay', 'risk'].every(k => x.review?.[k]?.status === 'pass') &&
    x.outreach?.status === 'not_sent' &&
    !priorContactReason(ledger, x)
  );
  const replies = ledger.conversations.filter(x => x.status === 'needs_reply');
  const review = ledger.conversations.filter(x => x.status === 'boss_last_review');
  const pre = Object.fromEntries(['priority', 'review', 'reject'].map(status => [status, ledger.jobs.filter(x => x.preScreen?.status === status).length]));
  console.log(`岗位 ${ledger.jobs.length}｜完整JD ${ledger.jobs.filter(x => x.jd?.status === 'read').length}｜预筛优先 ${pre.priority}｜预筛待看 ${pre.review}｜预筛淘汰 ${pre.reject}｜可发送 ${ready.length}｜待回复 ${replies.length}｜待判断 ${review.length}｜远程友好公司 ${ledger.companies.filter(x => x.status === 'pass').length}`);
  ready.slice(0, 20).forEach(x => console.log(`- [可发送] ${x.jobId} ${x.title} @ ${x.company}`));
}

function profiles() {
  for (const [id, profile] of Object.entries(PROFILES)) {
    console.log(`${id}\t${profile.label}\t${profile.titleKeywords.join('、')}`);
  }
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
  assertApprovalReady(job);

  const staticReason = priorContactReason(ledger, job);
  if (staticReason) {
    job.outreach = { status: 'skipped_communicated', message, evidencePath: '', verify: null, target: { title: job.title, company: job.company }, sentAt: now() };
    job.nextAction = staticReason;
    addDecision(job, 'dedup', 'reject', 'prior_contact', staticReason, job.recruiter?.encryptBossId || '');
    saveLedger(ledger);
    console.log(`STATIC_SKIPPED (${staticReason}) ${id} ${job.title} @ ${job.company}`);
    return;
  }

  const { openTab, closeTab, sleep } = cdpLib();
  const cdp = await openTab(url, PORT);
  try {
    await sleep(5000);
    await assertPageSafe(cdp, '发送前岗位页');
    const preflight = JSON.parse(await cdp.eval(jobPageExpression()) || '{}');
    if (preflight.security || jobIdOf(preflight.url) !== id || !preflight.button?.text) throw new Error('发送前岗位页、安全状态或沟通按钮核验失败');
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
    // 轮询等待聊天页就绪：不再用固定 sleep，避免偶发加载慢 / 弹窗延后注入导致 chat-not-ready。
    let chatReady = false;
    for (let i = 0; i < 25; i++) {
      await sleep(1000);
      // 每次轮询都尝试关闭“号码隐私保护/安全风险”安全弹窗（可能多次注入）
      await cdp.eval(`(function(){const cancel=[...document.querySelectorAll('button,a,span')].find(x=>{const t=(x.innerText||'').trim();return t==='取消'&&/隐私保护|安全风险/.test(document.body.innerText);});if(cancel){cancel.click();return 'closed';}return 'none';})()`);
      const probe = await cdp.eval(`(function(){try{return {input:!!document.querySelector('#chat-input'),chat:location.href.includes('/web/geek/chat'),text:document.body.innerText};}catch(e){return {input:false,chat:false,text:''};}})()`);
      if (probe && probe.input && probe.chat) { chatReady = true; break; }
      // 检测 BOSS 硬性拦截（完善简历 / 交换联系方式等），拦截则优雅跳过，不进 delivery_unverified 死循环
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
      // 最终再判一次是否 BOSS 拦截（而非单纯加载慢）
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
      throw new Error('chat-not-ready: 点击沟通后 25s 内聊天页未就绪');
    }
    await sleep(500);
    const sent = await cdp.eval(`(async()=>{
      const hasDialog = [...document.querySelectorAll('button,a,span')].some(x => /已沟通过|沟通新职位/.test(x.innerText || ''));
      if (hasDialog) {
        const cancelBtn = [...document.querySelectorAll('button,a,span')].find(x => (x.innerText || '').trim() === '取消');
        if (cancelBtn) cancelBtn.click();
        return { error: 'already-communicated' };
      }
      const msg=${JSON.stringify(message)};
      // 发送前再关一次可能遮挡输入框的“号码隐私保护”安全弹窗
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
      await new Promise(r=>setTimeout(r,2200));
      const rows=[...document.querySelectorAll('.last-msg')].filter(x=>(x.querySelector('.last-msg-text')?.innerText||'').trim()===msg);
      const row=rows.at(-1);
      const state=row?.querySelector('.message-status');
      return {inputEmpty:(input.innerText||'').trim()==='',exactMessageCount:rows.length,sameRowStatus:(state?.innerText||'').trim(),sameRowStatusClass:String(state?.className||''),companyVisible:document.body.innerText.includes(${JSON.stringify(job.company || actual.structured.company)})}
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
  const input = process.argv[3] || arg('url');
  const id = jobIdOf(input) || input;
  const ledger = loadLedger();
  const job = ledger.jobs.find(x => x.jobId === id);
  if (!job) throw new Error(`台账中没有岗位 ${id}`);
  const message = process.env.MSG || arg('message') || job.opener?.message;
  if (!message) throw new Error('缺少已保存的开场白，请先运行 save-opener');
  if (job.opener?.jdHash && job.opener.jdHash !== job.jd?.hash) throw new Error('开场白绑定的 JD 已变化，禁止发送');
  return sendMessage(job.url, message);
}

function showOpenerContext() {
  const input = process.argv[3] || arg('url');
  const id = jobIdOf(input) || input;
  const ledger = loadLedger();
  const index = ledger.jobs.findIndex(x => x.jobId === id);
  const job = index >= 0 ? hydrateLegacyStructured(ledger.jobs[index]) : null;
  if (!job) throw new Error(`台账中没有岗位 ${id}`);
  ledger.jobs[index] = job;
  assertAgentReady(ledger, job);
  console.log(JSON.stringify(openerContext(job, arg('profile')), null, 2));
}

function saveOpener() {
  const input = process.argv[3] || arg('url');
  const id = jobIdOf(input) || input;
  const ledger = loadLedger();
  const index = ledger.jobs.findIndex(x => x.jobId === id);
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

function review() {
  const id = process.argv[3] || '';
  const ledger = loadLedger();
  const job = ledger.jobs.find(x => x.jobId === id);
  if (!job) throw new Error(`台账中没有岗位 ${id}`);
  for (const field of ['remote', 'pay', 'risk']) {
    const status = arg(field);
    if (!status) continue;
    if (!['pending', 'pass', 'fail'].includes(status)) throw new Error(`${field} 只能是 pending/pass/fail`);
    const evidence = arg(`${field}-evidence`) || job.review[field]?.evidence || '';
    if (status !== 'pending' && !String(evidence).trim()) throw new Error(`${field} 为 ${status} 时必须提供证据`);
    job.review[field] = { status, evidence };
    addDecision(job, `jd_${field}`, status === 'fail' ? 'reject' : status, `${field}_review`, `${field} 审核为 ${status}`, evidence);
  }
  if (arg('next')) job.nextAction = arg('next');
  saveLedger(ledger);
  console.log(`${id}: remote=${job.review.remote.status}, pay=${job.review.pay.status}, risk=${job.review.risk.status}`);
}

function company() {
  const name = process.argv[3] || '';
  if (!name) throw new Error('缺少公司名');
  const ledger = loadLedger();
  const existing = ledger.companies.find(x => x.name === name) || { name };
  Object.assign(existing, { status: arg('status') || existing.status || 'pending', evidence: arg('evidence') || existing.evidence || '', url: arg('url') || existing.url || '', checkedAt: now() });
  if (!ledger.companies.includes(existing)) ledger.companies.push(existing);
  saveLedger(ledger);
  console.log(`${name}: ${existing.status}`);
}

function approve() {
  if (PREFERENCES.mode === 'autopilot') throw new Error('省心模式不需要逐条批准');
  const id = process.argv[3] || '';
  const ledger = loadLedger();
  const job = ledger.jobs.find(x => x.jobId === id);
  if (!job) throw new Error(`台账中没有岗位 ${id}`);
  if (job.jd?.status !== 'read') throw new Error('必须先读取完整 JD');
  job.approval = { status: 'approved', approvedAt: now() };
  addDecision(job, 'approval', 'pass', 'user_approved', '用户已明确批准该岗位进入发送流程', '');
  saveLedger(ledger);
  console.log(`APPROVED ${id}`);
}

function selfTest() {
  const firstProfile = Object.entries(PROFILES)[0];
  assert(firstProfile, 'preferences.json 至少需要一个岗位方向');
  const [firstProfileId, firstProfileValue] = firstProfile;
  const firstKeyword = firstProfileValue.titleKeywords?.[0];
  assert(firstKeyword, '岗位方向至少需要一个 titleKeywords');
  assert.equal(jobIdOf('https://www.zhipin.com/job_detail/abc_123.html'), 'abc_123');
  assert.deepEqual(verifyFrom([{ verify: { inputEmpty: true, hasMyMsg: true, hasSongda: true } }]), { inputEmpty: true, hasMyMsg: true, hasSongda: true });
  const parsed = parseJobBody('招聘中\nAI全栈开发 20-40K\n公司基本信息\n某公司\n职位描述\n支持全程远程办公');
  assert.deepEqual(parsed, { title: 'AI全栈开发', company: '某公司', salary: '20-40K', remoteEvidence: '支持全程远程办公' });
  assert.equal(conversationStatus({ lastMessage: '暂时不考虑远程亲' }), 'closed');
  assert.equal(conversationStatus({ lastMessage: '可以先看下样片嘛' }), 'needs_reply');
  assert.deepEqual(sentVerification({ inputEmpty: true, exactMessageCount: 1, sameRowStatusClass: 'message-status status-delivery', companyVisible: true }), { inputEmpty: true, exactMessage: true, sameRowDelivered: true, companyVisible: true });
  assert.equal(Object.values(sentVerification({ inputEmpty: true, exactMessageCount: 2, sameRowStatusClass: 'status-delivery', companyVisible: true })).every(Boolean), false);
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
  preScreenJob(screenLedger, lowPay, { title: firstKeyword, text: `${firstKeyword} 0-1元/时` });
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
  ready.review = { remote: { status: 'pass' }, pay: { status: 'pass' }, risk: { status: 'pass' } };
  ready.approval = { status: 'approved' };
  assert.doesNotThrow(() => assertSendReady(ready));
  console.log('SELF_TEST_OK');
}

const commands = {
  import: importLegacy, validate, check, replies, interactions, profile, profiles, search, candidates,
  read: readJob, review, approve, 'opener-context': showOpenerContext, 'save-opener': saveOpener, send,
  company, 'company-jobs': companyJobs, list, 'self-test': selfTest,
};
const command = process.argv[2];
if (!commands[command]) {
  console.log('用法: node scripts/boss.js <check|replies|interactions|profile|profiles|search|candidates|read|review|approve|opener-context|save-opener|send|company|company-jobs|list|import|validate|self-test>');
  process.exit(command ? 1 : 0);
}
if (['check', 'replies', 'interactions', 'profile', 'search', 'read', 'review', 'approve', 'opener-context', 'save-opener', 'send', 'company', 'company-jobs'].includes(command)) {
  assertConfigured();
}
Promise.resolve(commands[command]()).catch(error => { console.error(`ERROR: ${error.message}`); process.exit(1); });
