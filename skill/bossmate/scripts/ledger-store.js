const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { DATA_DIR, LEDGER_FILE, now } = require('./runtime-config');
const WRITE_LOCK_FILE = path.join(DATA_DIR, 'ledger.write.lock');
const emptyLedger = () => ({ version: 2, updatedAt: now(), jobs: [], conversations: [], interactions: [], companies: [], runs: [], safety: { consecutiveEmptyJd: 0 } });

function loadLedger() {
  const ledger = fs.existsSync(LEDGER_FILE)
    ? { ...emptyLedger(), ...JSON.parse(fs.readFileSync(LEDGER_FILE, 'utf8')) }
    : emptyLedger();
  Object.defineProperty(ledger, '_loadedUpdatedAt', { value: ledger.updatedAt, writable: true, enumerable: false });
  return ledger;
}

function saveLedger(ledger) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  let lockFd;
  const temporaryFile = `${LEDGER_FILE}.tmp.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        lockFd = fs.openSync(WRITE_LOCK_FILE, 'wx');
        fs.writeFileSync(lockFd, JSON.stringify({ pid: process.pid, at: now() }));
        break;
      } catch (error) {
        if (error.code === 'EEXIST') {
          try {
            if (Date.now() - fs.statSync(WRITE_LOCK_FILE).mtimeMs > 5 * 60 * 1000) {
              fs.unlinkSync(WRITE_LOCK_FILE);
              continue;
            }
          } catch {}
        }
        if (error.code !== 'EEXIST' || attempt >= 20) throw new Error('台账正被另一条命令写入，请等待该命令结束后重试');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
      }
    }
    if (fs.existsSync(LEDGER_FILE)) {
      const currentUpdatedAt = JSON.parse(fs.readFileSync(LEDGER_FILE, 'utf8')).updatedAt;
      if (ledger._loadedUpdatedAt && currentUpdatedAt !== ledger._loadedUpdatedAt) throw new Error('台账已被另一条命令更新，本次旧快照未写入；请重新执行当前命令');
    }
    ledger.version = 2;
    ledger.updatedAt = now();
    fs.writeFileSync(temporaryFile, JSON.stringify(ledger, null, 2) + '\n', 'utf8');
    for (let attempt = 0; ; attempt++) {
      try {
        fs.renameSync(temporaryFile, LEDGER_FILE);
        ledger._loadedUpdatedAt = ledger.updatedAt;
        break;
      } catch (error) {
        if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 4) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100 * (attempt + 1));
      }
    }
  } finally {
    if (fs.existsSync(temporaryFile)) fs.unlinkSync(temporaryFile);
    if (lockFd !== undefined) fs.closeSync(lockFd);
    if (lockFd !== undefined && fs.existsSync(WRITE_LOCK_FILE)) fs.unlinkSync(WRITE_LOCK_FILE);
  }
}

module.exports = { LEDGER_FILE, loadLedger, saveLedger };
