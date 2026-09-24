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
const DEFAULT_CDP_PORT = 9222;
const PORT = Number(process.env.BOSS_CDP_PORT || PREFERENCES.browser?.port || DEFAULT_CDP_PORT);
const CITY_CODE = String(PREFERENCES.search?.cityCode || '100010000');
const MIN_HOURLY_PAY = Number(PREFERENCES.requirements?.minimumHourlyPay || 0);
const RESUMES = PREFERENCES.resumes || { files: [], profileMapping: {} };
const REVIEW_FIELDS = ['fit', 'location', 'pay', 'risk'];

const now = () => new Date().toISOString();
const rel = file => path.relative(ROOT, file).replace(/\\/g, '/');

module.exports = {
  ROOT, ARCHIVE, DATA_DIR, LEDGER_FILE, FACTS_FILE, PREFERENCES_FILE,
  PREFERENCES, PROFILES, PORT, DEFAULT_CDP_PORT, CITY_CODE, MIN_HOURLY_PAY, RESUMES, REVIEW_FIELDS,
  now, rel,
};
