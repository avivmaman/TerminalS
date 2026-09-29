'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { looksSensitive } = require('./redact');
const store = require('./store');

const MAX_ENTRIES = 5000;
const MAX_COMMAND = 4096;

let entries = null;
let saveTimer = null;

function file() {
  return path.join(store.dataDir(), 'history.json');
}

function load() {
  if (!entries) {
    const saved = store.readJson(file(), []);
    entries = Array.isArray(saved) ? saved : [];
  }
  return entries;
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, 500);
}

function flush() {
  clearTimeout(saveTimer);
  if (entries) store.writeJsonAtomic(file(), entries);
}

function newId() {
  return `h${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

function list() {
  return load();
}

// Adds a command. Commands that look like they contain credentials are not
// persisted (same idea as PSReadLine's sensitive-history filter). Returns the
// new entry, or null if it was skipped.
function add({ command, cwd, shell }) {
  if (typeof command !== 'string') return null;
  const cmd = command.trim();
  if (!cmd || cmd.length > MAX_COMMAND || looksSensitive(cmd)) return null;
  const all = load();
  const entry = {
    id: newId(),
    command: cmd,
    cwd: typeof cwd === 'string' ? cwd.slice(0, 1024) : null,
    shell: typeof shell === 'string' ? shell.slice(0, 32) : null,
    ts: Date.now(),
    exitCode: null,
  };
  const last = all[all.length - 1];
  if (last && last.command === entry.command && last.cwd === entry.cwd) all.pop();
  all.push(entry);
  if (all.length > MAX_ENTRIES) all.splice(0, all.length - MAX_ENTRIES);
  scheduleSave();
  return entry;
}

function setExitCode(id, exitCode) {
  const entry = load().find((e) => e.id === id);
  if (entry && (exitCode === null || Number.isInteger(exitCode))) {
    entry.exitCode = exitCode;
    scheduleSave();
  }
}

function remove(id) {
  const all = load();
  const i = all.findIndex((e) => e.id === id);
  if (i >= 0) {
    all.splice(i, 1);
    scheduleSave();
  }
}

function clear() {
  entries = [];
  flush();
}

// Adds the newest (up to 2000) unique lines of another shell's history file,
// oldest first, below existing entries. Sensitive-looking lines are skipped.
function importLines(lines, shell, importedFrom) {
  const seen = new Set(load().map((e) => e.command));
  const imported = [];
  for (let i = lines.length - 1; i >= 0 && imported.length < 2000; i--) {
    const cmd = lines[i].trim();
    if (!cmd || seen.has(cmd) || cmd.length > MAX_COMMAND || looksSensitive(cmd)) continue;
    seen.add(cmd);
    imported.push(cmd);
  }
  const base = Date.now() - imported.length * 1000;
  const all = load();
  const oldest = imported.reverse().map((command, i) => ({
    id: newId(), command, cwd: null, shell, ts: base + i * 1000, exitCode: null, imported: true, importedFrom,
  }));
  all.unshift(...oldest);
  if (all.length > MAX_ENTRIES) all.splice(0, all.length - MAX_ENTRIES);
  flush();
  return oldest.length;
}

function readLines(file) {
  try {
    return fs.readFileSync(file, 'utf8').split(/\r?\n/);
  } catch {
    return null;
  }
}

// One-time import of PowerShell's PSReadLine history so the panel isn't empty
// on first launch. Multi-line (backtick-continued) entries are skipped.
function importPsReadLine() {
  const lines = readLines(path.join(
    process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
    'Microsoft', 'Windows', 'PowerShell', 'PSReadLine', 'ConsoleHost_history.txt',
  ));
  return lines ? importLines(lines.filter((l) => !l.endsWith('\x60')), 'powershell', 'PSReadLine') : 0;
}

// One-time import of Git Bash's ~/.bash_history. Timestamp lines ("#1695...")
// written when HISTTIMEFORMAT is set are skipped. cmd.exe keeps no history
// file (doskey history lives only in memory), so there is nothing to import.
function importBashHistory() {
  const lines = readLines(path.join(os.homedir(), '.bash_history'));
  return lines ? importLines(lines.filter((l) => !/^#\d+$/.test(l) && !l.endsWith('\\')), 'gitbash', 'bash history') : 0;
}

// ------------------------------------------------------------------ pins
// Pinned commands live in their own file so clearing history keeps them.

let pins = null;

function pinsFile() {
  return path.join(store.dataDir(), 'pins.json');
}

function loadPins() {
  if (!pins) {
    const saved = store.readJson(pinsFile(), []);
    pins = Array.isArray(saved) ? saved : [];
  }
  return pins;
}

function savePins() {
  store.writeJsonAtomic(pinsFile(), pins);
}

function listPins() {
  return loadPins();
}

function addPin({ command, shell, cwd }) {
  if (typeof command !== 'string') throw new Error('Invalid command.');
  const cmd = command.trim();
  if (!cmd || cmd.length > MAX_COMMAND) throw new Error('Invalid command.');
  if (looksSensitive(cmd)) throw new Error('That command looks like it contains a credential, so it can\'t be pinned.');
  const all = loadPins();
  const existing = all.find((p) => p.command === cmd);
  if (existing) return all;
  all.push({
    id: `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
    command: cmd,
    shell: typeof shell === 'string' ? shell.slice(0, 32) : null,
    cwd: typeof cwd === 'string' ? cwd.slice(0, 1024) : null,
    ts: Date.now(),
  });
  savePins();
  return all;
}

function removePin(id) {
  pins = loadPins().filter((p) => p.id !== id);
  savePins();
  return pins;
}

function movePin(id, delta) {
  const all = loadPins();
  const i = all.findIndex((p) => p.id === id);
  const j = i + (delta < 0 ? -1 : 1);
  if (i >= 0 && j >= 0 && j < all.length) {
    [all[i], all[j]] = [all[j], all[i]];
    savePins();
  }
  return all;
}

module.exports = { list, add, setExitCode, remove, clear, flush, importPsReadLine, importBashHistory, listPins, addPin, removePin, movePin };
