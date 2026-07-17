// Minimal Chrome DevTools Protocol client for a user-controlled, logged-in browser.
// Requires Node.js 22+ for the built-in WebSocket implementation.
const http = require('http');

function httpJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } }); }).on('error', reject);
  });
}

class CDP {
  constructor(port = 9222) { this.port = port; this.ws = null; this.id = 0; this.pending = new Map(); }

  // 连到当前打开的目标站点页面（不新建标签，复用现有登录态页面）。
  // match 默认匹配 zhipin（BOSS）；多平台采集可传字符串(includes)或函数(t=>bool)。
  async connectPage(match = 'zhipin.com') {
    const tabs = await httpJson(`http://127.0.0.1:${this.port}/json`);
    const test = typeof match === 'function' ? match : (t => (t.url || '').includes(match));
    const page = tabs.find(t => t.type === 'page' && test(t));
    if (!page) throw new Error(`未找到匹配的已打开页面（match=${typeof match === 'function' ? 'fn' : match}）。先确认 19222 上的 Chrome 已打开对应站点并登录。`);
    await new Promise((res, rej) => {
      this.ws = new WebSocket(page.webSocketDebuggerUrl);
      this.ws.addEventListener('open', res, { once: true });
      this.ws.addEventListener('error', rej, { once: true });
      this.ws.addEventListener('message', event => {
        const msg = JSON.parse(event.data);
        const cb = this.pending.get(msg.id);
        if (cb) { this.pending.delete(msg.id); cb(msg); }
      });
    });
    this.page = page;
    return page;
  }

  _cmd(method, params) {
    return new Promise(resolve => {
      const id = ++this.id;
      this.pending.set(id, resolve);
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  // 在页面里求值一段 JS（支持 await Promise）。返回 returnByValue 的值。
  async eval(expr, timeoutMs = 25000) {
    const cmd = this._cmd('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('CDP eval timeout')), timeoutMs));
    const msg = await Promise.race([cmd, timeout]);
    if (msg.result && msg.result.exceptionDetails) {
      throw new Error('JS 异常: ' + JSON.stringify(msg.result.exceptionDetails).slice(0, 300));
    }
    return msg.result && msg.result.result ? msg.result.result.value : undefined;
  }

  // 页面内导航（用 location.href，不需要 enable Page 域）
  async navigate(url) { await this.eval(`location.href=${JSON.stringify(url)};'ok'`); }

  close() { try { this.ws && this.ws.close(); } catch {} }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
// Bounded jitter prevents synchronized requests. It is not a safety bypass.
const rnd = (a, b) => {
  const u = (Math.random() + Math.random() + Math.random()) / 3;
  let v = a + (b - a) * u;
  if (Math.random() < 0.05) v += 2000 + Math.random() * 3000;
  return v;
};

// ── 浏览器级标签管理（HTTP，不需要 ws）──
// 实测：被反复导航过、带 _security_check 的旧标签页进聊天会被弹回首页；
// 用全新标签页打开聊天则稳定不跳。所以发送一律新开标签。
function _http(method, path, port) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method }, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => resolve(d)); });
    req.on('error', reject); req.end();
  });
}
async function openTab(url, port = 9222) {
  const raw = await _http('PUT', '/json/new?' + encodeURIComponent(url), port);
  const tab = JSON.parse(raw);
  await _http('GET', '/json/activate/' + tab.id, port).catch(() => {}); // 尽量前台
  const cdp = new CDP(port);
  await new Promise((res, rej) => {
    cdp.ws = new WebSocket(tab.webSocketDebuggerUrl);
    cdp.ws.addEventListener('open', res, { once: true });
    cdp.ws.addEventListener('error', rej, { once: true });
    cdp.ws.addEventListener('message', event => {
      const msg = JSON.parse(event.data);
      const cb = cdp.pending.get(msg.id);
      if (cb) { cdp.pending.delete(msg.id); cb(msg); }
    });
  });
  cdp.tabId = tab.id;
  return cdp;
}
function closeTab(tabId, port = 9222) { return _http('GET', '/json/close/' + tabId, port).catch(() => {}); }

// 连到已打开的匹配页面；若一个都没有，则自动新开 fallbackUrl 页面并连上。
// 省掉"必须先手动开好某站点页面"的前置麻烦（如智联：任意 zhaopin.com 页面都带登录 cookie）。
// 返回 { cdp, opened }；opened=true 表示是脚本新开的标签，调用方可决定是否收尾 closeTab。
async function connectOrOpen(match, fallbackUrl, port = 9222) {
  const tabs = await httpJson(`http://127.0.0.1:${port}/json`);
  const test = typeof match === 'function' ? match : (t => (t.url || '').includes(match));
  if (tabs.find(t => t.type === 'page' && test(t))) {
    const cdp = new CDP(port);
    await cdp.connectPage(match);
    return { cdp, opened: false };
  }
  const cdp = await openTab(fallbackUrl, port);
  return { cdp, opened: true };
}

module.exports = { CDP, httpJson, sleep, rnd, openTab, closeTab, connectOrOpen };
