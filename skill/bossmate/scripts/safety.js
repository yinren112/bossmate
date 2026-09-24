const fs = require('fs');
const path = require('path');
const { DATA_DIR, LEDGER_FILE, PORT, DEFAULT_CDP_PORT, now, rel } = require('./runtime-config');
const { loadLedger } = require('./ledger-store');
const { arg, hasFlag } = require('./cli-args');

// ── Randomized pacing: all waits use a random range, never a fixed constant ──
// A fixed wait interval is easy to distinguish from normal, organic usage; varying the interval
// keeps traffic gentle on the service and reduces the odds of tripping the site's rate limits.
const sleepMs = ms => new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
const rndInt = (lo, hi) => lo + Math.floor(Math.random() * (Math.max(hi, lo) - lo + 1));
const humanPause = (lo, hi) => sleepMs(rndInt(lo, hi));

const WINDOW_24H = 24 * 60 * 60 * 1000;
const WINDOW_10MIN = 10 * 60 * 1000;
// Slow down automatically at night instead of blocking outright: this keeps overall traffic
// lighter during off-peak hours without forcibly interrupting a user who genuinely works late.
const NIGHT_START_HOUR = 23; // 23:00
const NIGHT_END_HOUR = 9;    // 09:00
const NIGHT_PACE = 2;        // Night: double the minimum gap, halve the burst limit; 24h total unchanged
const isNightHour = (date = new Date()) => { const h = date.getHours(); return h >= NIGHT_START_HOUR || h < NIGHT_END_HOUR; };
const paceMultiplier = (date = new Date()) => (isNightHour(date) ? NIGHT_PACE : 1);

// ── Account-level circuit-breaker lock and safety-page detection ──
const LOCK_FILE = path.join(DATA_DIR, `lock.${PORT}.json`);
const LEGACY_LOCK_FILE = path.join(DATA_DIR, 'lock.json');
const BUDGET_FILE = path.join(DATA_DIR, `budget.${PORT}.json`);
// BOSS keeps a `_security_check=...` param around after a security review passes; the bare
// substring alone is not evidence of a restriction.
const SECURITY_PAGE_RE = /captcha|verify|\/403\.html|[?&]code=(32|36|37)(?:&|$)|\/web\/passport\/|账户存在异常行为|暂时限制访问|访问受限/i;
const SECURITY_JS_EXPR = "(location.href.includes('/403.html')||/[?&]code=(32|36|37)(&|$)/.test(location.href)||location.href.includes('/web/passport/')||!!document.querySelector('.security-check,.verify-wrap,.captcha')||/账户存在异常行为|暂时限制访问|访问受限/.test(document.body.innerText||''))";
// These signals mean the site's own restriction system has already flagged the account once;
// it is not an ordinary load failure or page glitch. Continuing to browse the same day after one
// of these appears is the pattern most associated with an account-level restriction that follows.
const SEVERE_LOCK_RE = /code=(?:32|36|37)|访问受限|账户存在异常|暂时限制访问|环境存在异常/;
const ONLINE_COMMANDS = new Set([
  'check', 'replies', 'interactions', 'profile', 'favorites', 'favorites-next',
  'recommendations', 'recommendations-next', 'recommendations-close',
  'search', 'search-next', 'search-close', 'read', 'send', 'verify-delivery', 'company-jobs',
]);
const MAX_CONSECUTIVE_EMPTY_JD = 3;

// ── 24-hour rolling rate gate ──
// Job-detail-page reads in the low thousands per day are commonly associated with restrictions
// on this kind of site; staying well under that with a comfortable margin is the safer default.
// hardCeiling24h below already includes that margin — it is a fuse, not a target to run up to.
// Normal operation should sit well under softLimit24h; only raise it after several days of
// stable, unrestricted use.
// Of the three gates, exceeding the 24h total or the 10-minute density gate rejects the action
// outright; only "gap between two actions too short" waits automatically instead of failing —
// that's a pacing issue, not an anomaly, so it shouldn't hard-fail the script.
const RATE_LIMITS = {
  searchPages: { softLimit24h: 30, hardCeiling24h: 120, burstLimit10min: 6, minGapMs: 15000 },
  jobReads: { softLimit24h: 300, hardCeiling24h: 900, burstLimit10min: 40, minGapMs: 8000 },
  sends: { softLimit24h: 30, hardCeiling24h: 150, burstLimit10min: 6, minGapMs: 25000 },
};

// Only used on first upgrade, to migrate existing ledger timestamps into the budget file.
function recentTimestamps(ledger, kind) {
  if (kind === 'jobReads') return (ledger.jobs || []).flatMap(j => [j.jd?.checkedAt, j.jd?.liveCheckedAt]).filter(Boolean);
  if (kind === 'searchPages') return (ledger.runs || []).filter(r => r.type === 'search').map(r => r.at).filter(Boolean);
  if (kind === 'sends') return (ledger.jobs || []).map(j => j.outreach?.sentAt).filter(Boolean);
  return [];
}

const matchSecurityPage = text => SECURITY_PAGE_RE.test(String(text || ''));

function loadLock(file = LOCK_FILE) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  if (file === LOCK_FILE) {
    try {
      const legacy = JSON.parse(fs.readFileSync(LEGACY_LOCK_FILE, 'utf8'));
      if (legacy && (Number(legacy.port) || DEFAULT_CDP_PORT) === PORT) return { ...legacy, fromLegacyFile: true };
    } catch {}
  }
  return { locked: false };
}

function writeLock(reason, evidence = '', file = LOCK_FILE) {
  const lock = { locked: true, port: PORT, reason, evidence: String(evidence).slice(0, 500), lockedAt: now() };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(lock, null, 2));
  return lock;
}

function assertNotLocked(file = LOCK_FILE) {
  const lock = loadLock(file);
  if (lock.locked) throw new Error(`账号熔断锁定中：${lock.reason}（${lock.lockedAt}）。禁止任何在线动作，人工确认后用 unlock --reason=说明 解除`);
}

function throwSecurity(reason, evidence = '', file = LOCK_FILE) {
  writeLock(reason, evidence, file);
  throw new Error(`${reason}，已停止并写入熔断锁 ${rel(LOCK_FILE)}；人工确认前所有在线命令拒绝运行`);
}

// A platform-level restriction signal (code=32/36/37, access-restricted, etc.) cannot be
// unlocked the same day it fires: the pattern most associated with a follow-on restriction is
// continuing to browse a few more times after the signal appears, not the single request itself.
// Ordinary errors (e.g. a load failure that `check` happens to notice) are not subject to this
// and can be unlocked at any time.
function unlockRefusal(previous, at = Date.now()) {
  if (!previous?.locked) return '';
  if (!SEVERE_LOCK_RE.test(`${previous.reason || ''} ${previous.evidence || ''}`)) return '';
  const lockedAt = Date.parse(previous.lockedAt || '') || 0;
  if (!lockedAt) return '';
  const sameDay = new Date(lockedAt).toDateString() === new Date(at).toDateString();
  if (!sameDay && at - lockedAt >= WINDOW_24H) return '';
  const earliest = new Date(lockedAt + WINDOW_24H).toLocaleString();
  return `平台级风控信号当天不得解锁续跑：${previous.reason}，锁定于 ${previous.lockedAt}，最早可解锁 ${earliest}。确需提前解锁请加 --override-severe-lock 参数并自负风险`;
}

// Note: this flag only bypasses the same-day cooldown on a restriction-level lock. It does not
// touch send, dedup, or delivery-verification gates — those never had, and shouldn't have, a
// bypass switch.
function unlock() {
  const reason = arg('reason');
  if (!reason) throw new Error('解锁必须由人工给出 --reason=说明');
  const previous = loadLock();
  const overrideCooldown = hasFlag('override-severe-lock');
  const refusal = unlockRefusal(previous);
  if (refusal && !overrideCooldown) throw new Error(refusal);
  fs.writeFileSync(LOCK_FILE, JSON.stringify({
    locked: false, port: PORT, unlockedAt: now(), unlockReason: reason,
    ...(overrideCooldown && refusal ? { cooldownOverride: refusal } : {}),
    previousLock: previous.locked ? previous : null,
  }, null, 2));
  console.log(`已解锁：${reason}${previous.locked ? `（上次锁定：${previous.reason} @ ${previous.lockedAt}）` : '（此前无锁定）'}`);
  if (overrideCooldown && refusal) console.log(`⚠ 已用 --override-severe-lock 越过冷静期：${refusal}`);
}

function loadBudget(file = BUDGET_FILE) {
  let budget;
  try { budget = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  if (!budget || !Array.isArray(budget.events)) {
    budget = { port: PORT, consecutiveEmptyJd: 0, events: [] };
    if (file === BUDGET_FILE && fs.existsSync(LEDGER_FILE)) {
      const ledger = loadLedger();
      for (const kind of Object.keys(RATE_LIMITS)) {
        for (const at of recentTimestamps(ledger, kind)) budget.events.push({ kind, at, detail: 'migrated-from-ledger' });
      }
      budget.consecutiveEmptyJd = ledger.safety?.consecutiveEmptyJd || 0;
    }
  }
  const floor = Date.now() - 2 * WINDOW_24H;
  budget.events = budget.events.filter(x => (Date.parse(x?.at) || 0) >= floor);
  return budget;
}

function saveBudget(budget, file = BUDGET_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ ...budget, port: PORT, updatedAt: now() }, null, 2));
}

function budgetCountWithin(budget, kind, windowMs, at = Date.now()) {
  const floor = at - windowMs;
  return (budget.events || []).filter(x => x.kind === kind && (Date.parse(x.at) || 0) >= floor).length;
}

function lastActionAt(budget) {
  const times = (budget.events || []).map(x => Date.parse(x.at) || 0);
  return times.length ? Math.max(...times) : 0;
}

// Record the action before it goes online; a failed request still counts against the quota.
// A send also pre-records one job-detail-page read alongside it.
async function reserveAction(kind, detail = '', file = BUDGET_FILE, alsoCount = [], lockFile = LOCK_FILE) {
  const budget = loadBudget(file);
  const pace = paceMultiplier();
  for (const each of [kind, ...alsoCount]) {
    const limits = RATE_LIMITS[each];
    if (!limits) continue;
    const used = budgetCountWithin(budget, each, WINDOW_24H);
    if (used >= limits.hardCeiling24h) throwSecurity(`${each} 触到平台硬顶：24 小时内已 ${used}/${limits.hardCeiling24h}`, 'hard-ceiling', lockFile);
    if (used >= limits.softLimit24h) throw new Error(`24 小时滚动额度已用完：${each} ${used}/${limits.softLimit24h}，等窗口滑出再继续；不为凑数继续访问`);
  }
  const limits = RATE_LIMITS[kind];
  if (!limits) return budget;
  const burstAllowed = Math.max(1, Math.floor(limits.burstLimit10min / pace));
  const used10min = budgetCountWithin(budget, kind, WINDOW_10MIN);
  if (used10min >= burstAllowed) throw new Error(`10 分钟突发上限：${kind} ${used10min}/${burstAllowed}${pace > 1 ? '（深夜减半）' : ''}，先歇一会儿再继续`);
  const gap = limits.minGapMs * pace;
  const since = Date.now() - lastActionAt(budget);
  if (gap && lastActionAt(budget) && since < gap) {
    const wait = rndInt(gap - since, gap - since + Math.round(gap * 0.5));
    console.error(`[节流] 距上次动作 ${Math.round(since / 1000)}s，等待约 ${Math.round(wait / 1000)}s${pace > 1 ? '（深夜减半）' : ''}`);
    await sleepMs(wait);
  }
  const fresh = loadBudget(file);
  const at = now();
  for (const each of [kind, ...alsoCount]) fresh.events.push({ kind: each, detail, at, night: isNightHour() });
  saveBudget(fresh, file);
  return fresh;
}

function noteEmptyJd(message, file = BUDGET_FILE) {
  const budget = loadBudget(file);
  budget.consecutiveEmptyJd = (budget.consecutiveEmptyJd || 0) + 1;
  saveBudget(budget, file);
  if (budget.consecutiveEmptyJd >= MAX_CONSECUTIVE_EMPTY_JD) {
    throwSecurity(`连续 ${budget.consecutiveEmptyJd} 次空白/受限 JD（${message}）`, 'consecutive-empty-jd');
  }
}

function resetEmptyJd(file = BUDGET_FILE) {
  const budget = loadBudget(file);
  if (budget.consecutiveEmptyJd) { budget.consecutiveEmptyJd = 0; saveBudget(budget, file); }
}


module.exports = {
  PORT, LOCK_FILE, BUDGET_FILE, SECURITY_JS_EXPR, ONLINE_COMMANDS, RATE_LIMITS,
  WINDOW_24H, WINDOW_10MIN, NIGHT_PACE, sleepMs, rndInt, humanPause, isNightHour,
  paceMultiplier, matchSecurityPage, loadLock, writeLock, assertNotLocked, throwSecurity,
  unlockRefusal, unlock, loadBudget, saveBudget, budgetCountWithin, lastActionAt, reserveAction,
  noteEmptyJd, resetEmptyJd,
};
