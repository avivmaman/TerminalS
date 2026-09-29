'use strict';

const path = require('path');
const { app, BrowserWindow, ipcMain, shell, Menu } = require('electron');
const { PtyManager, detectShells } = require('./pty');
const store = require('./store');
const history = require('./history');
const ai = require('./ai');
const guard = require('./guard');
const translate = require('./translate');
const usage = require('./usage');
const updater = require('./updater');

// Plain string argument from the renderer, bounded in length.
function text(v, max = 4000) {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

const THEME_CHROME = {
  terminals: { color: '#10142F', symbolColor: '#EEF1FA' },
  mocha: { color: '#181825', symbolColor: '#cdd6f4' },
  midnight: { color: '#0b0e14', symbolColor: '#bfbdb6' },
  light: { color: '#e6e9ef', symbolColor: '#4c4f69' },
};

// From our package.json, so it's right even when launched by another entry point.
const APP_VERSION = require('../../package.json').version;

let win = null;
let ptys = null;

function send(channel, ...args) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
}

function createWindow() {
  const settings = store.getSettings();
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 640,
    minHeight: 400,
    title: 'TerminalS',
    icon: path.join(__dirname, '..', '..', 'assets', 'icon.ico'),
    backgroundColor: THEME_CHROME[settings.theme].color,
    titleBarStyle: 'hidden',
    titleBarOverlay: { ...THEME_CHROME[settings.theme], height: 38 },
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // The app never navigates; links from terminal output open in the browser.
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') win.webContents.toggleDevTools();
  });

  win.on('closed', () => {
    win = null;
  });
}

// IPC handlers only accept input from our own window.
function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!win || event.sender !== win.webContents) throw new Error('Unauthorized sender');
    return fn(...args);
  });
}

function on(channel, fn) {
  ipcMain.on(channel, (event, ...args) => {
    if (!win || event.sender !== win.webContents) return;
    fn(...args);
  });
}

function registerIpc() {
  handle('shells:list', () => detectShells().map(({ id, name, kind }) => ({ id, name, kind })));

  handle('pty:create', (shellId, cols, rows) => ptys.create(String(shellId), cols, rows));
  on('pty:write', (id, data) => ptys.write(id, data));
  on('pty:resize', (id, cols, rows) => ptys.resize(id, cols, rows));
  on('pty:kill', (id) => ptys.kill(id));

  handle('history:list', () => history.list());
  handle('history:add', (entry) => history.add(entry || {}));
  on('history:exit', (id, code) => history.setExitCode(String(id), code));
  handle('history:remove', (id) => history.remove(String(id)));
  handle('history:clear', () => history.clear());

  handle('pins:list', () => history.listPins());
  handle('pins:add', (pin) => history.addPin(pin || {}));
  handle('pins:remove', (id) => history.removePin(String(id)));
  handle('pins:move', (id, delta) => history.movePin(String(id), Number(delta)));

  // Settings plus credential status; secret values themselves never leave main.
  const withStatus = (s) => ({
    ...s,
    models: store.MODELS,
    apiKey: ai.credentialStatus(s.ai),
    keys: Object.fromEntries(ai.PROVIDERS.map((p) => [p, ai.keyStatus(p, s.ai[p])])),
    envDefaults: ai.environmentDefaults(),
    version: APP_VERSION,
    // Shared with the renderer so "works in any shell" has one definition.
    portable: { program: translate.PORTABLE_RE.source, shellSpecific: translate.SHELL_SPECIFIC_RE.source },
  });
  handle('settings:get', () => withStatus(store.getSettings()));
  handle('settings:set', (patch) => {
    const next = store.updateSettings(patch);
    if (patch && patch.updates) updater.schedule();
    if (win && patch && patch.theme) win.setTitleBarOverlay({ ...THEME_CHROME[next.theme], height: 38 });
    return withStatus(next);
  });
  handle('ai:setKey', (provider, key) => {
    ai.setApiKey(String(provider), key);
    return withStatus(store.getSettings());
  });
  handle('ai:clearKey', (provider) => {
    ai.clearApiKey(String(provider));
    return withStatus(store.getSettings());
  });
  handle('ai:suggest', (req) => ai.suggest(req || {}));
  on('ai:cancel', () => ai.cancel());
  handle('ai:test', () => ai.test());
  handle('ai:fix', (req) => ai.fix(req || {}));
  handle('ai:translate', (req) => ai.translate(req || {}));

  handle('guard:check', (command, cwd) => {
    const cfg = store.getSettings().tools.guard;
    if (!cfg.enabled) return { hits: [], branch: null };
    return guard.check(text(command), text(cwd, 1024), cfg);
  });
  handle('translate:detect', (value, shellKind) => {
    const cfg = store.getSettings().tools.translate;
    const threshold = { low: 0.75, medium: 0.5, high: 0.25 }[cfg.sensitivity] || 0.5;
    return translate.foreignTo(text(value), text(shellKind, 20), threshold);
  });
  handle('translate:local', (command, from, to, psVersion) => {
    const result = translate.translateLocal(text(command, 2000), text(from, 20), text(to, 20), { psVersion: Number(psVersion) || 7 });
    return result ? { command: result, destructive: guard.classify(result).length > 0 } : null;
  });
  handle('usage:get', () => usage.summary());
  handle('usage:reset', () => {
    usage.reset();
    return usage.summary();
  });

  const shellIds = () => detectShells().map((s) => s.id);
  handle('profiles:get', () => store.getProfiles());
  handle('profiles:saveEnv', (v) => store.saveEnvVar(v, shellIds()));
  handle('profiles:deleteEnv', (id) => store.deleteEnvVar(String(id)));
  handle('profiles:moveEnv', (id, delta) => store.moveEnvVar(String(id), Number(delta)));
  handle('profiles:saveScript', (kind, text) => store.saveScript(String(kind), text));

  handle('updates:state', () => updater.getState());
  handle('updates:check', () => updater.check());
  handle('updates:install', () => updater.install());

  handle('app:openExternal', (url) => {
    let parsed;
    try {
      parsed = new URL(String(url));
    } catch {
      return false;
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
    shell.openExternal(parsed.toString());
    return true;
  });
}

// Groups taskbar windows under the TerminalS icon instead of Electron's.
app.setAppUserModelId('com.terminals.app');

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  ptys = new PtyManager(send);
  registerIpc();

  const settings = store.getSettings();
  if (!settings.psreadlineImported) {
    history.importPsReadLine();
    store.updateSettings({ psreadlineImported: true });
  }
  if (!settings.bashImported) {
    history.importBashHistory();
    store.updateSettings({ bashImported: true });
  }

  createWindow();
  updater.init((state) => send('updates:state', state));
});

app.on('before-quit', () => {
  history.flush();
  usage.flush();
  if (ptys) ptys.killAll();
});

app.on('window-all-closed', () => app.quit());
