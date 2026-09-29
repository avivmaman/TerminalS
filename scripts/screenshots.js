'use strict';

// Captures the README screenshots into docs/screenshots/. Windows only (the
// shells come from ConPTY). Seeds demo history, pins and settings into
// %APPDATA%\TerminalS, so it only runs on a throwaway machine such as CI:
//
//   npm i --no-save playwright-core
//   set CI=1 && node scripts/screenshots.js
//
// With OPENROUTER_API_KEY set it also captures the AI suggestion picker.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { _electron: electron } = require('playwright-core');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'screenshots');
const DATA = path.join(process.env.APPDATA || '', 'TerminalS');
const DEMO = 'C:\\Projects\\web-app';

if (process.platform !== 'win32') throw new Error('Screenshots need Windows.');
if (!process.env.CI) throw new Error(`This overwrites ${DATA}. Set CI=1 to run it on a throwaway machine.`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function seed() {
  // A small git project for the prompt, the history panel and the guard's branch check.
  fs.mkdirSync(path.join(DEMO, 'src'), { recursive: true });
  fs.writeFileSync(path.join(DEMO, 'package.json'), JSON.stringify({ name: 'web-app', version: '1.0.0', scripts: { dev: 'vite', build: 'vite build', test: 'vitest' } }, null, 2));
  fs.writeFileSync(path.join(DEMO, 'README.md'), '# web-app\n');
  fs.writeFileSync(path.join(DEMO, 'src', 'main.ts'), 'console.log("hello");\n');
  const git = (...args) => execFileSync('git', args, { cwd: DEMO, stdio: 'ignore' });
  git('init', '-b', 'main');
  git('-c', 'user.name=Demo', '-c', 'user.email=demo@example.com', 'add', '.');
  git('-c', 'user.name=Demo', '-c', 'user.email=demo@example.com', 'commit', '-m', 'Initial commit');

  fs.rmSync(DATA, { recursive: true, force: true });
  fs.mkdirSync(DATA, { recursive: true });
  const now = Date.now();
  const commands = [
    ['git clone https://github.com/example/web-app.git', 'C:\\Projects', 0],
    ['cd web-app', 'C:\\Projects', 0],
    ['npm install', DEMO, 0],
    ['npm run dev', DEMO, 0],
    ['git checkout -b feature/login', DEMO, 0],
    ['npm test', DEMO, 1],
    ['npm test -- --watch', DEMO, 0],
    ['docker compose up -d', DEMO, 0],
    ['git add -A', DEMO, 0],
    ['git commit -m "Add login form"', DEMO, 0],
    ['git push -u origin feature/login', DEMO, 0],
    ['Get-ChildItem -Recurse -Filter *.log | Remove-Item', DEMO, 0],
    ['npm run build', DEMO, 0],
  ];
  const history = commands.map(([command, cwd, exitCode], i) => ({
    id: `hdemo${i}`, command, cwd, shell: 'pwsh', ts: now - (commands.length - i) * 7 * 60000, exitCode,
  }));
  const pins = ['npm run dev', 'docker compose up -d', 'git pull --rebase'].map((command, i) => ({
    id: `pdemo${i}`, command, shell: 'pwsh', cwd: DEMO, ts: now,
  }));
  const settings = { psreadlineImported: true, bashImported: true, defaultShell: 'pwsh' };
  if (process.env.OPENROUTER_API_KEY) settings.ai = { provider: 'openrouter', openrouter: { model: process.env.OPENROUTER_MODEL || 'anthropic/claude-sonnet-5' } };
  fs.writeFileSync(path.join(DATA, 'history.json'), JSON.stringify(history));
  fs.writeFileSync(path.join(DATA, 'pins.json'), JSON.stringify(pins));
  fs.writeFileSync(path.join(DATA, 'settings.json'), JSON.stringify(settings));
}

async function main() {
  seed();
  fs.mkdirSync(OUT, { recursive: true });
  const app = await electron.launch({ args: [ROOT], cwd: ROOT });
  const page = await app.firstWindow();
  await page.waitForSelector('#terminals .xterm', { timeout: 30000 });
  await sleep(4000); // shell start-up and profile

  const shot = async (name) => {
    await sleep(600);
    await page.screenshot({ path: path.join(OUT, `${name}.png`) });
    console.log(`saved ${name}.png`);
  };
  // Esc dismisses ghost text / the picker; PSReadLine's Esc reverts the line.
  const clearLine = async () => {
    await page.keyboard.press('Escape');
    await sleep(200);
    await page.keyboard.press('Escape');
    await sleep(200);
  };
  const run = async (command, wait = 1500) => {
    await page.keyboard.type(command, { delay: 15 });
    await page.keyboard.press('Enter');
    await sleep(wait);
  };

  await page.click('#terminals');
  await run(`cd ${DEMO}`);
  await run('clear', 800);
  await run('git status');
  await run('git log --oneline');
  await run('Get-ChildItem');
  await shot('main');

  // Ghost text from history.
  await page.keyboard.type('npm r', { delay: 60 });
  await shot('ghost-text');
  await clearLine();

  // Safety guard: checked locally, nothing runs.
  await page.keyboard.type('git reset --hard HEAD~3', { delay: 15 });
  await page.keyboard.press('Enter');
  await page.waitForSelector('#guard-dialog[open]');
  await shot('safety-guard');
  await page.keyboard.press('Escape');
  await sleep(300);
  await clearLine();

  if (process.env.OPENROUTER_API_KEY) {
    await page.keyboard.type('# find the 5 largest files here', { delay: 15 });
    await page.keyboard.press('Control+Space');
    await page.waitForSelector('.picker-head .provider', { timeout: 30000 }).catch(() => {});
    await sleep(1500);
    await shot('ai-picker');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Control+K');
  }

  await page.click('#btn-settings');
  await page.waitForSelector('#settings-dialog[open]');
  await page.click('.settings-seg [data-tab="ai"]');
  await shot('settings');
  await page.keyboard.press('Escape');

  await page.click('#btn-profiles');
  await page.waitForSelector('#profiles-dialog[open]');
  await shot('environment');
  await page.keyboard.press('Escape');

  await app.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
