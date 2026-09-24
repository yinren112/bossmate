// Minimal CDP client using Node.js 22+'s built-in WebSocket, no dependencies.
const http = require('http');
const { PORT: DEFAULT_PORT } = require('./runtime-config');

function request(method, requestPath, port = DEFAULT_PORT) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: requestPath, method }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => {
        if (response.statusCode >= 400) {
          reject(new Error(`CDP HTTP ${response.statusCode}: ${body.slice(0, 300)}`));
          return;
        }
        resolve(body);
      });
    });
    req.setTimeout(10000, () => req.destroy(new Error('CDP HTTP timeout')));
    req.on('error', reject);
    req.end();
  });
}

async function httpJson(url) {
  const parsed = new URL(url);
  return JSON.parse(await request('GET', `${parsed.pathname}${parsed.search}`, Number(parsed.port || DEFAULT_PORT)));
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));

class CDP {
  constructor(port = DEFAULT_PORT) {
    this.port = port;
    this.ws = null;
    this.id = 0;
    this.pending = new Map();
    this.page = null;
    this.tabId = '';
  }

  async connectPage(match = 'zhipin.com') {
    const tabs = await listTabs(this.port);
    const test = typeof match === 'function' ? match : tab => (tab.url || '').includes(match);
    const page = tabs.find(test);
    if (!page) throw new Error(`端口 ${this.port} 未找到匹配页面（${typeof match === 'function' ? '自定义条件' : match}）`);
    await this.connectTarget(page);
    return page;
  }

  async connectTarget(page) {
    if (!page?.webSocketDebuggerUrl) throw new Error('CDP 目标缺少 WebSocket 地址');
    if (this.ws) this.close();
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        try { ws.close(); } catch {}
        reject(new Error('CDP WebSocket connect timeout'));
      }, 10000);
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP WebSocket connect failed')); }, { once: true });
    });
    ws.addEventListener('message', event => {
      let message;
      try { message = JSON.parse(String(event.data)); } catch { return; }
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(`CDP ${pending.method}: ${message.error.message || JSON.stringify(message.error)}`));
      else pending.resolve(message.result || {});
    });
    ws.addEventListener('close', () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error(`CDP connection closed during ${pending.method}`));
      }
      this.pending.clear();
    });
    this.ws = ws;
    this.page = page;
    this.tabId = page.id;
  }

  command(method, params = {}, timeoutMs = 25000) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('CDP WebSocket 未连接'));
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timeout after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  _cmd(method, params = {}) {
    return this.command(method, params);
  }

  async eval(expression, timeoutMs = 25000) {
    const result = await this.command('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true, userGesture: true,
    }, timeoutMs);
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'unknown exception';
      throw new Error(`页面 JS 异常: ${detail.slice(0, 500)}`);
    }
    return result.result?.value;
  }

  async navigate(url) {
    try {
      await this.eval(`location.href=${JSON.stringify(url)};'navigating'`);
    } catch (error) {
      await sleep(200);
      const current = await this.eval('location.href').catch(() => '');
      let reached = false;
      try {
        const expectedUrl = new URL(url);
        const currentUrl = new URL(current);
        reached = expectedUrl.origin === currentUrl.origin && expectedUrl.pathname === currentUrl.pathname &&
          [...expectedUrl.searchParams].every(([key, value]) => currentUrl.searchParams.get(key) === value);
      } catch {}
      if (!reached) throw error;
    }
    return 'navigating';
  }

  async waitFor(expression, { timeoutMs = 15000, intervalMs = 250, description = '页面条件' } = {}) {
    const deadline = Date.now() + timeoutMs;
    let lastValue;
    let lastError;
    while (Date.now() < deadline) {
      try {
        lastValue = await this.eval(expression, Math.min(5000, Math.max(1000, deadline - Date.now())));
        if (lastValue) return lastValue;
      } catch (error) {
        lastError = error;
      }
      await sleep(intervalMs);
    }
    const suffix = lastError ? `；最后错误：${lastError.message}` : `；最后结果：${JSON.stringify(lastValue)}`;
    throw new Error(`等待${description}超时 ${timeoutMs}ms${suffix}`);
  }

  close() {
    if (!this.ws) return;
    try { this.ws.close(); } catch {}
    this.ws = null;
  }
}

async function listTabs(port = DEFAULT_PORT) {
  return (await httpJson(`http://127.0.0.1:${port}/json`)).filter(tab => tab.type === 'page');
}

async function openTab(url, port = DEFAULT_PORT) {
  const tab = JSON.parse(await request('PUT', `/json/new?${encodeURIComponent(url)}`, port));
  await request('GET', `/json/activate/${tab.id}`, port).catch(() => {});
  const cdp = new CDP(port);
  await cdp.connectTarget(tab);
  return cdp;
}

async function closeTab(tabId, port = DEFAULT_PORT) {
  if (!tabId) return false;
  await request('GET', `/json/close/${encodeURIComponent(tabId)}`, port).catch(() => {});
  return true;
}

async function activateTab(tabId, port = DEFAULT_PORT) {
  await request('GET', `/json/activate/${encodeURIComponent(tabId)}`, port);
}

async function connectOrOpen(match, fallbackUrl, port = DEFAULT_PORT) {
  const tabs = await listTabs(port);
  const test = typeof match === 'function' ? match : tab => (tab.url || '').includes(match);
  const page = tabs.find(test);
  if (!page) return { cdp: await openTab(fallbackUrl, port), opened: true };
  const cdp = new CDP(port);
  await cdp.connectTarget(page);
  return { cdp, opened: false };
}

module.exports = {
  CDP, DEFAULT_PORT, activateTab, closeTab, connectOrOpen, httpJson, listTabs, openTab, request, sleep,
};
