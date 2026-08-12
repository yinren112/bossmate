const fs = require('fs');
const path = require('path');
const { DATA_DIR, PORT, PREFERENCES, RESUMES, now } = require('./runtime-config');

const FILE = path.join(DATA_DIR, `daily-options.${PORT}.json`);
const RESUME_MODES = ['off', 'explicit', 'positive'];

function localDate() {
  const timeZone = PREFERENCES.locale?.timeZone;
  return new Intl.DateTimeFormat('en-CA', timeZone ? { timeZone } : {}).format(new Date());
}

function loadDailyOptions() {
  let value = {};
  try { value = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch {}
  const date = localDate();
  const current = value.date === date;
  const resumeMode = current && RESUME_MODES.includes(value.resumeMode) ? value.resumeMode : 'unset';
  return {
    date,
    resumeMode,
    needsChoice: resumeMode === 'unset',
    configuredResumes: Array.isArray(RESUMES.files) ? RESUMES.files : [],
    profileMapping: RESUMES.profileMapping || {},
    automaticSendingImplemented: false,
    updatedAt: current ? value.updatedAt || '' : '',
  };
}

function saveDailyOptions(mode) {
  if (!RESUME_MODES.includes(mode)) throw new Error(`--resume 只能是 ${RESUME_MODES.join('/')}`);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify({ date: localDate(), resumeMode: mode, updatedAt: now() }, null, 2) + '\n', 'utf8');
  return loadDailyOptions();
}

module.exports = { RESUME_MODES, loadDailyOptions, saveDailyOptions };
