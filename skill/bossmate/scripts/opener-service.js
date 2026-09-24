const fs = require('fs');
const { FACTS_FILE, PREFERENCES, PROFILES, REVIEW_FIELDS, rel } = require('./runtime-config');
const { includesKeyword, matchProfile, priorContactReason } = require('./job-domain');
const { arg, jobIdOf } = require('./cli-args');
const { loadLedger } = require('./ledger-store');
const { hydrateLegacyStructured } = require('./jd-domain');

function validateOpener(message) {
  const value = String(message || '').replace(/^["“]|["”]$/g, '').replace(/\s+/g, ' ').trim();
  const minLength = Number(PREFERENCES.opener?.minLength || 20);
  const maxLength = Number(PREFERENCES.opener?.maxLength || 180);
  if (value.length < minLength || value.length > maxLength) throw new Error(`开场白长度必须在 ${minLength}–${maxLength} 字之间`);
  const bannedClaims = Array.isArray(PREFERENCES.opener?.bannedClaims) ? PREFERENCES.opener.bannedClaims : [];
  const banned = bannedClaims.find(claim => includesKeyword(value, claim));
  if (banned) throw new Error(`开场白含用户禁止声称的经历：${banned}`);
  if (/https?:\/\/|www\./i.test(value)) throw new Error('开场白不得主动附带链接');
  return value;
}

function assertSendReady(job) {
  if (job.jd?.status !== 'read' || job.jd?.liveStatus === 'partial' || !job.jd?.structured?.description || job.jd.structured.incomplete) throw new Error('未读取完整结构化 JD');
  for (const field of REVIEW_FIELDS) {
    if (job.review?.[field]?.status !== 'pass') throw new Error(`${field} 尚未通过审核`);
  }
  if (job.outreach?.status !== 'not_sent') throw new Error(`该岗位状态为 ${job.outreach?.status || 'unknown'}，禁止再次发送`);
}

function assertAgentReady(ledger, job) {
  assertSendReady(job);
  const reason = priorContactReason(ledger, job);
  if (reason) throw new Error(reason);
}

// The minimal payload needed for review: the fields the agent needs to judge
// fit/location/pay/risk, plus the JD body, given all at once.
// Without this, reviewing a job requires reading the JD first, and reading the JD
// (opener-context) requires the review to be done first - the only way out would be
// reading data/ledger.json directly, and at ~5KB per job the ledger can blow the
// context with just a few hundred jobs. This function exists so "read the ledger"
// is never necessary.
function reviewPayload(job) {
  const structured = job.jd?.structured || {};
  return {
    jobId: job.jobId,
    title: job.title,
    company: job.company,
    salary: job.salary || structured.salary || '',
    experience: structured.experience || '',
    education: structured.education || '',
    remoteHint: job.jd?.remoteHint || '',
    recruiterActive: job.recruiter?.activeText || '',
    jdStatus: job.jd?.status || 'unknown',
    descriptionChars: String(structured.description || '').length,
    description: structured.description || '',
    benefits: structured.benefits || '',
    review: Object.fromEntries(REVIEW_FIELDS.map(k => [k, job.review?.[k]?.status || 'pending'])),
    outreachStatus: job.outreach?.status || 'not_sent',
  };
}

// Offline re-read of a JD already fetched - no network call, no rate limit usage.
// Used to recover a job's body after the agent's context gets compressed, instead of digging through the ledger.
function showJd() {
  const input = process.argv[3] || arg('url');
  const id = jobIdOf(input) || input;
  const ledger = loadLedger();
  const index = ledger.jobs.findIndex(x => x.jobId === id);
  const job = index >= 0 ? hydrateLegacyStructured(ledger.jobs[index]) : null;
  if (!job) throw new Error(`台账中没有岗位 ${id}`);
  if (!String(job.jd?.structured?.description || '').trim()) throw new Error(`岗位 ${id} 尚无完整 JD 正文，请先运行 read`);
  console.log(JSON.stringify(reviewPayload(job), null, 2));
}



// Only flags hard blocks that can't be dismissed on the current page; the "complete your online resume" / "OK" prompt gets dismissed inline and the flow continues.
function detectSendBlock(text) {
  if (!text) return '';
  if (/交换(微信|手机号)|请先绑定(微信|手机)|先交换/.test(text)) return 'BOSS 要求先交换联系方式才能沟通';
  return '';
}

// With brief=true, drop the userProfile and description fields.
// Both are duplicated within a single workflow: the agent just saw the JD body
// in read --jd, and the fact profile (profile.md) never changes within a session
// yet gets resent for every job - across a few dozen jobs these two alone make up
// more than half the total payload.
// Brief mode requires the caller to have already loaded profile.md once this session.
function buildOpenerContext(job, profileId, brief = false) {
  const profile = PROFILES[profileId] || PROFILES[matchProfile(job.title, job.jd?.structured?.description || '')];
  if (!profile) throw new Error('岗位未匹配用户配置的求职方向，不能生成开场白');
  const structured = job.jd?.structured || {};
  const context = {
    instruction: brief
      ? '根据本 session 已加载的用户事实档案（profile.md）和下述岗位信息撰写首次沟通开场白。只使用用户已确认的事实，不虚构任何经历，不写链接。'
      : '根据用户事实档案和岗位 JD 撰写首次沟通开场白。只使用用户已确认的事实，不虚构任何经历，不写链接。',
    profile: { id: profileId, label: profile.label, factFocus: profile.factFocus || '' },
    job: {
      jobId: job.jobId, title: job.title, company: job.company,
      salary: job.salary || structured.salary || '', experience: structured.experience || '',
      education: structured.education || '',
      ...(brief ? {} : { description: structured.description }),
      benefits: structured.benefits || '',
    },
    ...(brief ? { userProfileSource: rel(FACTS_FILE) } : { userProfile: fs.readFileSync(FACTS_FILE, 'utf8') }),
    openerRules: PREFERENCES.opener || {},
  };
  return context;
}

function openerContext(job, requestedProfile = '', brief = false) {
  if (job.jd?.status !== 'read' || !job.jd?.structured?.description || job.jd.structured.incomplete) throw new Error('未读取完整结构化 JD');
  const profileId = matchProfile(job.title, job.jd.structured.description, requestedProfile || job.preScreen?.profile);
  return buildOpenerContext(job, profileId, brief);
}


module.exports = {
  validateOpener, assertSendReady, assertAgentReady,
  reviewPayload, showJd, detectSendBlock, buildOpenerContext, openerContext,
};
