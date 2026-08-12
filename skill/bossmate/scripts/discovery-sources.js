const fs = require('fs');
const path = require('path');
const { DATA_DIR, PORT, CITY_CODE, PROFILES, now } = require('./runtime-config');
const { arg, positional, hasFlag, jobIdOf } = require('./cli-args');
const { loadLedger, saveLedger } = require('./ledger-store');
const { ensureJob, parseSearchCard, preScreenJob, priorContactReason } = require('./job-domain');
const { reserveAction, SECURITY_JS_EXPR, throwSecurity } = require('./safety');
const { waitForSearchResults } = require('./page-flows');
const cdpLib = () => require('./cdp');

const FAVORITES_SESSION_FILE = path.join(DATA_DIR, `favorites-session.${PORT}.json`);
const RECOMMEND_SESSION_FILE = path.join(DATA_DIR, `recommend-session.${PORT}.json`);
const SEARCH_SESSION_FILE = path.join(DATA_DIR, `search-session.${PORT}.json`);
const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; } };
const writeJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
const removeFile = file => { try { fs.unlinkSync(file); } catch {} };

async function extractLinks(cdp) {
  const raw = await cdp.eval(`JSON.stringify([...document.querySelectorAll('a[href*="/job_detail/"]')].filter(a=>{try{const p=new URL(a.href).pathname;return /\\/job_detail\\/[\\w~-]+\\.html$/.test(p)&&a.offsetParent!==null&&!a.closest('header,.zp-header,footer,.footer')}catch{return false}}).map(a=>{const card=a.closest('li,.job-card-wrapper,.job-card-box,.job-list-box')||a.parentElement;return {url:a.href,title:(a.innerText||'').replace(/\\s+/g,' ').trim(),text:(card?.innerText||a.innerText||'').replace(/\\s+/g,' ').trim()}}))`);
  const unique = new Map();
  for (const link of JSON.parse(raw || '[]')) {
    const id = jobIdOf(link.url);
    if (id && !unique.has(id)) unique.set(id, link);
  }
  return [...unique.values()];
}

function storeLinks(links, source, runType, profile = '') {
  const ledger = loadLedger();
  let fresh = 0;
  const counts = { priority: 0, review: 0, reject: 0 };
  for (const link of links) {
    const id = jobIdOf(link.url);
    const existed = ledger.jobs.some(job => job.jobId === id);
    const job = ensureJob(ledger, id, link.url);
    const parsed = parseSearchCard(link);
    if (!job.title) job.title = parsed.title || link.title;
    if (!job.salary) job.salary = parsed.salary;
    job.sources = [...new Set([...(job.sources || []), source])];
    job.discovery = { ...job.discovery, lastSeenAt: now() };
    const screened = preScreenJob(ledger, job, link, profile);
    counts[screened.status] = (counts[screened.status] || 0) + 1;
    if (!existed) fresh++;
  }
  ledger.runs.push({ id: `${runType}-${Date.now()}`, type: runType, source, profile: profile || 'auto', found: links.length, fresh, counts, at: now() });
  saveLedger(ledger);
  return { found: links.length, fresh, counts, ids: links.map(link => jobIdOf(link.url)) };
}

async function search() {
  const query = positional() || arg('query');
  const profile = arg('profile');
  if (!query) throw new Error('需要搜索词');
  if (profile && !PROFILES[profile]) throw new Error(`未知岗位方向 ${profile}`);
  if (Number(arg('page') || 1) !== 1) throw new Error('搜索页 URL 参数不会真正翻页；请先运行 search，再用 search-next');
  await reserveAction('searchPages', `${query} 第1批`);
  const { openTab } = cdpLib();
  const cdp = await openTab(`https://www.zhipin.com/web/geek/jobs?query=${encodeURIComponent(query)}&city=${encodeURIComponent(CITY_CODE)}`, PORT);
  try {
    const state = await waitForSearchResults(cdp);
    if (state.security) throwSecurity('搜索页进入安全验证', `${query} 第1批`);
    const links = await extractLinks(cdp);
    if (!links.length) throw new Error('搜索页没有真实岗位卡片');
    const result = storeLinks(links, `search:${query}`, 'search', profile);
    writeJson(SEARCH_SESSION_FILE, { tabId: cdp.tabId, query, profile, page: 1, signature: state.signature, seenIds: result.ids, updatedAt: now() });
    console.log(JSON.stringify({ ...result, query, page: 1, continuation: 'node scripts/boss.js search-next', close: 'node scripts/boss.js search-close', tabId: cdp.tabId }, null, 2));
  } finally {
    cdp.close();
  }
}

async function searchNext() {
  const session = readJson(SEARCH_SESSION_FILE);
  if (!session.tabId || !session.query) throw new Error('没有可继续的搜索会话；请先运行 search');
  const { CDP, listTabs, closeTab } = cdpLib();
  const tab = (await listTabs(PORT)).find(item => item.id === session.tabId);
  if (!tab) { removeFile(SEARCH_SESSION_FILE); throw new Error('上次搜索标签已关闭；请重新运行 search'); }
  const cdp = new CDP(PORT);
  try {
    await cdp.connectTarget(tab);
    const before = await waitForSearchResults(cdp);
    if (before.security) throwSecurity('搜索页进入安全验证', session.query);
    const page = Number(session.page || 1) + 1;
    await reserveAction('searchPages', `${session.query} 第${page}批`);
    const movement = await cdp.eval(`(()=>{const visible=x=>x&&x.offsetParent!==null;const disabled=x=>x.matches?.('[disabled],.disabled,.is-disabled')||x.getAttribute?.('aria-disabled')==='true'||/disabled/.test(String(x.className||''));const next=[...document.querySelectorAll('a,button,li,span')].filter(visible).find(x=>/^(下一页|下一页 >|>)$/.test((x.innerText||x.getAttribute?.('aria-label')||'').trim())&&x.closest('[class*="pag"],[class*="page"],nav,ul'));if(next&&!disabled(next)){next.click();return 'page';}window.scrollTo(0,document.body.scrollHeight);return 'waterfall';})()`);
    const after = await waitForSearchResults(cdp, 15000, before.signature);
    if (after.security) throwSecurity('搜索页进入安全验证', session.query);
    if (!after.signature || after.signature === before.signature) {
      await closeTab(session.tabId, PORT); removeFile(SEARCH_SESSION_FILE);
      console.log(JSON.stringify({ query: session.query, end: true, reason: '职位集合未变化', closed: true }, null, 2));
      return;
    }
    const seen = new Set(session.seenIds || []);
    const visible = await extractLinks(cdp);
    const links = movement === 'waterfall' ? visible.filter(link => !seen.has(jobIdOf(link.url))) : visible;
    if (!links.length) {
      await closeTab(session.tabId, PORT); removeFile(SEARCH_SESSION_FILE);
      console.log(JSON.stringify({ query: session.query, end: true, reason: '没有新增真实岗位', closed: true }, null, 2));
      return;
    }
    const result = storeLinks(links, `search:${session.query}`, 'search', session.profile || '');
    writeJson(SEARCH_SESSION_FILE, { ...session, page, signature: after.signature, seenIds: [...new Set([...(session.seenIds || []), ...result.ids])], updatedAt: now() });
    console.log(JSON.stringify({ ...result, query: session.query, page, movement, continuation: 'node scripts/boss.js search-next' }, null, 2));
  } finally {
    cdp.close();
  }
}

async function searchClose() {
  const session = readJson(SEARCH_SESSION_FILE);
  if (session.tabId) await cdpLib().closeTab(session.tabId, PORT);
  removeFile(SEARCH_SESSION_FILE);
  console.log(JSON.stringify({ closed: !!session.tabId, tabId: session.tabId || '', query: session.query || '' }, null, 2));
}

async function favorites(requestedPage = '') {
  const page = Number(requestedPage || arg('page') || 1);
  if (!Number.isInteger(page) || page < 1) throw new Error('--page 必须是正整数');
  await reserveAction('searchPages', `收藏岗位 第${page}页`);
  const { openTab, closeTab } = cdpLib();
  const cdp = await openTab(`https://www.zhipin.com/web/geek/recommend?tab=4&sub=1&page=${page}&tag=4`, PORT);
  try {
    await cdp.waitFor(`document.querySelectorAll('a[href*="personal_interest_job_"]').length>0||/暂无收藏|没有收藏|还没有收藏/.test(document.body?.innerText||'')`, { timeoutMs: 18000, description: '收藏岗位卡片' });
    const meta = await cdp.eval(`(()=>{const visible=x=>x&&x.offsetParent!==null;const pages=[...document.querySelectorAll('a[href^="javascript"]')].filter(visible).map(x=>Number((x.innerText||'').trim())).filter(Number.isFinite);return {url:location.href,security:${SECURITY_JS_EXPR},totalPages:Math.max(1,...pages)}})()`);
    if (meta.security) throwSecurity('收藏列表页进入安全验证', meta.url || '');
    const links = (await extractLinks(cdp)).filter(link => /[?&]ka=personal_interest_job_/i.test(link.url));
    const ledger = loadLedger();
    let session = readJson(FAVORITES_SESSION_FILE);
    if (page === 1 || !session.scanId) {
      for (const job of ledger.jobs) job.sources = (job.sources || []).filter(source => !source.startsWith('favorite:scan:'));
      session = { scanId: String(Date.now()), page: 0, totalPages: Number(meta.totalPages || 1), ids: [], startedAt: now() };
    } else if (page !== Number(session.page || 0) + 1) {
      throw new Error(`收藏扫描应继续第 ${Number(session.page || 0) + 1} 页`);
    }
    const source = `favorite:scan:${session.scanId}`;
    for (const link of links) {
      const job = ensureJob(ledger, jobIdOf(link.url), link.url);
      const parsed = parseSearchCard(link);
      if (!job.title) job.title = parsed.title || link.title;
      if (!job.salary) job.salary = parsed.salary;
      job.sources = [...new Set([...(job.sources || []), source])];
      preScreenJob(ledger, job, link);
    }
    session = { ...session, page, totalPages: Math.max(session.totalPages || 1, meta.totalPages || 1), ids: [...new Set([...(session.ids || []), ...links.map(link => jobIdOf(link.url))])], updatedAt: now() };
    const complete = session.page >= session.totalPages;
    if (complete) {
      const current = new Set(session.ids);
      for (const job of ledger.jobs) {
        job.sources = (job.sources || []).filter(item => item !== 'favorite:current' && !item.startsWith('favorite:scan:'));
        if (current.has(job.jobId)) job.sources.push('favorite:current');
      }
      removeFile(FAVORITES_SESSION_FILE);
    } else writeJson(FAVORITES_SESSION_FILE, session);
    saveLedger(ledger);
    console.log(JSON.stringify({ page, totalPages: session.totalPages, found: links.length, accumulated: session.ids.length, complete, nextCommand: complete ? 'node scripts/boss.js favorite-status' : 'node scripts/boss.js favorites-next' }, null, 2));
  } finally {
    cdp.close();
    await closeTab(cdp.tabId, PORT);
  }
}

async function favoritesNext() {
  const session = readJson(FAVORITES_SESSION_FILE);
  if (!session.scanId || !session.page) throw new Error('没有可继续的收藏扫描；请先运行 favorites --page=1');
  return favorites(Number(session.page) + 1);
}

function favoriteStatus() {
  const ledger = loadLedger();
  const rows = ledger.jobs.filter(job => (job.sources || []).includes('favorite:current')).map(job => {
    const reason = priorContactReason(ledger, job);
    return { jobId: job.jobId, title: job.title, company: job.company, status: reason ? 'continuing' : 'first_contact', reason };
  });
  const limit = hasFlag('full') ? rows.length : Math.min(100, Number(arg('limit') || 20));
  console.log(JSON.stringify({ total: rows.length, rows: rows.slice(0, limit) }, null, 2));
}

function favoriteQueue() {
  const ledger = loadLedger();
  const rows = ledger.jobs.filter(job => (job.sources || []).includes('favorite:current') && job.outreach?.status === 'not_sent')
    .map(job => ({ jobId: job.jobId, title: job.title, company: job.company, jdStatus: job.jd?.status || 'unread', opener: job.opener?.status || 'none' }));
  const limit = hasFlag('full') ? rows.length : Math.min(100, Number(arg('limit') || 20));
  console.log(JSON.stringify({ total: rows.length, showing: Math.min(limit, rows.length), rows: rows.slice(0, limit) }, null, 2));
}

async function recommendations() {
  await reserveAction('searchPages', '推荐职位 第1批');
  const { openTab } = cdpLib();
  const cdp = await openTab('https://www.zhipin.com/web/geek/jobs', PORT);
  try {
    const state = await waitForSearchResults(cdp);
    if (state.security) throwSecurity('推荐职位页进入安全验证', state.url || '');
    const links = await extractLinks(cdp);
    if (!links.length) throw new Error('推荐职位页没有真实岗位卡片');
    const result = storeLinks(links, 'recommendation:current', 'recommendation');
    writeJson(RECOMMEND_SESSION_FILE, { tabId: cdp.tabId, page: 1, signature: state.signature, seenIds: result.ids, updatedAt: now() });
    console.log(JSON.stringify({ ...result, page: 1, continuation: 'node scripts/boss.js recommendations-next', tabId: cdp.tabId }, null, 2));
  } finally {
    cdp.close();
  }
}

async function recommendationsNext() {
  const session = readJson(RECOMMEND_SESSION_FILE);
  if (!session.tabId) throw new Error('没有可继续的推荐职位会话；请先运行 recommendations');
  const { CDP, listTabs, closeTab } = cdpLib();
  const tab = (await listTabs(PORT)).find(item => item.id === session.tabId);
  if (!tab) { removeFile(RECOMMEND_SESSION_FILE); throw new Error('上次推荐职位标签已关闭；请重新运行 recommendations'); }
  const cdp = new CDP(PORT);
  try {
    await cdp.connectTarget(tab);
    await reserveAction('searchPages', `推荐职位 第${Number(session.page || 1) + 1}批`);
    await cdp.eval(`window.scrollTo(0,document.body.scrollHeight);true`);
    const state = await waitForSearchResults(cdp, 15000, session.signature);
    if (state.security) throwSecurity('推荐职位页进入安全验证', state.url || '');
    if (!state.signature || state.signature === session.signature) {
      await closeTab(session.tabId, PORT); removeFile(RECOMMEND_SESSION_FILE);
      console.log(JSON.stringify({ end: true, reason: '推荐职位集合未变化', closed: true }, null, 2));
      return;
    }
    const seen = new Set(session.seenIds || []);
    const links = (await extractLinks(cdp)).filter(link => !seen.has(jobIdOf(link.url)));
    if (!links.length) {
      await closeTab(session.tabId, PORT); removeFile(RECOMMEND_SESSION_FILE);
      console.log(JSON.stringify({ end: true, reason: '没有新增真实岗位', closed: true }, null, 2));
      return;
    }
    const page = Number(session.page || 1) + 1;
    const result = storeLinks(links, `recommendation:${page}`, 'recommendation');
    writeJson(RECOMMEND_SESSION_FILE, { ...session, page, signature: state.signature, seenIds: [...new Set([...(session.seenIds || []), ...result.ids])], updatedAt: now() });
    console.log(JSON.stringify({ ...result, page, continuation: 'node scripts/boss.js recommendations-next' }, null, 2));
  } finally {
    cdp.close();
  }
}

async function recommendationsClose() {
  const session = readJson(RECOMMEND_SESSION_FILE);
  if (session.tabId) await cdpLib().closeTab(session.tabId, PORT);
  removeFile(RECOMMEND_SESSION_FILE);
  console.log(JSON.stringify({ closed: !!session.tabId, tabId: session.tabId || '' }, null, 2));
}

function jobSources() {
  const ledger = loadLedger();
  const counts = {};
  for (const job of ledger.jobs) for (const source of job.sources || []) counts[source] = (counts[source] || 0) + 1;
  console.log(JSON.stringify({ totalJobs: ledger.jobs.length, sources: Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([source, count]) => ({ source, count })) }, null, 2));
}

module.exports = {
  search, searchNext, searchClose,
  favorites, favoritesNext, favoriteStatus, favoriteQueue,
  recommendations, recommendationsNext, recommendationsClose, jobSources,
};
