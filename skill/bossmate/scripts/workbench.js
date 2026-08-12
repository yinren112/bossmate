const { REVIEW_FIELDS } = require('./runtime-config');
const { priorContactReason, normalizeJob } = require('./job-domain');
const { currentConversations } = require('./conversation-domain');

const reviewsPassed = job => REVIEW_FIELDS.every(field => job.review?.[field]?.status === 'pass');
const reviewFailed = job => REVIEW_FIELDS.some(field => job.review?.[field]?.status === 'fail');
const openerCurrent = job => job.opener?.status === 'generated' && !!job.opener?.message && job.opener?.jdHash === job.jd?.hash;

function nextJobCommand(ledger, job) {
  const id = job.jobId;
  const prior = priorContactReason(ledger, job);
  if (prior) return { stage: 'blocked', reason: prior, command: '' };
  if (!['read', 'partial'].includes(job.jd?.status)) return { stage: 'read', reason: '尚未读取完整 JD', command: `node scripts/boss.js read ${id} --jd` };
  if (job.jd?.status === 'partial') return { stage: 'blocked', reason: 'JD 不完整，需要重新确认页面状态', command: '' };
  if (reviewFailed(job)) return { stage: 'rejected', reason: '至少一项审核未通过', command: '' };
  if (!reviewsPassed(job)) return { stage: 'review', reason: '审核证据尚未齐全', command: `node scripts/boss.js jd ${id}` };
  if (!openerCurrent(job)) return { stage: 'opener', reason: '需要按当前 JD 编写或更新开场白', command: `node scripts/boss.js opener-context ${id} --brief` };
  if (job.outreach?.status === 'delivery_unverified') return { stage: 'verify', reason: '发送结果尚未核实', command: `node scripts/boss.js verify-delivery ${id}` };
  if (job.outreach?.status === 'not_sent') return { stage: 'send', reason: '所有离线材料已就绪', command: `node scripts/boss.js send ${id}` };
  return { stage: 'done', reason: job.outreach?.status || '已处理', command: '' };
}

function jobWorkbenchPayload(ledger, rawJob, { full = false } = {}) {
  const job = normalizeJob(rawJob);
  return {
    job: {
      jobId: job.jobId, title: job.title, company: job.company, salary: job.salary,
      sources: job.sources || [], preScreen: job.preScreen, jd: {
        status: job.jd?.status, hash: job.jd?.hash,
        ...(full ? { structured: job.jd?.structured || {} } : { descriptionPreview: String(job.jd?.structured?.description || '').slice(0, 500) }),
      },
      review: job.review, opener: job.opener, outreach: job.outreach,
    },
    next: nextJobCommand(ledger, job),
  };
}

function nextWorkPayload(ledger) {
  const conversations = currentConversations(ledger)
    .filter(row => ['needs_reply', 'needs_inspect', 'boss_last_review'].includes(row.status))
    .sort((a, b) => Number(b.unread || 0) - Number(a.unread || 0) || Number(b.time || 0) - Number(a.time || 0));
  if (conversations.length) {
    return { lane: 'conversations', item: conversations[0], next: { stage: conversations[0].status, command: 'node scripts/boss.js replies', reason: '当前有待处理会话；公开版尚未提供自动回复或附件发送' } };
  }
  const ranked = (ledger.jobs || []).map(job => ({ job, next: nextJobCommand(ledger, normalizeJob(job)) }))
    .filter(item => !['done', 'rejected', 'blocked'].includes(item.next.stage))
    .sort((a, b) => ['verify', 'send', 'opener', 'review', 'read'].indexOf(a.next.stage) - ['verify', 'send', 'opener', 'review', 'read'].indexOf(b.next.stage));
  return ranked.length ? { lane: 'jobs', ...jobWorkbenchPayload(ledger, ranked[0].job) } : { lane: 'none', next: { stage: 'discover', reason: '本地没有待处理工作', command: 'node scripts/boss.js search "<keyword>" --profile=<profile-id> --page=1' } };
}

function reviewAuditPayload(ledger, limit = 20) {
  const rows = [];
  for (const job of ledger.jobs || []) {
    const issues = [];
    for (const field of REVIEW_FIELDS) {
      const review = job.review?.[field] || {};
      if (review.status === 'pass' && !String(review.evidence || '').trim()) issues.push({ field, code: 'missing_evidence', message: `${field}=pass 但没有证据` });
    }
    if (job.jd?.status === 'read' && !String(job.jd?.structured?.description || '').trim()) issues.push({ field: 'jd', code: 'missing_description', message: 'JD 标记已读但正文为空' });
    if (job.opener?.status === 'generated' && job.opener?.jdHash !== job.jd?.hash) issues.push({ field: 'opener', code: 'stale_opener', message: '开场白不是基于当前 JD' });
    if (issues.length) rows.push({ jobId: job.jobId, title: job.title, company: job.company, issues });
  }
  return { count: rows.length, showing: Math.min(rows.length, limit), rows: rows.slice(0, limit) };
}

module.exports = { jobWorkbenchPayload, nextWorkPayload, reviewAuditPayload };
