const { PROFILES, PREFERENCES, MIN_HOURLY_PAY, REVIEW_FIELDS, now } = require('./runtime-config');

function blankJob(id, url = '') {
  return {
    jobId: id, url: url || `https://www.zhipin.com/job_detail/${id}.html`, title: '', company: '', salary: '', sources: [],
    discovery: { firstSeenAt: '', lastSeenAt: '', query: '', page: 0 },
    preScreen: { status: 'unknown', profile: '', score: 0, activityRank: 0, reasons: [], checkedAt: '' },
    decisions: [],
    jd: { status: 'unknown', evidencePath: '', remoteHint: '', hash: '', structured: null },
    review: Object.fromEntries(REVIEW_FIELDS.map(field => [field, { status: 'pending', evidence: '' }])),
    opener: { status: 'none', message: '', profile: '', jdHash: '', generatedAt: '', generator: '' },
    outreach: { status: 'not_sent', message: '', evidencePath: '', verify: null },
    reply: { status: 'unknown', lastMessage: '', checkedAt: '' }, nextAction: '',
  };
}

function normalizeJob(job) {
  const base = blankJob(job.jobId, job.url);
  const { remote: legacyRemote, ...currentReview } = job.review || {};
  return {
    ...base,
    ...job,
    discovery: { ...base.discovery, ...(job.discovery || {}) },
    preScreen: { ...base.preScreen, ...(job.preScreen || {}) },
    decisions: Array.isArray(job.decisions) ? job.decisions : [],
    jd: { ...base.jd, ...(job.jd || {}) },
    review: {
      ...currentReview,
      fit: { ...base.review.fit, ...(job.review?.fit || {}) },
      // 兼容旧台账：旧版 remote 审核结论等同于新版的地点/办公方式审核。
      location: { ...base.review.location, ...(job.review?.location || legacyRemote || {}) },
      pay: { ...base.review.pay, ...(job.review?.pay || {}) },
      risk: { ...base.review.risk, ...(job.review?.risk || {}) },
    },
    opener: { ...base.opener, ...(job.opener || {}) },
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



function preScreenJob(ledger, job, card = {}, requestedProfile = '') {
  const parsed = parseSearchCard(card);
  if (!job.title && parsed.title) job.title = parsed.title;
  if (!job.salary && parsed.salary) job.salary = parsed.salary;
  const profile = matchProfile(job.title, parsed.text, requestedProfile);
  const reasons = [];
  let status = 'review';
  let score = 0;
  const contacted = priorContactReason(ledger, job);
  const defaultRedlines = ['贷款', '收费', '传销'];
  const hardExclusions = [...defaultRedlines, ...(Array.isArray(PREFERENCES.requirements?.hardExclusions) ? PREFERENCES.requirements.hardExclusions : [])];
  const obviousRedline = hardExclusions.find(word => includesKeyword(job.title, word));
  if (!job.title || /查看更多|查看详情|立即沟通/.test(job.title)) {
    status = 'review';
    reasons.push({ code: 'missing_list_title', message: '列表链接缺少可用标题，放到队尾人工确认', evidence: parsed.text.slice(0, 100) });
  } else if (contacted) {
    status = 'reject';
    reasons.push({ code: 'prior_contact', message: contacted, evidence: contacted });
  } else if (obviousRedline) {
    status = 'reject';
    reasons.push({ code: 'title_redline', message: '岗位标题命中明确红线', evidence: obviousRedline });
  } else if (!profile) {
    status = 'reject';
    reasons.push({ code: 'direction_mismatch', message: '标题和列表信息未命中配置的岗位方向', evidence: job.title });
  } else {
    score += 30;
    reasons.push({ code: 'direction_match', message: `命中${PROFILES[profile].label}`, evidence: job.title });
    const remotePolicy = String(PREFERENCES.requirements?.remotePolicy || '').trim();
    const remoteRequested = /远程|居家|线上/.test(remotePolicy) && !/不限|不要求|无要求|可到岗|线下/.test(remotePolicy);
    if (remoteRequested && /远程|居家|线上/.test(parsed.text)) {
      score += 30;
      status = 'priority';
      reasons.push({ code: 'remote_hint', message: '用户配置要求远程，列表出现远程信号，仍需完整 JD 核实', evidence: parsed.text.match(/.{0,12}(?:远程|居家|线上).{0,12}/)?.[0] || '' });
    } else if (remoteRequested) {
      status = 'review';
      reasons.push({ code: 'remote_unknown', message: '用户配置要求远程，列表没有远程证据，完整 JD 前排在远程信号之后', evidence: '' });
    } else {
      status = 'priority';
      reasons.push({ code: 'location_to_review', message: '工作地点和办公方式按用户配置在完整 JD 中核实', evidence: '' });
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

const REMOTE_POSITIVE = /全程远程|全职远程|远程办公|居家办公|居家工作|线上办公|线上协作|接受远程|支持远程|可远程|可居家|远程工作|远程兼职|远程项目/;
const REMOTE_NEGATIVE = /不支持远程|不接受远程|不能远程|无法远程|必须到岗|需到岗|需要到岗|现场办公|驻场办公|线下坐班|必须坐班|仅限本地到岗/;
const REMOTE_TITLE = /远程|居家|线上办公|线上协作/;
const REMOTE_PRODUCT_TERM = /远程(?:诊断|车控|驾驶|运维|控制|监控|调试)/;

function assessRemote(title = '', description = '') {
  const bodyLines = String(description || '').split(/\r?\n|(?<=[。；])/).map(x => x.trim()).filter(Boolean);
  const negative = bodyLines.find(x => REMOTE_NEGATIVE.test(x));
  if (negative) return { status: 'fail', evidence: negative, source: 'body' };
  const bodyPositive = bodyLines.find(x => REMOTE_POSITIVE.test(x) && !/远程面试/.test(x));
  if (bodyPositive) return { status: 'pass', evidence: bodyPositive, source: 'body' };
  const cleanTitle = String(title || '').replace(/远程面试/g, '');
  if (REMOTE_TITLE.test(cleanTitle) && !REMOTE_PRODUCT_TERM.test(cleanTitle)) return { status: 'pass', evidence: String(title).trim(), source: 'title' };
  return { status: 'pending', evidence: '', source: '' };
}
module.exports = {
  blankJob, normalizeJob, addDecision, activityRank, includesKeyword, matchProfile,
  parseSearchCard, preScreenJob, recruiterFromButton, conversationKey,
  priorContactReason, ensureJob, assessRemote,
};

