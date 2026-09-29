'use strict';

const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');
const { looksSensitive } = require('./redact');

const MODELS = ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'];
const THEMES = ['terminals', 'mocha', 'midnight', 'light'];
const SCRIPT_KINDS = { powershell: '.ps1', cmd: '.cmd', bash: '.sh' };
const ENV_MODES = ['set', 'prepend', 'append'];
// Windows allows almost anything in a variable name; stay conservative but
// accept names like ProgramFiles(x86) and JAVA.HOME.
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_().-]{0,254}$/;
const MAX_ENV_VALUE = 32767;
const MAX_SCRIPT = 64 * 1024;
const SECRET_NAME_RE = /(password|passwd|pwd|secret|token|api[-_]?key|apikey|access[-_]?key|private[-_]?key|credential|auth)/i;

const DEFAULT_SETTINGS = {
  theme: 'terminals',
  fontSize: 14,
  defaultShell: null,
  historyPanelOpen: true,
  psreadlineImported: false,
  bashImported: false,
  rightClick: true,
  ai: {
    enabled: true,
    sendContext: true,
    provider: 'anthropic',
    model: 'claude-opus-5',
    count: 5,
    doubleSpace: true,
    doubleSpaceMs: 300,
    hotkey: 'ctrl+space',
    ghost: true,
    ghostArrows: true,
    'foundry-claude': { resource: '', model: 'claude-opus-5', auth: 'key' },
    'azure-openai': { endpoint: '', deployment: '', apiVersion: '2024-10-21', auth: 'key' },
    openrouter: { model: 'anthropic/claude-opus-5' },
  },
  tools: {
    // No AI requests of any kind from these folders (or their subfolders).
    excludedFolders: [],
    fix: { enabled: true, showChip: true, sendOutput: true, outputLines: 40, hotkey: 'alt+f' },
    guard: {
      enabled: true,
      categories: ['files', 'git', 'disk', 'database', 'system', 'cloud', 'remote'],
      protectedBranches: ['main', 'master'],
    },
    translate: { enabled: true, promptOnPaste: true, useAi: true, hotkey: 'alt+t', sensitivity: 'medium' },
    usage: { enabled: true, showInStatus: true, dailyRequests: 0, dailyTokens: 0 },
  },
};

const GUARD_CATEGORIES = ['files', 'git', 'disk', 'database', 'system', 'cloud', 'remote'];
const TOOL_HOTKEYS = { fix: ['alt+f', 'ctrl+alt+f', 'none'], translate: ['alt+t', 'ctrl+alt+t', 'none'] };
const SENSITIVITIES = ['low', 'medium', 'high'];
const BRANCH_PATTERN_RE = /^[A-Za-z0-9._\/*-]{1,100}$/;

function intIn(v, min, max) {
  return Number.isInteger(v) && v >= min && v <= max;
}

function mergeTools(current, patch) {
  const next = {
    ...current,
    fix: { ...current.fix },
    guard: { ...current.guard },
    translate: { ...current.translate },
    usage: { ...current.usage },
  };
  if (Array.isArray(patch.excludedFolders)) {
    const folders = patch.excludedFolders.map((f) => String(f).trim()).filter(Boolean);
    if (folders.length > 50 || folders.some((f) => f.length > 260 || !/^([A-Za-z]:\\|\\\\|\/)/.test(f))) {
      throw new Error('Excluded folders must be absolute paths (e.g. D:\\Customers), up to 50.');
    }
    next.excludedFolders = folders;
  }
  const fix = patch.fix || {};
  for (const k of ['enabled', 'showChip', 'sendOutput']) if (typeof fix[k] === 'boolean') next.fix[k] = fix[k];
  if (intIn(fix.outputLines, 5, 200)) next.fix.outputLines = fix.outputLines;
  if (TOOL_HOTKEYS.fix.includes(fix.hotkey)) next.fix.hotkey = fix.hotkey;

  const guard = patch.guard || {};
  if (typeof guard.enabled === 'boolean') next.guard.enabled = guard.enabled;
  if (Array.isArray(guard.categories)) next.guard.categories = guard.categories.filter((c) => GUARD_CATEGORIES.includes(c));
  if (Array.isArray(guard.protectedBranches)) {
    const branches = guard.protectedBranches.map((b) => String(b).trim()).filter(Boolean);
    if (branches.length > 30 || branches.some((b) => !BRANCH_PATTERN_RE.test(b))) {
      throw new Error('Branch patterns may contain letters, digits, . _ / - and * (e.g. main, release/*).');
    }
    next.guard.protectedBranches = branches;
  }

  const tr = patch.translate || {};
  for (const k of ['enabled', 'promptOnPaste', 'useAi']) if (typeof tr[k] === 'boolean') next.translate[k] = tr[k];
  if (TOOL_HOTKEYS.translate.includes(tr.hotkey)) next.translate.hotkey = tr.hotkey;
  if (SENSITIVITIES.includes(tr.sensitivity)) next.translate.sensitivity = tr.sensitivity;

  const usage = patch.usage || {};
  for (const k of ['enabled', 'showInStatus']) if (typeof usage[k] === 'boolean') next.usage[k] = usage[k];
  if (intIn(usage.dailyRequests, 0, 100000)) next.usage.dailyRequests = usage.dailyRequests;
  if (intIn(usage.dailyTokens, 0, 1000000000)) next.usage.dailyTokens = usage.dailyTokens;
  return next;
}

// True if cwd is inside one of the excluded folders (case-insensitive, Windows paths).
function isExcludedFolder(cwd) {
  if (typeof cwd !== 'string' || !cwd) return false;
  const norm = (p) => path.resolve(p).toLowerCase().replace(/[\\/]+$/, '');
  const here = norm(cwd);
  return getSettings().tools.excludedFolders.some((f) => {
    const base = norm(f);
    return here === base || here.startsWith(`${base}\\`) || here.startsWith(`${base}/`);
  });
}

const PROVIDERS = ['anthropic', 'foundry-claude', 'azure-openai', 'openrouter'];
const HOTKEYS = ['ctrl+space', 'ctrl+shift+space', 'alt+/', 'none'];
const AUTH_MODES = ['key', 'entra'];
// AI traffic may only go to Azure-hosted endpoints over TLS.
const AZURE_HOST_RE = /\.(openai\.azure\.com|services\.ai\.azure\.com|cognitiveservices\.azure\.com|azure\.anthropic\.com)$/i;
const RESOURCE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,62}[A-Za-z0-9]$/;
const DEPLOYMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
// OpenRouter model slugs: vendor/model, optionally with a :variant (e.g. :free).
const OPENROUTER_MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\/[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const API_VERSION_RE = /^\d{4}-\d{2}-\d{2}(-preview)?$/;

function azureUrl(value, label) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be a URL like https://my-resource.openai.azure.com/`);
  }
  if (url.protocol !== 'https:') throw new Error(`${label} must use https://`);
  if (!AZURE_HOST_RE.test(url.hostname)) throw new Error(`${label} must be an Azure AI endpoint (*.openai.azure.com, *.services.ai.azure.com, *.cognitiveservices.azure.com).`);
  if (url.username || url.password || url.search || url.hash) throw new Error(`${label} must not contain credentials or query parameters.`);
  return url.toString();
}

// Portal endpoints are often pasted without the /anthropic/ suffix the API needs.
function normalizeFoundryUrl(value) {
  const url = azureUrl(value, 'Resource URL');
  return new URL(url).pathname === '/' ? `${url}anthropic/` : url.replace(/\/?$/, '/');
}

function mergeFoundry(current, patch) {
  const next = { ...current };
  if (typeof patch.resource === 'string') {
    const r = patch.resource.trim();
    if (r && !r.startsWith('https://') && !RESOURCE_NAME_RE.test(r)) throw new Error('Resource must be a Foundry resource name or its https:// URL.');
    next.resource = r.startsWith('https://') ? normalizeFoundryUrl(r) : r;
  }
  if (typeof patch.model === 'string') {
    const m = patch.model.trim();
    if (!DEPLOYMENT_RE.test(m)) throw new Error('Model/deployment name may contain letters, digits, ".", "_" and "-".');
    next.model = m;
  }
  if (AUTH_MODES.includes(patch.auth)) next.auth = patch.auth;
  return next;
}

function mergeAzureOpenAI(current, patch) {
  const next = { ...current };
  if (typeof patch.endpoint === 'string') {
    const e = patch.endpoint.trim();
    next.endpoint = e ? azureUrl(e, 'Endpoint') : '';
  }
  if (typeof patch.deployment === 'string') {
    const d = patch.deployment.trim();
    if (d && !DEPLOYMENT_RE.test(d)) throw new Error('Deployment name may contain letters, digits, ".", "_" and "-".');
    next.deployment = d;
  }
  if (typeof patch.apiVersion === 'string') {
    const v = patch.apiVersion.trim();
    if (!API_VERSION_RE.test(v)) throw new Error('API version looks like 2024-10-21 or 2025-04-01-preview.');
    next.apiVersion = v;
  }
  if (AUTH_MODES.includes(patch.auth)) next.auth = patch.auth;
  return next;
}

function dataDir() {
  return app.getPath('userData');
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

// ---------------------------------------------------------------- settings

let settings = null;

function settingsFile() {
  return path.join(dataDir(), 'settings.json');
}

function mergeSavedTools(saved) {
  const d = DEFAULT_SETTINGS.tools;
  return {
    ...d,
    ...saved,
    fix: { ...d.fix, ...(saved.fix || {}) },
    guard: { ...d.guard, ...(saved.guard || {}) },
    translate: { ...d.translate, ...(saved.translate || {}) },
    usage: { ...d.usage, ...(saved.usage || {}) },
  };
}

function mergeOpenRouter(current, patch) {
  const next = { ...current };
  if (typeof patch.model === 'string') {
    const m = patch.model.trim();
    if (!OPENROUTER_MODEL_RE.test(m)) throw new Error('OpenRouter model looks like anthropic/claude-opus-5 or openai/gpt-5.');
    next.model = m;
  }
  return next;
}

function getSettings() {
  if (!settings) {
    const saved = readJson(settingsFile(), {});
    const ai = saved.ai || {};
    settings = {
      ...DEFAULT_SETTINGS,
      ...saved,
      ai: {
        ...DEFAULT_SETTINGS.ai,
        ...ai,
        'foundry-claude': { ...DEFAULT_SETTINGS.ai['foundry-claude'], ...(ai['foundry-claude'] || {}) },
        'azure-openai': { ...DEFAULT_SETTINGS.ai['azure-openai'], ...(ai['azure-openai'] || {}) },
        openrouter: { ...DEFAULT_SETTINGS.ai.openrouter, ...(ai.openrouter || {}) },
      },
      tools: mergeSavedTools(saved.tools || {}),
    };
  }
  return settings;
}

function updateSettings(patch) {
  const current = getSettings();
  const next = { ...current, ai: { ...current.ai } };
  if (patch && typeof patch === 'object') {
    if (patch.tools && typeof patch.tools === 'object') next.tools = mergeTools(current.tools, patch.tools);
    if (THEMES.includes(patch.theme)) next.theme = patch.theme;
    if (Number.isInteger(patch.fontSize) && patch.fontSize >= 8 && patch.fontSize <= 32) next.fontSize = patch.fontSize;
    if (patch.defaultShell === null || typeof patch.defaultShell === 'string') next.defaultShell = patch.defaultShell;
    if (typeof patch.historyPanelOpen === 'boolean') next.historyPanelOpen = patch.historyPanelOpen;
    if (typeof patch.psreadlineImported === 'boolean') next.psreadlineImported = patch.psreadlineImported;
    if (typeof patch.bashImported === 'boolean') next.bashImported = patch.bashImported;
    if (typeof patch.rightClick === 'boolean') next.rightClick = patch.rightClick;
    const ai = patch.ai || {};
    if (typeof ai.enabled === 'boolean') next.ai.enabled = ai.enabled;
    if (typeof ai.sendContext === 'boolean') next.ai.sendContext = ai.sendContext;
    if (MODELS.includes(ai.model)) next.ai.model = ai.model;
    if (PROVIDERS.includes(ai.provider)) next.ai.provider = ai.provider;
    if (Number.isInteger(ai.count) && ai.count >= 3 && ai.count <= 10) next.ai.count = ai.count;
    if (typeof ai.doubleSpace === 'boolean') next.ai.doubleSpace = ai.doubleSpace;
    if (Number.isInteger(ai.doubleSpaceMs) && ai.doubleSpaceMs >= 150 && ai.doubleSpaceMs <= 800) next.ai.doubleSpaceMs = ai.doubleSpaceMs;
    if (HOTKEYS.includes(ai.hotkey)) next.ai.hotkey = ai.hotkey;
    if (typeof ai.ghost === 'boolean') next.ai.ghost = ai.ghost;
    if (typeof ai.ghostArrows === 'boolean') next.ai.ghostArrows = ai.ghostArrows;
    if (ai['foundry-claude'] && typeof ai['foundry-claude'] === 'object') next.ai['foundry-claude'] = mergeFoundry(current.ai['foundry-claude'], ai['foundry-claude']);
    if (ai['azure-openai'] && typeof ai['azure-openai'] === 'object') next.ai['azure-openai'] = mergeAzureOpenAI(current.ai['azure-openai'], ai['azure-openai']);
    if (ai.openrouter && typeof ai.openrouter === 'object') next.ai.openrouter = mergeOpenRouter(current.ai.openrouter, ai.openrouter);
  }
  settings = next;
  writeJsonAtomic(settingsFile(), settings);
  return settings;
}

// ----------------------------------------------------------------- secrets
// Secret values are encrypted with Electron safeStorage (DPAPI on Windows) and
// never leave the main process. If encryption is unavailable we refuse to
// store them rather than fall back to plaintext.

function secretsFile() {
  return path.join(dataDir(), 'secrets.json');
}

function readSecrets() {
  return readJson(secretsFile(), {});
}

function encryptionAvailable() {
  return safeStorage.isEncryptionAvailable();
}

function setSecret(key, value) {
  if (!encryptionAvailable()) throw new Error('OS encryption (DPAPI) is unavailable; refusing to store the secret.');
  const all = readSecrets();
  all[key] = safeStorage.encryptString(value).toString('base64');
  writeJsonAtomic(secretsFile(), all);
}

function getSecret(key) {
  const blob = readSecrets()[key];
  if (!blob || !encryptionAvailable()) return null;
  try {
    return safeStorage.decryptString(Buffer.from(blob, 'base64'));
  } catch {
    return null;
  }
}

function deleteSecret(key) {
  const all = readSecrets();
  if (key in all) {
    delete all[key];
    writeJsonAtomic(secretsFile(), all);
  }
}

function hasSecret(key) {
  return Boolean(readSecrets()[key]);
}

// ---------------------------------------------------------------- profiles
// Environment variables and per-shell startup scripts applied to new tabs.

function profilesFile() {
  return path.join(dataDir(), 'profiles.json');
}

function scriptsDir() {
  return path.join(dataDir(), 'startup-scripts');
}

function readProfiles() {
  const p = readJson(profilesFile(), {});
  return {
    env: Array.isArray(p.env) ? p.env : [],
    scripts: { powershell: '', cmd: '', bash: '', ...(p.scripts || {}) },
  };
}

// What the renderer sees: secret values are never included.
function getProfiles() {
  const p = readProfiles();
  return {
    env: p.env.map((v) => ({ ...v, value: v.secret ? '' : v.value, hasValue: v.secret ? hasSecret(`env:${v.id}`) : true })),
    scripts: p.scripts,
    encryptionAvailable: encryptionAvailable(),
  };
}

function validateEnvVar(input, shellIds) {
  if (!input || typeof input !== 'object') throw new Error('Invalid variable.');
  const name = String(input.name || '').trim();
  if (!ENV_NAME_RE.test(name)) throw new Error(`"${name}" is not a valid variable name.`);
  if (name.toUpperCase().startsWith('TERMINALS_')) throw new Error('TERMINALS_* names are reserved.');
  const mode = ENV_MODES.includes(input.mode) ? input.mode : 'set';
  const scope = input.scope === 'all' || shellIds.includes(input.scope) ? input.scope : 'all';
  const value = typeof input.value === 'string' ? input.value : '';
  if (value.length > MAX_ENV_VALUE) throw new Error('Value is too long (max 32767 characters).');
  if (value.includes('\0')) throw new Error('Value contains a NUL character.');
  return { name, mode, scope, value, secret: Boolean(input.secret), enabled: input.enabled !== false };
}

// Saves one variable. Returns { profiles, notice } — notice explains any
// automatic promotion of a plaintext value to secret storage.
function saveEnvVar(input, shellIds) {
  const v = validateEnvVar(input, shellIds);
  const p = readProfiles();
  const id = typeof input.id === 'string' && p.env.some((e) => e.id === input.id) ? input.id : `v${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const existing = p.env.find((e) => e.id === id);
  let notice = null;

  if (!v.secret && v.value && (SECRET_NAME_RE.test(v.name) || looksSensitive(`${v.name}=${v.value}`))) {
    v.secret = true;
    notice = `${v.name} looks like a credential, so it was stored as an encrypted secret.`;
  }

  if (v.secret) {
    if (v.value) setSecret(`env:${id}`, v.value);
    else if (!existing || !hasSecret(`env:${id}`)) throw new Error('Enter a value for the secret.');
    v.value = '';
  } else {
    deleteSecret(`env:${id}`);
  }

  const record = { id, ...v };
  if (existing) p.env[p.env.indexOf(existing)] = record;
  else p.env.push(record);
  writeJsonAtomic(profilesFile(), p);
  return { profiles: getProfiles(), notice };
}

function deleteEnvVar(id) {
  const p = readProfiles();
  p.env = p.env.filter((e) => e.id !== id);
  deleteSecret(`env:${id}`);
  writeJsonAtomic(profilesFile(), p);
  return getProfiles();
}

function moveEnvVar(id, delta) {
  const p = readProfiles();
  const i = p.env.findIndex((e) => e.id === id);
  const j = i + (delta < 0 ? -1 : 1);
  if (i >= 0 && j >= 0 && j < p.env.length) {
    [p.env[i], p.env[j]] = [p.env[j], p.env[i]];
    writeJsonAtomic(profilesFile(), p);
  }
  return getProfiles();
}

function saveScript(kind, text) {
  if (!(kind in SCRIPT_KINDS)) throw new Error('Unknown shell kind.');
  if (typeof text !== 'string' || text.length > MAX_SCRIPT) throw new Error('Script is too large (max 64 KB).');
  // Startup scripts are plaintext files; keep credentials out of them.
  const badLine = text.split(/\r?\n/).findIndex((line) => looksSensitive(line));
  if (badLine >= 0) {
    throw new Error(`Line ${badLine + 1} looks like it contains a credential. Store it as a secret environment variable instead of in the startup script.`);
  }
  const p = readProfiles();
  p.scripts[kind] = text;
  writeJsonAtomic(profilesFile(), p);
  writeScriptFile(kind, text);
  return getProfiles();
}

function writeScriptFile(kind, text) {
  const file = path.join(scriptsDir(), `startup${SCRIPT_KINDS[kind]}`);
  if (!text.trim()) {
    fs.rmSync(file, { force: true });
    return;
  }
  fs.mkdirSync(scriptsDir(), { recursive: true });
  if (kind === 'powershell') {
    // BOM so Windows PowerShell 5.1 reads it as UTF-8.
    fs.writeFileSync(file, '﻿' + text.replace(/\r?\n/g, '\r\n'), 'utf8');
  } else if (kind === 'cmd') {
    fs.writeFileSync(file, '@echo off\r\n' + text.replace(/\r?\n/g, '\r\n') + '\r\n', 'utf8');
  } else {
    fs.writeFileSync(file, text.replace(/\r\n/g, '\n') + '\n', 'utf8');
  }
}

// Path of the startup script for a shell kind, or null if none is configured.
function scriptPath(kind) {
  if (!(kind in SCRIPT_KINDS)) return null;
  const text = readProfiles().scripts[kind] || '';
  if (!text.trim()) return null;
  const file = path.join(scriptsDir(), `startup${SCRIPT_KINDS[kind]}`);
  if (!fs.existsSync(file)) writeScriptFile(kind, text);
  return file;
}

function findKey(env, name) {
  const upper = name.toUpperCase();
  return Object.keys(env).find((k) => k.toUpperCase() === upper) || name;
}

// Applies enabled variables for this shell onto a copy of the base environment.
// Values are process-scoped: they exist only in the spawned shell.
function applyEnv(baseEnv, shellId) {
  const env = { ...baseEnv };
  for (const v of readProfiles().env) {
    if (!v.enabled || (v.scope !== 'all' && v.scope !== shellId)) continue;
    const value = v.secret ? getSecret(`env:${v.id}`) : v.value;
    if (value == null) continue;
    const key = findKey(env, v.name);
    const current = env[key];
    if (v.mode === 'prepend' && current) env[key] = `${value};${current}`;
    else if (v.mode === 'append' && current) env[key] = `${current};${value}`;
    else env[key] = value;
  }
  return env;
}

module.exports = {
  MODELS,
  validateAzureUrl: azureUrl,
  isExcludedFolder,
  normalizeFoundryUrl,
  getSettings,
  updateSettings,
  setSecret,
  getSecret,
  deleteSecret,
  hasSecret,
  encryptionAvailable,
  getProfiles,
  saveEnvVar,
  deleteEnvVar,
  moveEnvVar,
  saveScript,
  scriptPath,
  applyEnv,
  dataDir,
  readJson,
  writeJsonAtomic,
};
