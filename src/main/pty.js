'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const pty = require('node-pty');
const store = require('./store');
const { freshEnv } = require('./winenv');

// Shells read these scripts from disk, so in a packaged build they live in
// app.asar.unpacked (outside processes can't read inside the asar archive).
const INTEGRATION_DIR = path.join(__dirname, 'shell-integration').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');

// Environment variables from the Electron host that shouldn't leak into shells.
const HOST_ONLY_ENV = /^(ELECTRON_|CHROME_|GOOGLE_API_KEY$|NODE_OPTIONS$)/i;

// lstat rather than existsSync: Microsoft Store installs (e.g. pwsh) are App
// Execution Aliases, which stat() reports as EACCES even though they launch.
function exists(p) {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

function which(exe) {
  for (const dir of (process.env.PATH || '').split(';')) {
    if (!dir) continue;
    const full = path.join(dir, exe);
    if (exists(full)) return full;
  }
  return null;
}

function firstExisting(paths) {
  return paths.find((p) => p && exists(p)) || null;
}

let shellCache = null;

function detectShells() {
  if (shellCache) return shellCache;
  const sys = process.env.SystemRoot || 'C:\\Windows';
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const candidates = [
    { id: 'pwsh', name: 'PowerShell 7', kind: 'powershell', file: which('pwsh.exe') || firstExisting([path.join(pf, 'PowerShell', '7', 'pwsh.exe')]) },
    { id: 'powershell', name: 'Windows PowerShell', kind: 'powershell', file: firstExisting([path.join(sys, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')]) },
    { id: 'cmd', name: 'Command Prompt', kind: 'cmd', file: firstExisting([process.env.ComSpec, path.join(sys, 'System32', 'cmd.exe')]) },
    { id: 'gitbash', name: 'Git Bash', kind: 'bash', file: firstExisting([path.join(pf, 'Git', 'bin', 'bash.exe'), path.join(local, 'Programs', 'Git', 'bin', 'bash.exe')]) },
    { id: 'wsl', name: 'WSL', kind: 'wsl', file: firstExisting([path.join(sys, 'System32', 'wsl.exe')]) },
  ];
  shellCache = candidates.filter((s) => s.file);
  return shellCache;
}

function toMsysPath(p) {
  return p.replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`).replace(/\\/g, '/');
}

function psQuote(p) {
  return `'${p.replace(/'/g, "''")}'`;
}

function launchSpec(shell) {
  const script = store.scriptPath(shell.kind);
  const extraEnv = {};
  let args = [];

  switch (shell.kind) {
    case 'powershell':
      args = ['-NoLogo', '-NoExit', '-Command', `try { . ${psQuote(path.join(INTEGRATION_DIR, 'powershell.ps1'))} } catch {}`];
      if (script) extraEnv.TERMINALS_PRESCRIPT = script;
      break;
    case 'cmd': {
      const userPrompt = process.env.PROMPT || '$P$G';
      extraEnv.PROMPT = `$e]633;D$e\\$e]633;P;Cwd=$P$e\\$e]633;A$e\\${userPrompt}$e]633;B$e\\`;
      args = ['/K', path.join(INTEGRATION_DIR, 'cmd.cmd')];
      if (script) extraEnv.TERMINALS_PRESCRIPT = script;
      break;
    }
    case 'bash':
      args = ['--rcfile', toMsysPath(path.join(INTEGRATION_DIR, 'bash.sh')), '-i'];
      if (script) extraEnv.TERMINALS_PRESCRIPT = toMsysPath(script);
      break;
    default:
      args = [];
  }
  return { args, extraEnv };
}

// Our own environment refreshed from the registry, so each new tab sees
// variables and PATH entries added since TerminalS started.
async function baseEnv() {
  const env = {};
  for (const [k, v] of Object.entries(await freshEnv({ ...process.env }))) {
    if (!HOST_ONLY_ENV.test(k)) env[k] = v;
  }
  env.TERM_PROGRAM = 'TerminalS';
  env.COLORTERM = 'truecolor';
  return env;
}

class PtyManager {
  constructor(send) {
    this.send = send;
    this.ptys = new Map();
    this.nextId = 1;
  }

  async create(shellId, cols, rows) {
    const shell = detectShells().find((s) => s.id === shellId);
    if (!shell) throw new Error(`Unknown shell: ${shellId}`);
    const { args, extraEnv } = launchSpec(shell);
    const env = { ...store.applyEnv(await baseEnv(), shell.id), ...extraEnv };
    const proc = pty.spawn(shell.file, args, {
      name: 'xterm-256color',
      cols: clampInt(cols, 2, 1000, 120),
      rows: clampInt(rows, 1, 500, 30),
      cwd: os.homedir(),
      env,
      useConpty: true,
    });

    const id = this.nextId++;
    let buffer = '';
    let timer = null;
    const flush = () => {
      timer = null;
      if (buffer) this.send('pty:data', id, buffer);
      buffer = '';
    };
    // Coalesce bursts of output into fewer IPC messages.
    proc.onData((data) => {
      buffer += data;
      if (buffer.length > 64 * 1024) flush();
      else if (!timer) timer = setTimeout(flush, 4);
    });
    proc.onExit(({ exitCode }) => {
      flush();
      this.ptys.delete(id);
      this.send('pty:exit', id, exitCode);
    });
    this.ptys.set(id, proc);
    return { id, shell: { id: shell.id, name: shell.name, kind: shell.kind } };
  }

  write(id, data) {
    const proc = this.ptys.get(id);
    if (proc && typeof data === 'string' && data.length <= 1024 * 1024) proc.write(data);
  }

  resize(id, cols, rows) {
    const proc = this.ptys.get(id);
    if (!proc) return;
    try {
      proc.resize(clampInt(cols, 2, 1000, 80), clampInt(rows, 1, 500, 24));
    } catch {
      // The process may have exited between the check and the resize.
    }
  }

  kill(id) {
    const proc = this.ptys.get(id);
    if (proc) {
      this.ptys.delete(id);
      try { proc.kill(); } catch { /* already gone */ }
    }
  }

  killAll() {
    for (const id of [...this.ptys.keys()]) this.kill(id);
  }
}

function clampInt(v, min, max, fallback) {
  return Number.isInteger(v) ? Math.min(max, Math.max(min, v)) : fallback;
}

module.exports = { PtyManager, detectShells };
