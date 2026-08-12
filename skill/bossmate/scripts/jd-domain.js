const crypto = require('crypto');
const { activityRank, assessRemote, normalizeJob } = require('./job-domain');

function parseJobBody(body) {
  const lines = String(body || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  const recruiting = lines.indexOf('招聘中');
  const titleSalary = recruiting >= 0 ? lines[recruiting + 1] || '' : '';
  const companyAt = lines.indexOf('公司基本信息');
  const company = companyAt >= 0 ? lines[companyAt + 1] || '' : '';
  const salary = titleSalary.match(/(?:\d+(?:\.\d+)?-\d+(?:\.\d+)?K(?:·\d+薪)?|\d+-\d+元\/(?:时|天|月))/i)?.[0] || '';
  const title = salary ? titleSalary.slice(0, titleSalary.indexOf(salary)).trim() : titleSalary;
  const remoteEvidence = assessRemote(title, body).evidence;
  return { title, company, salary, remoteEvidence };
}

function normalizeBenefits(benefits) {
  return String(benefits || '')
    .split(/[、,，\s]+/)
    .map(value => value.trim())
    .filter(Boolean)
    .sort()
    .join('、');
}

function jdHashOf(structured) {
  return crypto.createHash('sha256').update(JSON.stringify({
    title: structured.title || '',
    company: structured.company || '',
    description: structured.description || '',
    benefits: normalizeBenefits(structured.benefits),
    address: structured.address || '',
    experience: structured.experience || '',
    education: structured.education || '',
  })).digest('hex');
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
  const remoteEvidence = assessRemote(structured.title, structured.description).evidence;
  return { structured, remoteEvidence, hash: jdHashOf(structured) };
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
module.exports = {
  parseJobBody, normalizeBenefits, jdHashOf, normalizeStructuredPage,
  assertReadableDescription, hydrateLegacyStructured,
};

