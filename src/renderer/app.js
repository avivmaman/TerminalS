'use strict';

/* global Terminal, FitAddon, WebLinksAddon */

const api = window.terminals;

const THEMES = {
  // Brand palette from terminals-logo.svg: #1A2150 #2E3FA8 #8FA2FF #FFB547.
  terminals: {
    background: '#161B3F', foreground: '#EEF1FA', cursor: '#FFB547', cursorAccent: '#161B3F',
    selectionBackground: '#2E3FA899', black: '#252D66', red: '#FF6B81', green: '#7EE0A8', yellow: '#FFB547',
    blue: '#8FA2FF', magenta: '#C6A0FF', cyan: '#7FD8E6', white: '#D5DAEE', brightBlack: '#5A64A8',
    brightRed: '#FF8FA0', brightGreen: '#A3EDC3', brightYellow: '#FFCA7A', brightBlue: '#B3C0FF',
    brightMagenta: '#DBC2FF', brightCyan: '#A6E7F0', brightWhite: '#FFFFFF',
  },
  mocha: {
    background: '#1e1e2e', foreground: '#cdd6f4', cursor: '#f5e0dc', cursorAccent: '#1e1e2e',
    selectionBackground: '#585b7080', black: '#45475a', red: '#f38ba8', green: '#a6e3a1', yellow: '#f9e2af',
    blue: '#89b4fa', magenta: '#f5c2e7', cyan: '#94e2d5', white: '#bac2de', brightBlack: '#585b70',
    brightRed: '#f38ba8', brightGreen: '#a6e3a1', brightYellow: '#f9e2af', brightBlue: '#89b4fa',
    brightMagenta: '#f5c2e7', brightCyan: '#94e2d5', brightWhite: '#a6adc8',
  },
  midnight: {
    background: '#0d1017', foreground: '#bfbdb6', cursor: '#e6b450', cursorAccent: '#0d1017',
    selectionBackground: '#409fff40', black: '#1e232b', red: '#ea6c73', green: '#7fd962', yellow: '#f9af4f',
    blue: '#53bdfa', magenta: '#cda1fa', cyan: '#90e1c6', white: '#c7c7c7', brightBlack: '#686868',
    brightRed: '#f07178', brightGreen: '#aad94c', brightYellow: '#ffb454', brightBlue: '#59c2ff',
    brightMagenta: '#d2a6ff', brightCyan: '#95e6cb', brightWhite: '#ffffff',
  },
  light: {
    background: '#eff1f5', foreground: '#4c4f69', cursor: '#dc8a78', cursorAccent: '#eff1f5',
    selectionBackground: '#acb0be80', black: '#5c5f77', red: '#d20f39', green: '#40a02b', yellow: '#df8e1d',
    blue: '#1e66f5', magenta: '#ea76cb', cyan: '#179299', white: '#acb0be', brightBlack: '#6c6f85',
    brightRed: '#d20f39', brightGreen: '#40a02b', brightYellow: '#df8e1d', brightBlue: '#1e66f5',
    brightMagenta: '#ea76cb', brightCyan: '#179299', brightWhite: '#bcc0cc',
  },
};

const FONT_FAMILY = '"Cascadia Code", "Cascadia Mono", Consolas, "Courier New", monospace';

const state = {
  shells: [],
  settings: null,
  history: [],
  pins: [],
  historyView: 'recent',
  tabs: [],
  active: null,
};

const ptyTabs = new Map();
const $ = (id) => document.getElementById(id);

// Small DOM builder. Text is always set via textContent, never innerHTML.
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = Boolean(v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c != null) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

function shellKind(shellId) {
  const s = state.shells.find((x) => x.id === shellId);
  return s ? s.kind : shellId === 'powershell' || shellId === 'pwsh' ? 'powershell' : shellId;
}

function basename(p) {
  if (!p) return '';
  const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

function relativeTime(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return new Date(ts).toLocaleDateString();
}

// ------------------------------------------------------------ suggestions

// Most recent history entry that extends `input`, preferring the same folder,
// and only from the same shell family (PowerShell history is useless in bash).
// Every pinned/history command that extends `input`, best first: pins, then
// this folder (most recent first), then everywhere else. Same shell family only.
function historyMatches(input, cwd, shellId, limit = 50) {
  const extendsInput = (c) => c.length > input.length && c.startsWith(input);
  const seen = new Set();
  const here = [];
  const elsewhere = [];
  for (const p of state.pins) {
    if (extendsInput(p.command) && usableIn(p.command, p.shell, shellId) && !seen.has(p.command)) {
      seen.add(p.command);
      here.push(p.command);
    }
  }
  for (let i = state.history.length - 1; i >= 0 && here.length + elsewhere.length < limit; i--) {
    const e = state.history[i];
    if (!extendsInput(e.command) || !usableIn(e.command, e.shell, shellId) || seen.has(e.command)) continue;
    seen.add(e.command);
    (cwd && e.cwd === cwd ? here : elsewhere).push(e.command);
  }
  return here.concat(elsewhere).slice(0, limit);
}

// Instant picker rows from pins and history. Empty input: recent commands here.
function localSuggestions(input, cwd, shellId) {
  if (input.trimStart().startsWith('#')) return [];
  const out = [];
  const seen = new Set();
  const add = (command, source) => {
    if (out.length >= 3 || seen.has(command)) return;
    if (input ? command.length <= input.length || !command.startsWith(input) : false) return;
    seen.add(command);
    out.push({ command, note: '', kind: 'extend', destructive: false, source });
  };
  for (const p of state.pins) if (usableIn(p.command, p.shell, shellId)) add(p.command, 'pinned');
  for (let i = state.history.length - 1; i >= 0 && out.length < 3; i--) {
    const e = state.history[i];
    if (!usableIn(e.command, e.shell, shellId)) continue;
    if (!input && cwd && e.cwd !== cwd) continue;
    add(e.command, 'history');
  }
  return out;
}

function matchesHotkey(e, hotkey) {
  switch (hotkey) {
    case 'ctrl+space': return e.ctrlKey && !e.shiftKey && !e.altKey && e.code === 'Space';
    case 'ctrl+shift+space': return e.ctrlKey && e.shiftKey && !e.altKey && e.code === 'Space';
    case 'alt+/': return e.altKey && !e.ctrlKey && e.key === '/';
    case 'alt+f': return e.altKey && !e.ctrlKey && !e.shiftKey && e.code === 'KeyF';
    case 'ctrl+alt+f': return e.altKey && e.ctrlKey && !e.shiftKey && e.code === 'KeyF';
    case 'alt+t': return e.altKey && !e.ctrlKey && !e.shiftKey && e.code === 'KeyT';
    case 'ctrl+alt+t': return e.altKey && e.ctrlKey && !e.shiftKey && e.code === 'KeyT';
    default: return false;
  }
}

function hotkeyLabel(hotkey) {
  return { 'alt+f': 'Alt+F', 'ctrl+alt+f': 'Ctrl+Alt+F', 'alt+t': 'Alt+T', 'ctrl+alt+t': 'Ctrl+Alt+T' }[hotkey] || '';
}

const DIALECT_LABELS = { bash: 'bash', powershell: 'PowerShell', cmd: 'cmd' };

function shellDialect(shell) {
  return { powershell: 'powershell', cmd: 'cmd', bash: 'bash', wsl: 'bash' }[shell.kind] || 'bash';
}

// Target description including version, which matters (PS 5.1 has no &&).
function shellTarget(shell) {
  return {
    pwsh: 'PowerShell 7',
    powershell: 'Windows PowerShell 5.1',
    cmd: 'cmd.exe',
    gitbash: 'bash (Git Bash on Windows)',
    wsl: 'bash (WSL, Linux)',
  }[shell.id] || shell.name;
}

function psVersion(shell) {
  return shell.id === 'powershell' ? 5 : 7;
}

// Resolves true if the user chooses to run the risky command anyway.
function confirmGuard(command, hits) {
  const dialog = $('guard-dialog');
  $('guard-command').textContent = command;
  $('guard-reasons').replaceChildren(...hits.map((hit) => h('li', {},
    h('strong', { text: hit.label }), ` \u2014 ${hit.reason}`)));
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      dialog.removeEventListener('keydown', onKey);
      $('guard-run').onclick = null;
      $('guard-cancel').onclick = null;
      dialog.onclose = null;
      if (dialog.open) dialog.close();
      resolve(ok);
    };
    const onKey = (e) => {
      if (e.key === 'y' || e.key === 'Y') {
        e.preventDefault();
        finish(true);
      }
    };
    dialog.addEventListener('keydown', onKey);
    $('guard-run').onclick = () => finish(true);
    $('guard-cancel').onclick = () => finish(false);
    dialog.onclose = () => finish(false);
    dialog.showModal();
    $('guard-cancel').focus();
  });
}

function fmtTokens(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

function fmtCost(usd) {
  return usd ? `$${usd < 1 ? usd.toFixed(3) : usd.toFixed(2)}` : '\u2014';
}

function refreshUsage() {
  api.usage.get().then((u) => {
    state.usage = u;
    renderUsagePill();
    if ($('settings-dialog').open && !document.querySelector('section[data-tab="usage"]').hidden) renderUsage();
  }).catch(() => {});
}

function renderUsagePill() {
  const el = $('status-usage');
  const cfg = state.settings.tools.usage;
  const d = state.usage && state.usage.today;
  if (!cfg.enabled || !cfg.showInStatus || !d) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  el.textContent = `${d.requests} req \u00b7 ${fmtTokens(d.inputTokens + d.outputTokens)} tok${d.costUsd ? ` \u00b7 ${fmtCost(d.costUsd)}` : ''}`;
  const caps = [];
  if (cfg.dailyRequests) caps.push(`${d.requests}/${cfg.dailyRequests} requests`);
  if (cfg.dailyTokens) caps.push(`${(d.inputTokens + d.outputTokens).toLocaleString()}/${cfg.dailyTokens.toLocaleString()} tokens`);
  el.title = `AI usage today${caps.length ? ` (caps: ${caps.join(', ')})` : ''}. Details in Settings \u2192 Usage.`;
}

let portableRes = null;

// "npm run build" or "git status" work in any shell; "$env:X = 1" doesn't.
function isPortable(command) {
  if (!portableRes) {
    const p = state.settings.portable;
    portableRes = p ? [new RegExp(p.program), new RegExp(p.shellSpecific, 'i')] : [/^$/, /./];
  }
  return portableRes[0].test(command.trim()) && !portableRes[1].test(command);
}

// Can a command recorded in entryShell be suggested in a tab of shellId?
function usableIn(command, entryShell, shellId) {
  return !entryShell || shellKind(entryShell) === shellKind(shellId) || isPortable(command);
}

function recentCommands(shellId) {
  const out = [];
  for (let i = state.history.length - 1; i >= 0 && out.length < 20; i--) {
    const e = state.history[i];
    if (usableIn(e.command, e.shell, shellId)) out.unshift(e.command);
  }
  return out;
}

const PROVIDER_LABELS = {
  anthropic: 'Claude',
  'foundry-claude': 'Claude on Foundry',
  'azure-openai': 'Azure OpenAI',
  openrouter: 'OpenRouter',
};

function aiConfigured() {
  const ai = state.settings.ai;
  if (state.settings.apiKey === 'missing') return false;
  const env = state.settings.envDefaults || {};
  if (ai.provider === 'foundry-claude') return Boolean(ai['foundry-claude'].resource || env['foundry-claude']);
  if (ai.provider === 'azure-openai') return Boolean((ai['azure-openai'].endpoint || env['azure-openai']) && ai['azure-openai'].deployment);
  if (ai.provider === 'openrouter') return Boolean(ai.openrouter.model);
  return true;
}

function setAiStatus(status, error) {
  const el = $('status-ai');
  const ai = state.settings.ai;
  const label = PROVIDER_LABELS[ai.provider];
  el.className = 'pill';
  el.title = label;
  if (!ai.enabled) {
    el.textContent = 'AI off';
    return;
  }
  if (!aiConfigured() && status !== 'error') {
    if (state.settings.keys && state.settings.keys[ai.provider] === 'env-mismatch') status = 'key-endpoint-mismatch';
    else status = state.settings.apiKey === 'missing' ? 'no-key' : 'not-configured';
  }
  switch (status) {
    case 'thinking': el.textContent = 'AI …'; break;
    case 'no-key': el.textContent = 'AI: add API key'; el.classList.add('warn'); el.title = `No API key for ${label}. Open Settings.`; break;
    case 'not-configured': el.textContent = 'AI: finish setup'; el.classList.add('warn'); el.title = `${label} needs an endpoint/deployment in Settings.`; break;
    case 'error': el.textContent = 'AI error'; el.classList.add('warn'); el.title = error || ''; break;
    case 'key-endpoint-mismatch': el.textContent = 'AI: key/endpoint mismatch'; el.classList.add('warn'); el.title = 'The API key from your environment is only used with the endpoint from your environment. Save a key in Settings for this endpoint.'; break;
    case 'sensitive': el.textContent = 'AI paused'; el.title = 'Input looks like it contains a credential, so it was not sent'; break;
    default:
      el.textContent = `AI · ${label}`;
      el.title = `${label} · ${triggerText()} for suggestions`;
      el.classList.add('ok');
  }
}

function triggerText() {
  const ai = state.settings.ai;
  const keys = { 'ctrl+space': 'Ctrl+Space', 'ctrl+shift+space': 'Ctrl+Shift+Space', 'alt+/': 'Alt+/' };
  const parts = [];
  if (ai.doubleSpace) parts.push('double-space');
  if (keys[ai.hotkey]) parts.push(keys[ai.hotkey]);
  return parts.join(' or ') || 'no trigger set';
}

let flashUntil = 0;

// Transient hints (ghost text) don't overwrite a recent flashHint message.
function setHint(text) {
  if (Date.now() < flashUntil) return;
  $('status-hint').textContent = text || '';
}

function flashHint(text, ms = 5000) {
  flashUntil = Date.now() + ms;
  $('status-hint').textContent = text;
}

// ------------------------------------------------------------------ tabs

class Tab {
  constructor(shell) {
    this.shell = shell;
    this.ptyId = null;
    this.cwd = null;
    this.integrated = false;
    this.inputStart = null;
    this.pending = null;
    this.enterPending = null;
    this.lastFailure = null;
    this.ghost = null;
    this.lastInput = null;
    this.justAccepted = null;
    this.picker = null;
    this.lastSpaceAt = 0;
    this.lastOutputAt = 0;
    this.guardBusy = false;
    this.inputQueue = [];
    this.fixChip = false;
    this.pasteOffer = null;
    this.updateQueued = false;
    this.exited = false;

    this.pane = h('div', { class: 'pane' });
    this.ghostEl = h('div', { class: 'ghost' });
    this.fixChipEl = h('div', { class: 'fix-chip', hidden: true });
    this.titleEl = h('span', { class: 'tab-title', text: shell.name });
    this.tabEl = h('div', { class: 'tab', title: shell.name, onmousedown: (e) => { if (e.button === 1) { e.preventDefault(); closeTab(this); } }, onclick: () => activate(this) },
      this.titleEl,
      h('button', { class: 'tab-close', title: 'Close (Ctrl+Shift+W)', onclick: (e) => { e.stopPropagation(); closeTab(this); } }, '×'));

    this.term = new Terminal({
      fontFamily: FONT_FAMILY,
      fontSize: state.settings.fontSize,
      theme: THEMES[state.settings.theme],
      cursorBlink: true,
      scrollback: 10000,
      allowProposedApi: true,
      rightClickSelectsWord: false,
      windowsPty: { backend: 'conpty' },
    });
    this.fit = new FitAddon.FitAddon();
    this.term.loadAddon(this.fit);
    this.term.loadAddon(new WebLinksAddon.WebLinksAddon((_e, uri) => api.openExternal(uri)));
  }

  // Must run after the pane is visible so the fit addon can measure it.
  async open() {
    this.term.open(this.pane);
    this.pane.append(this.ghostEl, this.fixChipEl);
    this.safeFit();

    this.term.parser.registerOscHandler(633, (data) => this.onOsc(data));
    this.term.onData((d) => this.onInput(d));
    this.term.onWriteParsed(() => {
      this.lastOutputAt = performance.now();
      this.checkEnter();
      this.scheduleUpdate();
    });
    this.term.onCursorMove(() => this.scheduleUpdate());
    this.term.onScroll(() => this.scheduleUpdate());
    this.term.onResize(({ cols, rows }) => {
      if (this.ptyId) api.pty.resize(this.ptyId, cols, rows);
      this.closePicker();
      this.scheduleUpdate();
    });
    this.term.attachCustomKeyEventHandler((e) => this.onKey(e));
    this.pane.addEventListener('contextmenu', (e) => this.onContextMenu(e));
    new ResizeObserver(() => this.safeFit()).observe(this.pane);

    try {
      const res = await api.pty.create(this.shell.id, this.term.cols, this.term.rows);
      this.ptyId = res.id;
      ptyTabs.set(this.ptyId, this);
    } catch (err) {
      this.term.write(`\x1b[31mFailed to start ${this.shell.name}: ${String(err.message || err)}\x1b[0m\r\n`);
      this.exited = true;
    }
  }

  safeFit() {
    if (!this.pane.classList.contains('active')) return;
    try { this.fit.fit(); } catch { /* not measurable yet */ }
  }

  updateTitle() {
    const where = basename(this.cwd);
    this.titleEl.textContent = where ? `${where}` : this.shell.name;
    this.tabEl.title = `${this.shell.name}${this.cwd ? ` — ${this.cwd}` : ''}`;
  }

  // OSC 633 shell-integration markers emitted by our prompt wrappers.
  onOsc(data) {
    const i = data.indexOf(';');
    const kind = i < 0 ? data : data.slice(0, i);
    const arg = i < 0 ? '' : data.slice(i + 1);
    const b = this.term.buffer.active;
    // A new prompt (or finished command) means any pending Enter is complete.
    if (kind === 'A' || kind === 'D') this.resolveEnter();
    switch (kind) {
      case 'A':
        this.inputStart = null;
        break;
      case 'B':
        this.integrated = true;
        this.inputStart = { x: b.cursorX, y: b.baseY + b.cursorY };
        this.lastInput = null;
        this.scheduleUpdate();
        break;
      case 'D': {
        const code = arg === '' ? null : Number.parseInt(arg, 10);
        this.finishCommand(Number.isNaN(code) ? null : code);
        break;
      }
      case 'P':
        if (arg.startsWith('Cwd=')) {
          this.cwd = arg.slice(4);
          this.updateTitle();
          if (this === state.active) {
            updateStatus();
            if ($('history-here').checked) renderHistory();
          }
        }
        break;
      default:
        break;
    }
    return true;
  }

  // Reads the command line from the terminal buffer (from the input start to
  // the end of its wrapped lines) and splits it at the cursor. Reading the
  // screen rather than tracking keystrokes keeps it correct after tab
  // completion, history recall (up arrow) and PSReadLine edits.
  readInput(start = this.inputStart) {
    const b = this.term.buffer.active;
    if (!start || b.type !== 'normal') return null;
    const cursorAbs = b.baseY + b.cursorY;
    let text = '';
    let cursorOffset = -1;
    let lastLine = start.y;
    for (let y = start.y; y < b.length; y++) {
      const line = b.getLine(y);
      if (!line || (y > start.y && !line.isWrapped)) break;
      const startX = y === start.y ? start.x : 0;
      if (y === cursorAbs) cursorOffset = text.length + Math.max(0, b.cursorX - startX);
      text += line.translateToString(false, startX);
      lastLine = y;
    }
    return {
      text: text.replace(/\s+$/, ''),
      lastLine,
      atCursor: cursorOffset >= 0,
      before: cursorOffset >= 0 ? text.slice(0, cursorOffset) : '',
      after: cursorOffset >= 0 ? text.slice(cursorOffset).replace(/\s+$/, '') : '',
    };
  }

  // Like readInput, but only when the cursor sits inside the input.
  readEditableInput() {
    const r = this.readInput();
    return r && r.atCursor ? r : null;
  }

  // Enter was pressed. The shell may still be echoing earlier keystrokes
  // (PSReadLine can lag well behind fast typing), so the command is read once
  // the cursor moves past the input line or the next prompt marker arrives.
  // Shells without integration get a timeout as a last resort.
  beginEnter() {
    if (!this.inputStart) {
      this.commit('');
      return;
    }
    this.hideGhost();
    this.closePicker();
    const start = this.inputStart;
    this.inputStart = null;
    const timer = this.integrated ? null : setTimeout(() => this.resolveEnter(), 3000);
    this.enterPending = { start, timer };
  }

  checkEnter() {
    const p = this.enterPending;
    if (!p) return;
    const b = this.term.buffer.active;
    const r = this.readInput(p.start);
    if (r && b.baseY + b.cursorY > r.lastLine) this.resolveEnter();
  }

  resolveEnter() {
    const p = this.enterPending;
    if (!p) return;
    this.enterPending = null;
    clearTimeout(p.timer);
    const r = this.readInput(p.start);
    this.commit(r ? r.text.trim() : '', r ? r.lastLine + 1 : undefined);
  }

  onKey(e) {
    if (e.type !== 'keydown') return true;
    const plain = !e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey;

    if (this.pasteOffer && this.pasteOfferKey(e)) {
      e.preventDefault();
      return false;
    }
    if (this.picker && this.pickerKey(e)) {
      e.preventDefault();
      return false;
    }
    const tools = state.settings.tools;
    if (matchesHotkey(e, state.settings.ai.hotkey) && this.atPrompt()) {
      e.preventDefault();
      this.openPicker();
      return false;
    }
    if (tools.fix.enabled && matchesHotkey(e, tools.fix.hotkey) && this.lastFailure && this.atPrompt()) {
      e.preventDefault();
      this.openPicker('fix');
      return false;
    }
    if (tools.translate.enabled && matchesHotkey(e, tools.translate.hotkey) && this.atPrompt()) {
      e.preventDefault();
      this.openPicker('translate');
      return false;
    }
    if (e.key === 'Enter' && plain && tools.guard.enabled && this.atPrompt()) {
      e.preventDefault();
      this.requestEnter();
      return false;
    }

    if (e.ctrlKey && e.shiftKey && e.code === 'KeyC') {
      if (this.term.hasSelection()) navigator.clipboard.writeText(this.term.getSelection());
      return false;
    }
    if (e.ctrlKey && !e.altKey && e.code === 'KeyV') {
      e.preventDefault();
      this.pasteClipboard();
      return false;
    }
    if (e.ctrlKey && !e.shiftKey && e.code === 'KeyC' && this.term.hasSelection()) {
      navigator.clipboard.writeText(this.term.getSelection());
      this.term.clearSelection();
      return false;
    }
    if (this.ghost) {
      if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && plain && state.settings.ai.ghostArrows) {
        e.preventDefault();
        this.cycleGhost(e.key === 'ArrowUp' ? 1 : -1);
        return false;
      }
      if ((e.key === 'Tab' || e.key === 'ArrowRight') && plain) {
        e.preventDefault();
        this.acceptGhost();
        return false;
      }
      if (e.key === 'Escape' && plain) {
        this.dismissGhost();
        return false;
      }
    }
    return !isAppShortcut(e);
  }

  onInput(data, internal = false) {
    if (this.exited) {
      closeTab(this);
      return;
    }
    if (this.guardBusy && !internal) {
      this.inputQueue.push(data);
      return;
    }
    if (this.pasteOffer) this.closePasteOffer();
    // Without shell integration, guess that input starts where the user
    // begins typing after a prompt.
    if (!this.integrated && !this.inputStart && /^[\x20-\x7e]/.test(data)) {
      const b = this.term.buffer.active;
      this.inputStart = { x: b.cursorX, y: b.baseY + b.cursorY };
    }
    if (this.detectDoubleSpace(data)) return;
    if (this.picker) this.closePicker();
    if (data.includes('\r')) {
      this.beginEnter();
    } else if (data === '\x03') {
      this.hideGhost();
      if (!this.integrated) this.inputStart = null;
    }
    if (this.ptyId) api.pty.write(this.ptyId, data);
  }

  // Double-space trigger: the first space is sent right away (no typing lag);
  // a second one within the window erases it and opens the picker instead.
  detectDoubleSpace(data) {
    const ai = state.settings.ai;
    if (data !== ' ' || !ai.doubleSpace || !this.atPrompt()) {
      this.lastSpaceAt = 0;
      return false;
    }
    const now = performance.now();
    if (this.lastSpaceAt && now - this.lastSpaceAt <= ai.doubleSpaceMs) {
      this.lastSpaceAt = 0;
      api.pty.write(this.ptyId, '\x7f');
      this.openPicker();
      return true;
    }
    this.lastSpaceAt = now;
    return false;
  }

  // Records a command that is about to run. The exit code arrives later via
  // OSC 633;D, possibly before the history write has resolved.
  commit(command, outputStart) {
    this.hideGhost();
    this.closePicker();
    this.closePasteOffer();
    this.hideFixChip();
    this.inputStart = null;
    this.lastInput = null;
    if (!command) return;
    const pending = { command, entry: null, code: undefined, outputStart };
    this.pending = pending;
    api.history.add({ command, cwd: this.cwd, shell: this.shell.id }).then((saved) => {
      if (!saved) return;
      state.history.push(saved);
      pending.entry = saved;
      if (pending.code !== undefined) applyExit(pending);
      renderHistory();
    });
  }

  finishCommand(code) {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    p.code = code;
    if (code) {
      this.lastFailure = { command: p.command, exitCode: code, output: this.captureOutput(p.outputStart) };
      const fix = state.settings.tools.fix;
      this.fixChip = fix.enabled && fix.showChip;
    } else {
      this.lastFailure = null;
      this.hideFixChip();
    }
    if (p.entry) applyExit(p);
  }

  // Lines printed by the last command, from just after its input line up to
  // where the next prompt is about to be drawn.
  captureOutput(startY) {
    const b = this.term.buffer.active;
    if (startY == null || b.type !== 'normal') return [];
    const end = Math.min(b.baseY + b.cursorY, b.length - 1);
    const lines = [];
    for (let y = Math.max(0, startY); y <= end; y++) {
      const line = b.getLine(y);
      if (line) lines.push(line.translateToString(true));
    }
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    return lines.slice(-200);
  }

  // ---------------------------------------------------------- fix chip

  renderFixChip() {
    const el = this.fixChipEl;
    const f = this.lastFailure;
    const b = this.term.buffer.active;
    const m = this.cellMetrics();
    const row = this.inputStart ? this.inputStart.y - b.viewportY : -1;
    if (!this.fixChip || !f || !m || this.picker || this !== state.active || row < 0 || row >= this.term.rows) {
      el.hidden = true;
      return;
    }
    const key = hotkeyLabel(state.settings.tools.fix.hotkey);
    el.replaceChildren(
      h('button', { class: 'fix-go', title: `Ask AI to fix: ${f.command}`, onmousedown: (e) => e.preventDefault(), onclick: () => this.openPicker('fix') },
        h('span', { class: 'spark', text: '\u2726' }), ` Fix${key ? ` \u00b7 ${key}` : ''}`),
      h('span', { class: 'fix-exit', text: `exit ${f.exitCode}` }),
      h('button', { class: 'fix-x', title: 'Dismiss', onmousedown: (e) => e.preventDefault(), onclick: () => this.hideFixChip() }, '\u00d7'));
    el.hidden = false;
    el.style.top = `${m.top + row * m.cellH + (m.cellH - el.offsetHeight) / 2}px`;
  }

  hideFixChip() {
    this.fixChip = false;
    if (this.fixChipEl) this.fixChipEl.hidden = true;
  }

  // ------------------------------------------------------ safety guard

  // Enter at a prompt: check the line locally first, ask if it looks risky.
  async requestEnter() {
    if (this.guardBusy) return;
    const r = this.readInput();
    const command = r ? r.text.trim() : '';
    if (!command || !state.settings.tools.guard.enabled) {
      this.sendEnter();
      return;
    }
    this.guardBusy = true;
    let res;
    try {
      res = await api.guard.check(command, this.cwd);
    } catch {
      res = { hits: [] };
    }
    if (!res.hits.length) {
      this.guardBusy = false;
      this.sendEnter();
      return;
    }
    this.hideGhost();
    const ok = await confirmGuard(command, res.hits);
    this.guardBusy = false;
    if (ok) {
      this.sendEnter();
    } else {
      this.inputQueue = [];
      flashHint('Not run. The command is still on the line.');
      this.term.focus();
    }
  }

  // Sends Enter, then anything typed while the guard was deciding.
  sendEnter() {
    this.onInput('\r', true);
    const queued = this.inputQueue;
    this.inputQueue = [];
    for (const d of queued) this.onInput(d);
  }

  pasteClipboard() {
    navigator.clipboard.readText().then((t) => {
      if (!t) return;
      this.term.paste(t);
      if (this.atPrompt()) this.maybeOfferTranslate(t);
    }).catch(() => {});
  }

  // Windows Terminal style: right-click copies a selection, otherwise pastes.
  onContextMenu(e) {
    if (!state.settings.rightClick) return;
    e.preventDefault();
    if (this.term.hasSelection()) {
      navigator.clipboard.writeText(this.term.getSelection());
      this.term.clearSelection();
      flashHint('Copied', 1500);
    } else {
      this.pasteClipboard();
    }
    this.term.focus();
  }

  // ---------------------------------------------------- paste translation

  async maybeOfferTranslate(text) {
    const tr = state.settings.tools.translate;
    const clean = text.trim();
    if (!tr.enabled || !tr.promptOnPaste || !clean || clean.length > 2000 || clean.split(/\r?\n/).length > 20) return;
    let res = null;
    try {
      res = await api.translate.detect(clean, this.shell.kind);
    } catch {
      return;
    }
    if (!res || this !== state.active || this.picker) return;
    this.closePasteOffer();
    const el = h('div', { class: 'paste-offer', role: 'dialog' },
      h('span', { class: 'spark', text: '\u2726' }),
      h('span', { text: `This looks like ${DIALECT_LABELS[res.from]}. Translate it to ${shellTarget(this.shell)}?` }),
      h('button', { class: 'primary', onmousedown: (e) => e.preventDefault(), onclick: () => this.acceptPasteOffer() }, 'Translate'),
      h('button', { onmousedown: (e) => e.preventDefault(), onclick: () => this.closePasteOffer() }, 'Keep'),
      h('span', { class: 'hint', text: 'Enter \u00b7 Esc' }));
    this.pasteOffer = { from: res.from, el };
    this.pane.append(el);
    // Wait for the pasted text to be echoed so the offer sits under it.
    await this.whenQuiet();
    this.positionPopup(el);
  }

  acceptPasteOffer() {
    const offer = this.pasteOffer;
    this.closePasteOffer();
    if (offer) this.openPicker('translate', { from: offer.from });
  }

  closePasteOffer() {
    if (!this.pasteOffer) return;
    this.pasteOffer.el.remove();
    this.pasteOffer = null;
  }

  pasteOfferKey(e) {
    if (e.key === 'Enter' && !e.ctrlKey && !e.altKey && !e.shiftKey) {
      this.acceptPasteOffer();
      return true;
    }
    if (matchesHotkey(e, state.settings.tools.translate.hotkey)) {
      this.acceptPasteOffer();
      return true;
    }
    if (e.key === 'Escape') {
      this.closePasteOffer();
      return true;
    }
    if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return true;
    this.closePasteOffer();
    return false;
  }

  scheduleUpdate() {
    if (this.updateQueued) return;
    this.updateQueued = true;
    requestAnimationFrame(() => {
      this.updateQueued = false;
      this.updateSuggestion();
      this.renderFixChip();
    });
  }

  // Ghost text comes only from local pins and history; AI is on demand.
  updateSuggestion() {
    if (this !== state.active || this.exited || !state.settings.ai.ghost || this.picker || document.querySelector('dialog[open]')) {
      this.hideGhost();
      return;
    }
    const r = this.readEditableInput();
    if (!r || r.after || !r.before.trim()) {
      this.hideGhost();
      this.lastInput = null;
      return;
    }
    const input = r.before;
    // Keep showing the current suggestion while the user types along with it.
    if (this.ghost && this.ghost.full.length > input.length && this.ghost.full.startsWith(input)) {
      const g = this.ghost;
      g.matches = g.matches.filter((m) => m.length > input.length && m.startsWith(input));
      g.index = Math.max(0, g.matches.indexOf(g.full));
      this.renderGhost(input);
      this.ghostHint();
      return;
    }
    if (input === this.lastInput) return;
    this.lastInput = input;
    this.hideGhost();
    if (input === this.justAccepted) return;
    this.justAccepted = null;
    const matches = historyMatches(input, this.cwd, this.shell.id);
    if (matches.length) this.showGhost(matches[0], 'history', input, matches);
  }

  // True when the cursor is on an editable command line at a shell prompt.
  atPrompt() {
    return Boolean(this.inputStart && this.readEditableInput());
  }

  // ---------------------------------------------------------------- picker

  openPicker(mode = 'suggest', extra = {}) {
    this.closePicker();
    this.closePasteOffer();
    this.hideGhost();
    const picker = { mode, extra, title: '', subtitle: '', items: [], index: 0, loading: false, message: null, input: '', el: h('div', { class: 'picker', role: 'listbox' }) };
    this.picker = picker;
    this.pane.append(picker.el);
    this.renderFixChip();
    this.whenQuiet().then(() => this.fillPicker(picker));
  }

  // Resolves once the shell has stopped echoing (PSReadLine can lag behind
  // typing, especially on the first prompt), so the input read is complete.
  async whenQuiet(quietMs = 60, maxMs = 500) {
    const start = performance.now();
    await new Promise((r) => setTimeout(r, quietMs));
    while (performance.now() - this.lastOutputAt < quietMs && performance.now() - start < maxMs) {
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  async fillPicker(picker) {
    if (this.picker !== picker) return;
    const r = this.readEditableInput() || (picker.mode === 'suggest' ? null : this.readInput());
    picker.input = r ? r.before : '';
    const plan = await this.planPicker(picker, r);
    if (this.picker !== picker) return;
    picker.title = plan.title;
    picker.subtitle = plan.subtitle || '';
    picker.items = plan.items;
    const ai = state.settings.ai;
    const wantAi = Boolean(plan.request) && ai.enabled && aiConfigured();
    picker.loading = wantAi;
    if (!plan.request) picker.message = plan.items.length ? null : plan.noAiMessage || null;
    else if (!ai.enabled) picker.message = plan.items.length ? null : 'AI is turned off in Settings.';
    else if (!wantAi) picker.message = 'AI is not set up yet. Open Settings (Ctrl+,).';
    this.renderPicker();
    if (!wantAi) return;

    setAiStatus('thinking');
    let res;
    try {
      res = await plan.request();
    } catch (err) {
      res = { status: 'error', error: cleanError(err) };
    }
    refreshUsage();
    if (this.picker !== picker) return;
    picker.loading = false;
    setAiStatus(['ok', 'cancelled', 'skipped', 'excluded-folder', 'cap-reached', 'disabled'].includes(res.status) ? 'ok' : res.status, res.error);
    if (res.status === 'ok') {
      if (picker.subtitle) res.items = res.items.filter((i) => i.command !== picker.subtitle);
      const have = new Set(picker.items.map((i) => i.command));
      for (const item of res.items) {
        if (!have.has(item.command)) picker.items.push({ ...item, source: 'ai' });
      }
      if (!res.items.length && !picker.items.length) picker.message = picker.mode === 'fix' ? 'The AI has no fix for this one.' : 'No AI suggestions for this input.';
    } else if (res.status === 'sensitive') {
      picker.message = 'The command line looks like it contains a credential, so nothing was sent.';
    } else if (res.status === 'skipped') {
      picker.message = 'Describe what you want after "#", e.g. # find files over 100MB';
    } else if (res.status === 'no-key') {
      picker.message = 'No API key for the AI provider. Open Settings (Ctrl+,).';
    } else if (res.status === 'excluded-folder') {
      picker.message = 'AI is off in this folder (Settings \u2192 Tools \u2192 AI-excluded folders).';
    } else if (res.status === 'cap-reached') {
      picker.message = `${res.error} Change it in Settings \u2192 Usage.`;
    } else if (res.status === 'disabled') {
      picker.message = 'This feature is turned off in Settings \u2192 Tools.';
    } else if (res.status === 'key-endpoint-mismatch') {
      picker.message = 'The environment API key only works with the environment endpoint. See Settings.';
    } else if (res.status !== 'cancelled') {
      picker.message = res.error || `AI request failed (${res.status}).`;
    }
    this.renderPicker();
  }

  // What a picker mode shows instantly and which AI request fills the rest.
  async planPicker(picker, r) {
    const input = r ? r.before : '';
    if (picker.mode === 'fix') {
      const f = this.lastFailure;
      if (!f) return { title: 'Fix last command', items: [], request: null, noAiMessage: 'No failed command to fix.' };
      return {
        title: `Fix \u00b7 exit ${f.exitCode}`,
        subtitle: f.command,
        items: [],
        request: () => api.ai.fix({ command: f.command, exitCode: f.exitCode, output: f.output, cwd: this.cwd, shell: this.shell.name, recent: recentCommands(this.shell.id) }),
      };
    }
    if (picker.mode === 'translate') {
      const line = r ? r.text.trim() : '';
      if (!line) return { title: 'Translate', items: [], request: null, noAiMessage: 'Type or paste a command first.' };
      const to = shellDialect(this.shell);
      let from = picker.extra.from;
      if (!from) {
        const d = await api.translate.detect(line, this.shell.kind).catch(() => null);
        from = d ? d.from : 'auto';
      }
      // Detection can be unsure for short commands like "which node"; then try
      // the built-in rules from each other shell and keep the first that fits.
      const candidates = from === 'auto' ? Object.keys(DIALECT_LABELS).filter((d) => d !== to) : [from];
      let local = null;
      for (const candidate of candidates) {
        local = await api.translate.local(line, candidate, to, psVersion(this.shell)).catch(() => null);
        if (local) {
          from = candidate;
          break;
        }
      }
      const items = [];
      if (local) items.push({ command: local.command, note: 'built-in rule, no AI needed', kind: 'replace', destructive: local.destructive, source: 'instant' });
      const tr = state.settings.tools.translate;
      return {
        title: `${DIALECT_LABELS[from] || 'Auto-detect'} \u2192 ${shellTarget(this.shell)}`,
        subtitle: line,
        items,
        request: tr.useAi ? () => api.ai.translate({ command: line, from, to: shellTarget(this.shell), cwd: this.cwd }) : null,
        noAiMessage: 'No built-in rule for this one, and AI translation is off (Settings \u2192 Tools).',
      };
    }
    return {
      title: input.trimStart().startsWith('#') ? 'Commands for your request' : 'Suggestions',
      items: localSuggestions(input, this.cwd, this.shell.id),
      request: () => api.ai.suggest({ input, cwd: this.cwd, shell: this.shell.name, recent: recentCommands(this.shell.id), lastFailure: this.lastFailure }),
    };
  }

  // Places a popup under the cursor (or above it if there's no room).
  positionPopup(el, maxWidth = 560) {
    const m = this.cellMetrics();
    if (!m) return;
    const b = this.term.buffer.active;
    const paneW = this.pane.clientWidth;
    const paneH = this.pane.clientHeight;
    const width = Math.min(maxWidth, paneW - 16);
    el.style.maxWidth = `${width}px`;
    const left = Math.max(8, Math.min(m.left + b.cursorX * m.cellW - 12, paneW - el.offsetWidth - 8));
    const below = m.top + (b.cursorY + 1) * m.cellH + 2;
    const height = el.offsetHeight;
    const above = m.top + b.cursorY * m.cellH - height - 2;
    el.style.left = `${left}px`;
    el.style.top = `${below + height > paneH - 4 && above > 4 ? above : Math.min(below, Math.max(4, paneH - height - 4))}px`;
  }

  renderPicker() {
    const picker = this.picker;
    if (!picker) return;
    const label = PROVIDER_LABELS[state.settings.ai.provider];
    const list = h('ul', { class: 'picker-list' }, picker.items.map((item, i) => {
      const typed = item.kind === 'extend' && item.command.startsWith(picker.input) ? picker.input : '';
      const badges = [];
      if (item.source === 'pinned') badges.push(h('span', { class: 'badge', text: 'pinned' }));
      if (item.source === 'history') badges.push(h('span', { class: 'badge', text: 'history' }));
      if (item.source === 'instant') badges.push(h('span', { class: 'badge', text: 'built-in' }));
      if (item.kind === 'replace') badges.push(h('span', { class: 'badge', text: 'replaces line', title: 'Replaces what you typed' }));
      if (item.destructive) badges.push(h('span', { class: 'badge danger', text: '⚠ destructive', title: 'Can delete data or rewrite history. Ctrl+Enter will insert it without running.' }));
      return h('li', {
        class: `picker-item${i === picker.index ? ' active' : ''}`,
        role: 'option',
        onmousedown: (e) => e.preventDefault(),
        onmousemove: () => this.selectPickerItem(i),
        onclick: (e) => this.choosePickerItem(i, e.ctrlKey),
      },
      h('span', { class: 'num', text: i < 9 ? String(i + 1) : '' }),
      h('div', { class: 'body' },
        h('div', { class: 'line' },
          h('span', { class: 'cmd' }, typed ? h('span', { class: 'typed', text: typed }) : null, item.command.slice(typed.length)),
          ...badges),
        item.note ? h('div', { class: 'note', text: item.note }) : null));
    }));
    // replaceChildren would render null slots as the text "null", so filter them.
    picker.el.replaceChildren(...[
      h('div', { class: 'picker-head' },
        h('span', { text: picker.title }),
        h('span', { class: 'spacer' }),
        picker.loading ? h('span', { class: 'loading', text: `Asking ${label}…` }) : h('span', { class: 'provider', text: label })),
      picker.subtitle ? h('div', { class: 'picker-sub', text: picker.subtitle, title: picker.subtitle }) : null,
      picker.items.length ? list : null,
      picker.message ? h('div', { class: 'picker-msg', text: picker.message }) : null,
      !picker.items.length && !picker.message && picker.loading ? h('div', { class: 'picker-msg', text: 'Thinking…' }) : null,
      h('div', { class: 'picker-foot', text: '↑↓ select · Enter/Tab insert · Ctrl+Enter run · 1–9 pick · Esc close' }),
    ].filter(Boolean));
    this.positionPicker();
  }

  // Anchors the picker under the cursor, flipping above it when there's no room.
  positionPicker() {
    const picker = this.picker;
    const m = this.cellMetrics();
    if (!picker || !m) return;
    const b = this.term.buffer.active;
    const el = picker.el;
    const paneW = this.pane.clientWidth;
    const paneH = this.pane.clientHeight;
    const width = Math.min(640, paneW - 16);
    el.style.width = `${width}px`;
    const left = Math.max(8, Math.min(m.left + b.cursorX * m.cellW - 12, paneW - width - 8));
    const below = m.top + (b.cursorY + 1) * m.cellH + 2;
    const height = el.offsetHeight;
    const top = below + height > paneH - 4 && m.top + b.cursorY * m.cellH - height - 2 > 4
      ? m.top + b.cursorY * m.cellH - height - 2
      : Math.min(below, Math.max(4, paneH - height - 4));
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  }

  selectPickerItem(i) {
    const picker = this.picker;
    if (!picker || i === picker.index || !picker.items[i]) return;
    picker.index = i;
    const rows = picker.el.querySelectorAll('.picker-item');
    rows.forEach((row, n) => row.classList.toggle('active', n === i));
    if (rows[i]) rows[i].scrollIntoView({ block: 'nearest' });
  }

  choosePickerItem(i, run) {
    const picker = this.picker;
    const item = picker && picker.items[i];
    if (!item) return;
    if (picker.mode === 'fix') this.hideFixChip();
    this.closePicker();
    // Destructive suggestions are never run straight from the picker.
    const runNow = run && !item.destructive;
    const r = this.readEditableInput();
    if (!runNow && item.kind === 'extend' && r && !r.after && item.command.startsWith(r.before)) {
      this.justAccepted = item.command;
      api.pty.write(this.ptyId, item.command.slice(r.before.length));
      this.term.focus();
    } else {
      this.insert(item.command, runNow);
    }
    if (run && item.destructive) flashHint('⚠ Destructive command inserted, not run. Review it and press Enter.');
  }

  // Keyboard handling while the picker is open. Returns true if consumed.
  pickerKey(e) {
    const picker = this.picker;
    const plain = !e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey;
    const count = picker.items.length;
    if (e.key === 'Escape') {
      this.closePicker();
      return true;
    }
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && plain) {
      if (count) this.selectPickerItem((picker.index + (e.key === 'ArrowDown' ? 1 : count - 1)) % count);
      return true;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.altKey) {
      if (count) this.choosePickerItem(picker.index, e.ctrlKey);
      else this.closePicker();
      return true;
    }
    if (e.key === 'Tab' && plain) {
      if (count) this.choosePickerItem(picker.index, false);
      return true;
    }
    if (plain && /^[1-9]$/.test(e.key) && Number(e.key) <= count) {
      this.choosePickerItem(Number(e.key) - 1, false);
      return true;
    }
    if (['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'].includes(e.key)) return true;
    // Anything else: close and let the key through, so typing just continues.
    this.closePicker();
    return false;
  }

  closePicker() {
    const picker = this.picker;
    if (!picker) return;
    this.picker = null;
    picker.el.remove();
    if (picker.loading) {
      api.ai.cancel();
      setAiStatus('ok');
    }
    this.lastInput = null;
    this.scheduleUpdate();
  }

  cellMetrics() {
    const screen = this.pane.querySelector('.xterm-screen');
    if (!screen) return null;
    const s = screen.getBoundingClientRect();
    const p = this.pane.getBoundingClientRect();
    return {
      cellW: screen.clientWidth / this.term.cols,
      cellH: screen.clientHeight / this.term.rows,
      left: s.left - p.left,
      top: s.top - p.top,
    };
  }

  showGhost(full, source, input, matches = [full]) {
    this.ghost = { full, source, matches, index: 0 };
    this.renderGhost(input);
    this.ghostHint();
  }

  ghostHint() {
    const g = this.ghost;
    if (!g) return;
    const n = g.matches.length;
    const cycle = n > 1 && state.settings.ai.ghostArrows ? `${g.index + 1}/${n} \u00b7 \u2191\u2193 more \u00b7 ` : '';
    setHint(`${cycle}Tab accept \u00b7 Esc dismiss \u00b7 from history`);
  }

  // Up = older/less likely match, Down = back towards the first one.
  cycleGhost(delta) {
    const g = this.ghost;
    const r = this.readEditableInput();
    if (!g || !r || !g.matches.length) return;
    const n = g.matches.length;
    g.index = (g.index + delta + n) % n;
    g.full = g.matches[g.index];
    this.renderGhost(r.before);
    this.ghostHint();
  }

  // Draws the untyped remainder of the suggestion right after the cursor.
  renderGhost(input) {
    const b = this.term.buffer.active;
    const screen = this.pane.querySelector('.xterm-screen');
    if (!this.ghost || !screen || b.viewportY !== b.baseY) {
      this.ghostEl.classList.remove('visible');
      return;
    }
    const suffix = this.ghost.full.slice(input.length);
    const room = this.term.cols - b.cursorX;
    if (room <= 0) {
      this.ghostEl.classList.remove('visible');
      return;
    }
    const { cellW, cellH, left, top } = this.cellMetrics();
    Object.assign(this.ghostEl.style, {
      left: `${left + b.cursorX * cellW}px`,
      top: `${top + b.cursorY * cellH}px`,
      height: `${cellH}px`,
      lineHeight: `${cellH}px`,
      maxWidth: `${room * cellW}px`,
      fontFamily: FONT_FAMILY,
      fontSize: `${this.term.options.fontSize}px`,
    });
    this.ghostEl.dataset.source = this.ghost.source;
    this.ghostEl.textContent = suffix;
    this.ghostEl.classList.add('visible');
  }

  hideGhost() {
    if (!this.ghost) return;
    this.ghost = null;
    this.ghostEl.classList.remove('visible');
    setHint('');
  }

  acceptGhost() {
    const r = this.readEditableInput();
    const g = this.ghost;
    this.hideGhost();
    if (!r || !g || !g.full.startsWith(r.before)) return;
    this.justAccepted = g.full;
    api.pty.write(this.ptyId, g.full.slice(r.before.length));
  }

  dismissGhost() {
    const r = this.readEditableInput();
    this.hideGhost();
    if (r) this.lastInput = r.before;
  }

  // Replaces the current command line with `command` (history panel).
  insert(command, run) {
    if (this.exited || !this.ptyId) return;
    const r = this.readInput();
    let clear = '';
    if (r && r.text) clear = '\x1b[F' + '\x7f'.repeat([...r.text].length);
    if (!this.integrated && !this.inputStart) {
      const b = this.term.buffer.active;
      this.inputStart = { x: b.cursorX, y: b.baseY + b.cursorY };
    }
    this.hideGhost();
    this.justAccepted = command;
    api.pty.write(this.ptyId, clear + command);
    // Running goes through the same Enter path (and safety guard) as typing.
    if (run) this.whenQuiet().then(() => this.requestEnter());
    this.term.focus();
  }

  onExit(code) {
    this.exited = true;
    this.hideGhost();
    this.term.write(`\r\n\x1b[2m[process exited with code ${code} — press any key to close this tab]\x1b[0m`);
  }

  dispose() {
    this.closePicker();
    this.closePasteOffer();
    if (this.enterPending) clearTimeout(this.enterPending.timer);
    if (this.ptyId) {
      api.pty.kill(this.ptyId);
      ptyTabs.delete(this.ptyId);
    }
    this.term.dispose();
    this.pane.remove();
    this.tabEl.remove();
  }
}

function applyExit(pending) {
  api.history.setExitCode(pending.entry.id, pending.code);
  pending.entry.exitCode = pending.code;
  renderHistory();
}

function defaultShell() {
  return state.shells.find((s) => s.id === state.settings.defaultShell) || state.shells[0];
}

async function newTab(shellId) {
  const shell = state.shells.find((s) => s.id === shellId) || defaultShell();
  if (!shell) return;
  const tab = new Tab(shell);
  state.tabs.push(tab);
  $('tabs').append(tab.tabEl);
  $('terminals').append(tab.pane);
  activate(tab);
  await tab.open();
  tab.term.focus();
}

function activate(tab) {
  if (state.active && state.active !== tab) {
    state.active.hideGhost();
    state.active.closePicker();
  }
  state.active = tab;
  for (const t of state.tabs) {
    t.pane.classList.toggle('active', t === tab);
    t.tabEl.classList.toggle('active', t === tab);
  }
  tab.safeFit();
  tab.term.focus();
  tab.tabEl.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  updateStatus();
  if ($('history-here').checked) renderHistory();
}

function closeTab(tab) {
  const i = state.tabs.indexOf(tab);
  if (i < 0) return;
  state.tabs.splice(i, 1);
  tab.dispose();
  if (state.tabs.length === 0) {
    window.close();
    return;
  }
  if (state.active === tab) activate(state.tabs[Math.min(i, state.tabs.length - 1)]);
}

function cycleTab(delta) {
  if (state.tabs.length < 2) return;
  const i = state.tabs.indexOf(state.active);
  activate(state.tabs[(i + delta + state.tabs.length) % state.tabs.length]);
}

function updateStatus() {
  const t = state.active;
  $('status-shell').textContent = t ? t.shell.name : '';
  $('status-cwd').textContent = t && t.cwd ? t.cwd : '';
  $('status-cwd').title = t && t.cwd ? t.cwd : '';
}

// ------------------------------------------------------------ shell menu

function buildShellMenu() {
  const menu = $('shell-menu');
  menu.replaceChildren(...state.shells.map((s, i) => h('button', {
    onclick: () => { menu.hidden = true; newTab(s.id); },
  }, h('span', { text: s.name }), h('span', { class: 'kbd', text: i < 9 ? `Ctrl+Shift+${i + 1}` : '' }))));
}

function toggleShellMenu() {
  const menu = $('shell-menu');
  const btn = $('shell-menu-btn').getBoundingClientRect();
  menu.style.left = `${btn.left}px`;
  menu.hidden = !menu.hidden;
}

// --------------------------------------------------------- history panel

let historyRenderQueued = false;
let historySelected = 0;

function renderHistory() {
  if (historyRenderQueued) return;
  historyRenderQueued = true;
  requestAnimationFrame(() => {
    historyRenderQueued = false;
    renderHistoryNow();
  });
}

function filteredHistory() {
  const q = $('history-search').value.trim().toLowerCase();
  if (state.historyView === 'pinned') {
    return state.pins.filter((p) => !q || p.command.toLowerCase().includes(q));
  }
  const here = $('history-here').checked && state.active ? state.active.cwd : null;
  const items = [];
  const seen = new Set();
  for (let i = state.history.length - 1; i >= 0 && items.length < 300; i--) {
    const e = state.history[i];
    if (seen.has(e.command)) continue;
    if (q && !e.command.toLowerCase().includes(q)) continue;
    if ($('history-here').checked && e.cwd !== here) continue;
    if ($('history-shell').checked && state.active && shellKind(e.shell) !== shellKind(state.active.shell.id)) continue;
    seen.add(e.command);
    items.push(e);
  }
  return items;
}

function renderHistoryNow() {
  if (document.body.classList.contains('history-hidden')) return;
  const pinnedView = state.historyView === 'pinned';
  const items = filteredHistory();
  historySelected = Math.min(historySelected, Math.max(0, items.length - 1));
  const focused = document.activeElement === $('history-search');
  $('history-list').replaceChildren(...items.map((e, i) => (pinnedView ? pinItem(e, i, items.length) : historyItem(e))(i === historySelected && focused)));
  $('pin-count').textContent = state.pins.length ? String(state.pins.length) : '';
  $('history-here-label').hidden = pinnedView;
  $('history-clear').hidden = pinnedView;
  $('history-search').placeholder = pinnedView ? 'Search pinned…' : 'Search history…';
  if (pinnedView) {
    $('history-count').textContent = state.pins.length ? `${items.length} of ${state.pins.length} pinned` : 'Pin commands from Recent with ☆';
  } else {
    $('history-count').textContent = `${items.length}${items.length === 300 ? '+' : ''} shown · ${state.history.length} total`;
  }
}

const SHELL_SHORT = { powershell: 'PS', cmd: 'cmd', bash: 'bash', wsl: 'wsl' };

// Small label on entries recorded in a different kind of shell than this tab.
function shellBadge(shell) {
  if (!shell || !state.active || shellKind(shell) === shellKind(state.active.shell.id)) return null;
  const kind = shellKind(shell);
  return h('span', { class: 'shell-tag', text: SHELL_SHORT[kind] || kind, title: 'Recorded in ' + (kind === 'powershell' ? 'PowerShell' : kind) });
}

function isPinned(command) {
  return state.pins.some((p) => p.command === command);
}

async function togglePin(entry) {
  try {
    const pin = state.pins.find((p) => p.command === entry.command);
    state.pins = pin ? await api.pins.remove(pin.id) : await api.pins.add({ command: entry.command, shell: entry.shell, cwd: entry.cwd });
  } catch (err) {
    setHint(cleanError(err));
  }
  renderHistory();
}

function commandItem(command, { selected, title, meta, buttons }) {
  return h('li', {
    class: `history-item${selected ? ' selected' : ''}`,
    title: `${command}\n\nClick to insert · double-click to run${title ? `\n${title}` : ''}`,
    onclick: () => state.active && state.active.insert(command, false),
    ondblclick: () => state.active && state.active.insert(command, true),
  },
  h('div', { class: 'cmd', text: command }),
  h('div', { class: 'meta' }, ...meta),
  h('div', { class: 'item-actions' }, ...buttons.map(([text, label, fn, extra]) => h('button', {
    class: extra || '',
    title: label,
    onclick: (ev) => { ev.stopPropagation(); fn(); },
  }, text))));
}

function historyItem(e) {
  let status;
  if (e.exitCode === 0) status = h('span', { class: 'ok', text: '✓', title: 'Exit code 0' });
  else if (Number.isInteger(e.exitCode)) status = h('span', { class: 'fail', text: `✗ ${e.exitCode}`, title: `Exit code ${e.exitCode}` });
  else status = h('span', { text: '·', title: 'Exit code unknown' });
  const pinned = isPinned(e.command);
  return (selected) => commandItem(e.command, {
    selected,
    title: e.cwd,
    meta: [status, shellBadge(e.shell), h('span', { class: 'where', text: e.cwd || (e.imported ? `imported from ${e.importedFrom || 'PSReadLine'}` : '') }), e.imported ? null : h('span', { text: relativeTime(e.ts) })],
    buttons: [
      [pinned ? '★' : '☆', pinned ? 'Unpin' : 'Pin', () => togglePin(e), pinned ? 'pinned' : ''],
      ['×', 'Delete from history', async () => {
        const ids = state.history.filter((x) => x.command === e.command).map((x) => x.id);
        for (const id of ids) await api.history.remove(id);
        state.history = state.history.filter((x) => x.command !== e.command);
        renderHistory();
      }],
    ],
  });
}

function pinItem(p, index, count) {
  const shell = state.shells.find((s) => s.id === p.shell);
  return (selected) => commandItem(p.command, {
    selected,
    title: p.cwd,
    meta: [h('span', { class: 'where', text: p.cwd || '' }), shell ? h('span', { text: shell.name }) : null],
    buttons: [
      ['↑', 'Move up', async () => { state.pins = await api.pins.move(p.id, -1); renderHistory(); }, index === 0 ? 'hidden-btn' : ''],
      ['↓', 'Move down', async () => { state.pins = await api.pins.move(p.id, 1); renderHistory(); }, index === count - 1 ? 'hidden-btn' : ''],
      ['★', 'Unpin', () => togglePin(p), 'pinned'],
    ],
  });
}

function setHistoryView(view) {
  state.historyView = view;
  historySelected = 0;
  for (const b of document.querySelectorAll('.panel-seg button')) b.classList.toggle('active', b.dataset.view === view);
  renderHistoryNow();
}

function toggleHistory(force) {
  const hidden = force === undefined ? !document.body.classList.contains('history-hidden') : !force;
  document.body.classList.toggle('history-hidden', hidden);
  api.settings.set({ historyPanelOpen: !hidden }).then((s) => (state.settings = s));
  if (!hidden) {
    renderHistoryNow();
    $('history-search').focus();
    $('history-search').select();
  } else if (state.active) {
    state.active.term.focus();
  }
  requestAnimationFrame(() => state.active && state.active.safeFit());
}

function wireHistoryPanel() {
  const search = $('history-search');
  search.addEventListener('input', () => { historySelected = 0; renderHistory(); });
  search.addEventListener('focus', renderHistory);
  search.addEventListener('blur', renderHistory);
  search.addEventListener('keydown', (e) => {
    const items = filteredHistory();
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      historySelected = Math.max(0, Math.min(items.length - 1, historySelected + (e.key === 'ArrowDown' ? 1 : -1)));
      renderHistoryNow();
      const el = $('history-list').children[historySelected];
      if (el) el.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter' && items[historySelected] && state.active) {
      e.preventDefault();
      state.active.insert(items[historySelected].command, e.ctrlKey);
    } else if (e.key === 'Escape' && state.active) {
      state.active.term.focus();
    }
  });
  for (const b of document.querySelectorAll('.panel-seg button')) {
    b.addEventListener('click', () => setHistoryView(b.dataset.view));
  }
  $('history-here').addEventListener('change', renderHistory);
  $('history-shell').addEventListener('change', renderHistory);
  $('history-close').addEventListener('click', () => toggleHistory(false));
  $('btn-history').addEventListener('click', () => toggleHistory());
  $('history-clear').addEventListener('click', async () => {
    if (!window.confirm('Delete all saved history?')) return;
    await api.history.clear();
    state.history = [];
    renderHistory();
  });
  setInterval(renderHistory, 60000);
}

// -------------------------------------------------------------- settings

function applyAppearance() {
  const s = state.settings;
  document.body.dataset.theme = s.theme;
  for (const t of state.tabs) {
    t.term.options.theme = THEMES[s.theme];
    t.term.options.fontSize = s.fontSize;
    t.safeFit();
  }
}

function showMsg(el, text, kind) {
  el.textContent = text || '';
  el.className = `msg ${kind || ''}`;
  el.hidden = !text;
}

const KEY_ENV = {
  anthropic: 'ANTHROPIC_API_KEY',
  'foundry-claude': 'ANTHROPIC_FOUNDRY_API_KEY',
  'azure-openai': 'AZURE_OPENAI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
};

const KEY_PLACEHOLDER = {
  anthropic: 'sk-ant-…',
  'foundry-claude': 'Foundry resource key',
  'azure-openai': 'Azure OpenAI resource key',
  openrouter: 'sk-or-…',
};

function keyStatusText(provider, status) {
  const env = KEY_ENV[provider];
  let text;
  if (status === 'stored') text = 'A key is saved in TerminalS (encrypted with Windows DPAPI).';
  else if (status === 'env') text = `Using ${env} from your environment.`;
  else if (status === 'env-mismatch') text = `${env} is set, but it's only used with the endpoint from your environment. Clear the endpoint field to use it, or save a key for this endpoint.`;
  else text = `No key found. Paste one above, or set $env:${env} for your session.`;
  if (provider === 'foundry-claude' || provider === 'azure-openai') {
    text += ' If your organisation discourages long-lived resource keys, use Entra ID sign-in instead.';
  }
  return text;
}

// Shows the fields for the selected provider and the key row only when a key is used.
function renderProviderFields() {
  const s = state.settings;
  const provider = s.ai.provider;
  $('set-provider').value = provider;
  for (const g of document.querySelectorAll('.provider-grid')) g.hidden = g.dataset.provider !== provider;
  const fc = s.ai['foundry-claude'];
  const ao = s.ai['azure-openai'];
  const or = s.ai.openrouter;
  for (const [id, value] of [['set-fc-resource', fc.resource], ['set-fc-model', fc.model], ['set-fc-auth', fc.auth],
    ['set-ao-endpoint', ao.endpoint], ['set-ao-deployment', ao.deployment], ['set-ao-version', ao.apiVersion], ['set-ao-auth', ao.auth],
    ['set-or-model', or.model]]) {
    if (document.activeElement !== $(id)) $(id).value = value;
  }
  const env = s.envDefaults || {};
  $('set-fc-resource').placeholder = env['foundry-claude'] ? `from ANTHROPIC_FOUNDRY_BASE_URL: ${env['foundry-claude']}` : 'my-resource   or   https://my-resource.services.ai.azure.com/anthropic/';
  $('set-ao-endpoint').placeholder = env['azure-openai'] ? `from AZURE_OPENAI_ENDPOINT: ${env['azure-openai']}` : 'https://my-resource.openai.azure.com/';
  const usesEntra = Boolean(s.ai[provider] && s.ai[provider].auth === 'entra');
  $('key-grid').hidden = usesEntra;
  $('set-key').placeholder = KEY_PLACEHOLDER[provider];
  $('set-key-status').textContent = keyStatusText(provider, s.keys[provider]);
  $('set-test-result').textContent = usesEntra ? 'Uses short-lived Entra ID tokens from az login, Azure PowerShell or a managed identity.' : '';
}

function openSettings() {
  const s = state.settings;
  $('set-theme').value = s.theme;
  $('set-font').value = s.fontSize;
  $('set-shell').replaceChildren(...state.shells.map((sh) => h('option', { value: sh.id, text: sh.name })));
  $('set-shell').value = defaultShell() ? defaultShell().id : '';
  $('set-ai').checked = s.ai.enabled;
  $('set-ctx').checked = s.ai.sendContext;
  $('set-dbl').checked = s.ai.doubleSpace;
  $('set-dbl-ms').value = s.ai.doubleSpaceMs;
  $('set-hotkey').value = s.ai.hotkey;
  $('set-count').value = s.ai.count;
  $('set-ghost').checked = s.ai.ghost;
  $('set-ghost-arrows').checked = s.ai.ghostArrows;
  $('set-rclick').checked = s.rightClick;
  $('set-model').replaceChildren(...s.models.map((m) => h('option', { value: m, text: m + (m === 'claude-opus-5' ? ' (default)' : m === 'claude-haiku-4-5' ? ' (fastest)' : '') })));
  $('set-model').value = s.ai.model;
  $('set-key').value = '';
  $('about-version').textContent = s.version ? `v${s.version}` : '';
  renderProviderFields();
  fillTools();
  showMsg($('settings-msg'), '');
  $('settings-dialog').showModal();
}

async function saveSettings(patch) {
  try {
    state.settings = await api.settings.set(patch);
    applyAppearance();
    setAiStatus('ok');
    renderProviderFields();
    fillTools();
    renderUsagePill();
    showMsg($('settings-msg'), '');
    return true;
  } catch (err) {
    showMsg($('settings-msg'), cleanError(err), 'error');
    return false;
  }
}

const GUARD_LABELS = {
  files: 'Deleting files',
  git: 'Git history',
  disk: 'Disks',
  database: 'Databases',
  system: 'System settings',
  cloud: 'Cloud & containers',
  remote: 'Downloaded scripts',
};

function showSettingsTab(name) {
  for (const b of document.querySelectorAll('.settings-seg button')) b.classList.toggle('active', b.dataset.tab === name);
  for (const sec of document.querySelectorAll('#settings-dialog section[data-tab]')) sec.hidden = sec.dataset.tab !== name;
  if (name === 'usage') refreshUsage();
}

// Puts the current tool settings into the Tools and Usage tabs.
function fillTools() {
  const t = state.settings.tools;
  for (const grid of document.querySelectorAll('#settings-dialog .grid[data-tool]')) {
    const tool = t[grid.dataset.tool];
    for (const el of grid.querySelectorAll('[data-key]')) {
      if (document.activeElement === el) continue;
      const v = tool[el.dataset.key];
      if (el.type === 'checkbox') el.checked = Boolean(v);
      else if ('list' in el.dataset) el.value = (v || []).join(', ');
      else el.value = v;
    }
  }
  const cats = new Set(t.guard.categories);
  $('set-guard-cats').replaceChildren(...Object.entries(GUARD_LABELS).map(([key, label]) => h('label', { class: 'check' },
    h('input', { type: 'checkbox', checked: cats.has(key), 'data-cat': key, onchange: saveGuardCategories }), label)));
  if (document.activeElement !== $('set-excluded')) $('set-excluded').value = t.excludedFolders.join('\n');
}

function saveGuardCategories() {
  const categories = [...document.querySelectorAll('#set-guard-cats input:checked')].map((el) => el.dataset.cat);
  saveSettings({ tools: { guard: { categories } } });
}

function renderUsage() {
  const u = state.usage;
  if (!u) return;
  const row = (label, d) => h('tr', {},
    h('th', { text: label }),
    h('td', { text: d.requests.toLocaleString() }),
    h('td', { text: d.inputTokens.toLocaleString() }),
    h('td', { text: d.outputTokens.toLocaleString() }),
    h('td', { text: fmtCost(d.costUsd) }),
    h('td', { text: d.errors.toLocaleString() }));
  $('usage-table').tBodies[0].replaceChildren(row('Today', u.today), row('7 days', u.week), row('30 days', u.month));
  const types = Object.entries(u.month.byType).map(([k, v]) => `${{ suggest: 'suggestions', fix: 'fixes', translate: 'translations', test: 'tests' }[k] || k}: ${v}`);
  $('usage-bytype').textContent = types.length ? `Last 30 days by feature \u2014 ${types.join(' \u00b7 ')}` : 'No AI requests yet.';
}

function wireSettings() {
  $('btn-settings').addEventListener('click', openSettings);
  for (const b of document.querySelectorAll('.settings-seg button')) b.addEventListener('click', () => showSettingsTab(b.dataset.tab));

  // Tools/Usage controls save on change; the main process validates them.
  for (const grid of document.querySelectorAll('#settings-dialog .grid[data-tool]')) {
    for (const el of grid.querySelectorAll('[data-key]')) {
      el.addEventListener('change', () => {
        let value;
        if (el.type === 'checkbox') value = el.checked;
        else if ('int' in el.dataset) value = clampInput(el, Number(el.min), Number(el.max));
        else if ('list' in el.dataset) value = el.value.split(',').map((x) => x.trim()).filter(Boolean);
        else value = el.value;
        saveSettings({ tools: { [grid.dataset.tool]: { [el.dataset.key]: value } } });
      });
    }
  }
  $('set-excluded').addEventListener('change', (e) => {
    saveSettings({ tools: { excludedFolders: e.target.value.split(/\r?\n/).map((x) => x.trim()).filter(Boolean) } });
  });
  $('usage-reset').addEventListener('click', async () => {
    if (!window.confirm('Reset all AI usage counters?')) return;
    state.usage = await api.usage.reset();
    renderUsage();
    renderUsagePill();
  });
  $('set-theme').addEventListener('change', (e) => saveSettings({ theme: e.target.value }));
  $('set-font').addEventListener('change', (e) => saveSettings({ fontSize: Number.parseInt(e.target.value, 10) }));
  $('set-shell').addEventListener('change', (e) => saveSettings({ defaultShell: e.target.value }));
  $('set-ai').addEventListener('change', (e) => saveSettings({ ai: { enabled: e.target.checked } }));
  $('set-ctx').addEventListener('change', (e) => saveSettings({ ai: { sendContext: e.target.checked } }));
  $('set-dbl').addEventListener('change', (e) => saveSettings({ ai: { doubleSpace: e.target.checked } }));
  $('set-dbl-ms').addEventListener('change', (e) => saveSettings({ ai: { doubleSpaceMs: clampInput(e.target, 150, 800) } }));
  $('set-hotkey').addEventListener('change', (e) => saveSettings({ ai: { hotkey: e.target.value } }));
  $('set-count').addEventListener('change', (e) => saveSettings({ ai: { count: clampInput(e.target, 3, 10) } }));
  $('set-ghost').addEventListener('change', (e) => saveSettings({ ai: { ghost: e.target.checked } }));
  $('set-ghost-arrows').addEventListener('change', (e) => saveSettings({ ai: { ghostArrows: e.target.checked } }));
  $('set-rclick').addEventListener('change', (e) => saveSettings({ rightClick: e.target.checked }));
  $('set-provider').addEventListener('change', (e) => saveSettings({ ai: { provider: e.target.value } }));
  $('set-model').addEventListener('change', (e) => saveSettings({ ai: { model: e.target.value } }));

  // Provider fields save on change; the main process validates them.
  for (const g of document.querySelectorAll('.provider-grid[data-provider]:not([data-provider="anthropic"])')) {
    for (const el of g.querySelectorAll('[data-field]')) {
      el.addEventListener('change', () => saveSettings({ ai: { [g.dataset.provider]: { [el.dataset.field]: el.value } } }));
    }
  }

  $('set-key-save').addEventListener('click', async () => {
    const provider = state.settings.ai.provider;
    try {
      state.settings = await api.ai.setKey(provider, $('set-key').value);
      $('set-key').value = '';
      renderProviderFields();
      showMsg($('settings-msg'), 'API key saved.', 'notice');
      setAiStatus('ok');
    } catch (err) {
      showMsg($('settings-msg'), cleanError(err), 'error');
    }
  });
  $('set-key-clear').addEventListener('click', async () => {
    state.settings = await api.ai.clearKey(state.settings.ai.provider);
    renderProviderFields();
    setAiStatus('ok');
  });
  $('set-test').addEventListener('click', async () => {
    const out = $('set-test-result');
    out.textContent = 'Testing…';
    $('set-test').disabled = true;
    try {
      const res = await api.ai.test();
      if (res.status === 'ok') out.textContent = `Connected in ${res.ms} ms${res.suggestion ? ` — suggested “${res.suggestion}”` : ' (no suggestion returned)'}.`;
      else if (res.status === 'no-key') out.textContent = 'No API key for this provider yet.';
      else if (res.status === 'not-configured') out.textContent = 'Fill in the endpoint/resource and deployment (or model) first.';
      else if (res.status === 'key-endpoint-mismatch') out.textContent = 'The environment key only works with the environment endpoint. Clear the endpoint field or save a key.';
      else out.textContent = res.error || `Failed (${res.status}).`;
    } finally {
      $('set-test').disabled = false;
    }
  });
}

function clampInput(el, min, max) {
  const n = Math.min(max, Math.max(min, Math.round(Number(el.value) || min)));
  el.value = n;
  return n;
}

// Errors thrown in the main process arrive as "Error invoking remote method 'x': Error: msg".
function cleanError(err) {
  return String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

// ------------------------------------------------ environment & startup

const profilesUi = { data: null, editing: null, drafts: {}, kind: 'powershell' };

function scopeLabel(scope) {
  if (scope === 'all') return 'All shells';
  const s = state.shells.find((x) => x.id === scope);
  return s ? s.name : scope;
}

async function openProfiles(pane) {
  profilesUi.data = await api.profiles.get();
  profilesUi.drafts = { ...profilesUi.data.scripts };
  profilesUi.editing = null;
  $('env-scope').replaceChildren(h('option', { value: 'all', text: 'All shells' }), ...state.shells.map((s) => h('option', { value: s.id, text: s.name })));
  showMsg($('profiles-msg'), profilesUi.data.encryptionAvailable ? '' : 'Windows encryption is unavailable, so secret variables cannot be stored.', 'error');
  showProfilesPane(pane || 'env');
  renderEnv();
  loadScript(profilesUi.kind);
  $('profiles-dialog').showModal();
}

function showProfilesPane(name) {
  for (const b of document.querySelectorAll('#profiles-dialog .seg button')) b.classList.toggle('active', b.dataset.pane === name);
  for (const s of document.querySelectorAll('#profiles-dialog section[data-pane]')) s.hidden = s.dataset.pane !== name;
}

function renderEnv() {
  const vars = profilesUi.data.env;
  $('env-empty').hidden = vars.length > 0;
  $('env-table').hidden = vars.length === 0;
  $('env-table').tBodies[0].replaceChildren(...vars.map((v, i) => h('tr', { class: v.enabled ? '' : 'disabled' },
    h('td', {}, h('input', { type: 'checkbox', checked: v.enabled, title: 'Enabled', onchange: (e) => saveEnv({ ...v, enabled: e.target.checked }) })),
    h('td', { class: 'name' }, v.name, v.secret ? h('span', { class: 'badge', text: 'secret' }) : null),
    h('td', { class: 'value', title: v.secret ? 'Encrypted — value hidden' : v.value, text: v.secret ? '••••••••' : v.value }),
    h('td', { text: { set: 'Set', prepend: 'Prepend', append: 'Append' }[v.mode] }),
    h('td', { text: scopeLabel(v.scope) }),
    h('td', { class: 'actions' },
      h('button', { title: 'Move up', disabled: i === 0, onclick: () => moveEnv(v.id, -1) }, '↑'),
      h('button', { title: 'Move down', disabled: i === vars.length - 1, onclick: () => moveEnv(v.id, 1) }, '↓'),
      h('button', { title: 'Edit', onclick: () => editEnv(v) }, 'Edit'),
      h('button', { title: 'Delete', onclick: () => deleteEnv(v) }, 'Delete')))));
}

function editEnv(v) {
  profilesUi.editing = v ? v.id : null;
  $('env-name').value = v ? v.name : '';
  $('env-value').value = v && !v.secret ? v.value : '';
  $('env-value').placeholder = v && v.secret ? 'leave blank to keep the current secret' : 'value';
  $('env-secret').checked = v ? v.secret : false;
  $('env-value').type = $('env-secret').checked ? 'password' : 'text';
  $('env-mode').value = v ? v.mode : 'set';
  $('env-scope').value = v ? v.scope : 'all';
  $('env-form').hidden = false;
  $('env-add').hidden = true;
  $('env-name').focus();
}

function closeEnvForm() {
  $('env-form').hidden = true;
  $('env-add').hidden = false;
  profilesUi.editing = null;
}

async function saveEnv(v) {
  try {
    const { profiles, notice } = await api.profiles.saveEnv(v);
    profilesUi.data = profiles;
    renderEnv();
    showMsg($('profiles-msg'), notice || '', 'notice');
    return true;
  } catch (err) {
    showMsg($('profiles-msg'), cleanError(err), 'error');
    return false;
  }
}

async function moveEnv(id, delta) {
  profilesUi.data = await api.profiles.moveEnv(id, delta);
  renderEnv();
}

async function deleteEnv(v) {
  if (!window.confirm(`Delete ${v.name}?`)) return;
  profilesUi.data = await api.profiles.deleteEnv(v.id);
  renderEnv();
}

function loadScript(kind) {
  profilesUi.kind = kind;
  $('script-kind').value = kind;
  $('script-text').value = profilesUi.drafts[kind] || '';
  updateScriptDirty();
}

function updateScriptDirty() {
  const kind = profilesUi.kind;
  const dirty = (profilesUi.drafts[kind] || '') !== (profilesUi.data.scripts[kind] || '');
  $('script-dirty').textContent = dirty ? 'Unsaved changes' : '';
}

function wireProfiles() {
  $('btn-profiles').addEventListener('click', () => openProfiles());
  for (const b of document.querySelectorAll('#profiles-dialog .seg button')) {
    b.addEventListener('click', () => showProfilesPane(b.dataset.pane));
  }
  $('env-add').addEventListener('click', () => editEnv(null));
  $('env-cancel').addEventListener('click', closeEnvForm);
  $('env-secret').addEventListener('change', (e) => { $('env-value').type = e.target.checked ? 'password' : 'text'; });
  $('env-name').addEventListener('input', (e) => {
    if (!profilesUi.editing && /^path$/i.test(e.target.value) && $('env-mode').value === 'set') $('env-mode').value = 'prepend';
  });
  const submit = async () => {
    const existing = profilesUi.data.env.find((x) => x.id === profilesUi.editing);
    const ok = await saveEnv({
      id: profilesUi.editing,
      name: $('env-name').value,
      value: $('env-value').value,
      secret: $('env-secret').checked,
      mode: $('env-mode').value,
      scope: $('env-scope').value,
      enabled: existing ? existing.enabled : true,
    });
    if (ok) closeEnvForm();
  };
  $('env-save').addEventListener('click', submit);
  $('env-form').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); submit(); }
  });

  $('script-kind').addEventListener('change', (e) => loadScript(e.target.value));
  $('script-text').addEventListener('input', (e) => {
    profilesUi.drafts[profilesUi.kind] = e.target.value;
    updateScriptDirty();
  });
  $('script-text').addEventListener('keydown', (e) => {
    if (e.key === 'Tab' && !e.ctrlKey) {
      e.preventDefault();
      document.execCommand('insertText', false, '  ');
    }
    if (e.key === 's' && e.ctrlKey) {
      e.preventDefault();
      $('script-save').click();
    }
  });
  $('script-save').addEventListener('click', async () => {
    try {
      profilesUi.data = await api.profiles.saveScript(profilesUi.kind, profilesUi.drafts[profilesUi.kind] || '');
      updateScriptDirty();
      showMsg($('profiles-msg'), 'Startup script saved. It will run in new tabs.', 'notice');
    } catch (err) {
      showMsg($('profiles-msg'), cleanError(err), 'error');
    }
  });
  $('profiles-newtab').addEventListener('click', () => {
    $('profiles-dialog').close();
    newTab(state.active ? state.active.shell.id : undefined);
  });
}

// ------------------------------------------------------------ shortcuts

function isAppShortcut(e) {
  if (!e.ctrlKey || e.altKey) return false;
  if (e.shiftKey && ['KeyT', 'KeyW', 'KeyH', 'KeyE', 'Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9'].includes(e.code)) return true;
  if (e.code === 'Tab' || e.code === 'Comma') return true;
  return false;
}

function onGlobalKey(e) {
  if (!isAppShortcut(e)) return;
  e.preventDefault();
  e.stopPropagation();
  if (e.code === 'Tab') return cycleTab(e.shiftKey ? -1 : 1);
  if (e.code === 'Comma') return openSettings();
  if (e.code === 'KeyT') return newTab(state.active ? state.active.shell.id : undefined);
  if (e.code === 'KeyW') return state.active && closeTab(state.active);
  if (e.code === 'KeyH') return toggleHistory();
  if (e.code === 'KeyE') return openProfiles();
  if (e.code.startsWith('Digit')) {
    const s = state.shells[Number(e.code.slice(5)) - 1];
    if (s) newTab(s.id);
  }
}

// ------------------------------------------------------------------ boot

async function boot() {
  [state.shells, state.settings, state.history, state.pins] = await Promise.all([api.shells(), api.settings.get(), api.history.list(), api.pins.list()]);
  applyAppearance();
  document.body.classList.toggle('history-hidden', !state.settings.historyPanelOpen);
  setAiStatus('ok');
  refreshUsage();

  api.pty.onData((id, data) => {
    const t = ptyTabs.get(id);
    if (t) t.term.write(data);
  });
  api.pty.onExit((id, code) => {
    const t = ptyTabs.get(id);
    if (t) t.onExit(code);
  });

  buildShellMenu();
  $('new-tab').addEventListener('click', () => newTab());
  $('shell-menu-btn').addEventListener('click', (e) => { e.stopPropagation(); toggleShellMenu(); });
  document.addEventListener('click', () => { $('shell-menu').hidden = true; });
  document.addEventListener('mousedown', (e) => {
    const t = state.active;
    if (t && t.picker && !t.picker.el.contains(e.target)) t.closePicker();
  });
  document.addEventListener('keydown', onGlobalKey, true);
  for (const d of document.querySelectorAll('dialog')) {
    const closeBtn = d.querySelector('[data-close]');
    if (closeBtn) closeBtn.addEventListener('click', () => d.close());
    d.addEventListener('close', () => state.active && state.active.term.focus());
  }
  window.addEventListener('resize', () => state.active && state.active.scheduleUpdate());

  wireHistoryPanel();
  wireSettings();
  wireProfiles();
  renderHistoryNow();

  if (state.shells.length === 0) {
    document.getElementById('terminals').append(h('p', { class: 'empty', text: 'No supported shells were found on this machine.' }));
    return;
  }
  await newTab();
}

boot();
