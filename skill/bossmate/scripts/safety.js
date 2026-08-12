const fs = require('fs');
const path = require('path');
const { DATA_DIR, LEDGER_FILE, PORT, now, rel } = require('./runtime-config');
const { loadLedger } = require('./ledger-store');
const { arg, hasFlag } = require('./cli-args');

// ── 拟人节奏：所有等待都用随机区间，不用固定常数 ──
// 固定间隔的等待是脚本化访问最容易被识别的特征之一——真人不会连续两次停顿完全相同的毫秒数。
const sleepMs = ms => new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
const rndInt = (lo, hi) => lo + Math.floor(Math.random() * (Math.max(hi, lo) - lo + 1));
const humanPause = (lo, hi) => sleepMs(rndInt(lo, hi));

const WINDOW_24H = 24 * 60 * 60 * 1000;
const WINDOW_10MIN = 10 * 60 * 1000;
// 深夜时段自动减速而不是禁止：既降低连续高强度访问的风险特征，也不强行打断用户自己的作息。
const NIGHT_START_HOUR = 23; // 23:00
const NIGHT_END_HOUR = 9;    // 09:00
const NIGHT_PACE = 2;        // 深夜最小间隔翻倍、突发上限减半；24 小时总额度不变
const isNightHour = (date = new Date()) => { const h = date.getHours(); return h >= NIGHT_START_HOUR || h < NIGHT_END_HOUR; };
const paceMultiplier = (date = new Date()) => (isNightHour(date) ? NIGHT_PACE : 1);

// ── 账号级熔断锁与安全检测 ──
const LOCK_FILE = path.join(DATA_DIR, `lock.${PORT}.json`);
const LEGACY_LOCK_FILE = path.join(DATA_DIR, 'lock.json');
const BUDGET_FILE = path.join(DATA_DIR, `budget.${PORT}.json`);
// BOSS 会在安全复核通过后保留 `_security_check=...` 参数；裸子串不是风控证据。
const SECURITY_PAGE_RE = /captcha|verify|\/403\.html|[?&]code=(32|36|37)(?:&|$)|\/web\/passport\/|账户存在异常行为|暂时限制访问|访问受限/i;
const SECURITY_JS_EXPR = "(location.href.includes('/403.html')||/[?&]code=(32|36|37)(&|$)/.test(location.href)||location.href.includes('/web/passport/')||!!document.querySelector('.security-check,.verify-wrap,.captcha')||/账户存在异常行为|暂时限制访问|访问受限/.test(document.body.innerText||''))";
// 这些信号代表平台自己的风控已经判定过一次，而不是普通的加载失败或页面异常；
// 出现后当天继续访问正是多起真实受限事件里共同的失败路径（信号出现后又继续访问几次，随后升级为账号级限制）。
const SEVERE_LOCK_RE = /code=(?:32|36|37)|访问受限|账户存在异常|暂时限制访问|环境存在异常/;
const ONLINE_COMMANDS = new Set([
  'check', 'replies', 'interactions', 'profile', 'favorites', 'favorites-next',
  'recommendations', 'recommendations-next', 'recommendations-close',
  'search', 'search-next', 'search-close', 'read', 'send', 'verify-delivery', 'company-jobs',
]);
const MAX_CONSECUTIVE_EMPTY_JD = 3;

// ── 24 小时滚动速率闸门 ──
// 真实受限案例里，详情页阅读量在同一账号单日约 1000 次左右就会触发访问限制，
// 而对照的低量账号（几百次/日）当天没有异常；发送侧观察到的量级在 150 上下。
// 下面的 hardCeiling24h 是留出安全余量后的保险丝，不是"可以放心用满"的目标值；
// 日常运行应该长期停在 softLimit24h 以下，只有账号观察稳定几天后再考虑上调。
// 三层闸门里，总量（24h）和密度（10min）超限会直接拒绝；只有"两次动作间隔不够"
// 会自动等待补足，不会报错——间隔问题是节奏问题，不是异常，不该让脚本直接失败。
const RATE_LIMITS = {
  searchPages: { softLimit24h: 30, hardCeiling24h: 120, burstLimit10min: 6, minGapMs: 15000 },
  jobReads: { softLimit24h: 300, hardCeiling24h: 900, burstLimit10min: 40, minGapMs: 8000 },
  sends: { softLimit24h: 30, hardCeiling24h: 150, burstLimit10min: 6, minGapMs: 25000 },
};

// 仅用于第一次升级时把现有台账时间戳迁入预算文件。
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
      if (legacy && (Number(legacy.port) || 9222) === PORT) return { ...legacy, fromLegacyFile: true };
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

// 平台级风控信号（code=32/36/37、访问受限等）当天不得解锁续跑：真实受限事件的共同失败路径
// 就是"信号出现后继续访问几次"，而不是单次请求本身。普通异常（如 check 偶然发现的加载失败）
// 不受此限制，可以随时解锁。
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

// 注意：这个开关只越过"风控级熔断当天冷静期"，不涉及发送、去重或送达核验任何一道门禁——
// 那几道门禁本来就没有、也不该有绕过开关。
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

// 在联网前预记动作；失败访问也会占用平台额度。发送会连带预记一次详情页读取。
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
