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

// 审核所需的最小载荷：agent 判断 fit/location/pay/risk 需要的字段 + JD 正文，一次给全。
// 没有这个出口时，agent 想审岗必须先看 JD，想看 JD（opener-context）又必须先审完岗，
// 唯一出路是直接去读 data/ledger.json——而台账每个岗位约 5KB，几百个岗位就足以塞爆上下文。
// 这个函数存在的意义就是让"读台账"永远没有必要。
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

// 离线复看已读过的 JD，不联网、不占速率闸门。
// 用于 agent 上下文被压缩后重新拿回某个岗位的正文，而不是去翻台账。
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



// 只识别无法在当前页面关闭的硬性拦截；"完善在线简历"的"好的"提示会在发送页内关闭后继续。
function detectSendBlock(text) {
  if (!text) return '';
  if (/交换(微信|手机号)|请先绑定(微信|手机)|先交换/.test(text)) return 'BOSS 要求先交换联系方式才能沟通';
  return '';
}

// brief=true 时省掉 userProfile 和 description 两个字段。
// 这两块在一轮工作流里都是重复内容：JD 正文 agent 刚在 read --jd 里看过，
// 事实档案（profile.md）整个 session 一个字都不会变，却被每个岗位重发一次——
// 处理几十个岗位时，光这两项就占掉总载荷的一半以上。
// brief 模式要求调用方确保 profile.md 已在本 session 加载过一次。
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
