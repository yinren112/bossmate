#!/usr/bin/env node
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const argv = process.argv.slice(2);

function value(name) {
  const equal = argv.find(arg => arg.startsWith(`--${name}=`));
  if (equal) return equal.slice(name.length + 3);
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] || '' : '';
}

function help() {
  console.log(`BossMate dedicated browser launcher

Usage:
  node scripts/setup-browser.js [options]

Options:
  --browser=<edge|chrome>  Browser to launch; default: edge
  --port=<number>          CDP port; default: 9222
  --home=<path>            Private workspace; default: ~/.bossmate
  --executable=<path>      Use a specific Edge/Chrome executable
  --dry-run                Validate and print the launch plan without starting
  --help                   Show this help`);
}

function browserCandidates(browser) {
  const programFiles = process.env.ProgramFiles || '';
  const programFilesX86 = process.env['ProgramFiles(x86)'] || '';
  const localAppData = process.env.LOCALAPPDATA || '';
  return browser === 'edge'
    ? [
        path.join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        path.join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        path.join(localAppData, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      ]
    : [
        path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      ];
}

function options() {
  const browser = value('browser') || 'edge';
  if (!['edge', 'chrome'].includes(browser)) throw new Error('--browser must be edge or chrome');
  const port = Number(value('port') || 9222);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error('--port must be an integer from 1024 to 65535');
  }
  const home = path.resolve(value('home') || process.env.BOSSMATE_HOME || process.env.BOSS_JOB_HOME ||
    path.join(os.homedir(), '.bossmate'));
  const requested = value('executable');
  const executable = requested
    ? path.resolve(requested)
    : browserCandidates(browser).find(candidate => candidate && fs.existsSync(candidate));
  if (!executable || !fs.existsSync(executable)) {
    throw new Error(`没有找到 ${browser}。请先安装浏览器，或使用 --executable 指定路径。`);
  }
  return { browser, port, home, executable, dryRun: argv.includes('--dry-run') };
}

async function waitForCdp(port) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 500));
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(1000),
      });
      if (response.ok) return;
    } catch {}
  }
  throw new Error(`浏览器已启动，但调试端口 ${port} 没有就绪。`);
}

async function main() {
  if (argv.includes('--help') || argv.includes('-h')) {
    help();
    return;
  }
  const config = options();
  const profile = path.join(config.home, 'browser-profile');
  const result = {
    browser: config.browser,
    port: config.port,
    profile,
    executable: config.executable,
    dryRun: config.dryRun,
  };
  if (config.dryRun) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  fs.mkdirSync(profile, { recursive: true });
  const child = spawn(config.executable, [
    `--remote-debugging-port=${config.port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    'https://www.zhipin.com/',
  ], { detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();
  await waitForCdp(config.port);
  console.log(JSON.stringify({
    ...result,
    pid: child.pid,
    login: '请用户只在新打开的专用浏览器中登录 BOSS；不要向 Agent 提供密码、短信码或 Cookie。',
  }, null, 2));
}

main().catch(error => {
  console.error(`BossMate browser setup failed: ${error.message}`);
  process.exit(1);
});
