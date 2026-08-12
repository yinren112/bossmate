const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { ROOT, ARCHIVE, REVIEW_FIELDS, now, rel } = require('./runtime-config');
const { jobIdOf } = require('./cli-args');
const { loadLedger, saveLedger } = require('./ledger-store');
const { normalizeJob, conversationKey } = require('./job-domain');
const { hydrateLegacyStructured, parseJobBody } = require('./jd-domain');
const { verifyFrom } = require('./delivery-verification');
const JD_GARBAGE_RE = /微信扫码登录|扫码登录|请先登录|登录后查看|登录查看完整内容|手机验证码登录|密码登录/;

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

function migrateJd() {
  const ledger = loadLedger();
  const result = { alreadyStructured: 0, recovered: 0, markedUnknown: 0 };
  ledger.jobs = ledger.jobs.map(original => {
    if (original.jd?.structured?.description) {
      result.alreadyStructured++;
      return normalizeJob(original);
    }
    const migrated = hydrateLegacyStructured(original);
    if (migrated.jd?.structured?.description) {
      result.recovered++;
      migrated.jd.status = 'read';
      migrated.jd.migratedAt = now();
      return migrated;
    }
    if (migrated.jd?.status === 'read') {
      migrated.jd.status = 'unknown';
      migrated.jd.migrationNote = '历史记录没有可恢复的 JD 正文，需要首次在线读取';
      result.markedUnknown++;
    }
    return migrated;
  });
  saveLedger(ledger);
  console.log(JSON.stringify(result, null, 2));
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
        fit: { status: 'pending', evidence: '' },
        location: { status: 'pending', evidence: '' },
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

function validate({ quiet = false } = {}) {
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
    if (job.jd?.status === 'read' && JD_GARBAGE_RE.test(job.jd?.structured?.description || '')) errors.push(`疑似登录页垃圾 JD: ${job.jobId}`);
    if (/^delivered/.test(job.outreach?.status || '')) {
      const v = job.outreach.verify || {};
      const validLegacy = v.inputEmpty && v.hasMyMsg && v.hasSongda;
      const validCurrent = v.inputEmpty && v.identityMatched && v.delivered && v.companyVisible;
      const validV02 = v.inputEmpty && v.exactMessage && v.sameRowDelivered && v.companyVisible;
      if (!(validLegacy || validCurrent || validV02)) errors.push(`送达核验不完整: ${job.jobId}`);
    }
  }
  const conversationKeys = new Set();
  for (const conversation of ledger.conversations) {
    const key = conversationKey(conversation);
    if (conversationKeys.has(key)) errors.push(`重复会话身份: ${key}`);
    conversationKeys.add(key);
  }
  assert.equal(errors.length, 0, errors.join('\n'));
  const summary = { jobs: ledger.jobs.length, conversations: ledger.conversations.length, companies: ledger.companies.length };
  if (!quiet) console.log(`VALID ${summary.jobs} jobs / ${summary.conversations} conversations / ${summary.companies} companies`);
  return summary;
}



module.exports = { migrateJd, importLegacy, validate };
