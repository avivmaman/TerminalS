'use strict';

// The current machine and user environment from the registry. New tabs use it
// so a program installed while TerminalS is open (which adds itself to PATH in
// the registry) is found in the next tab, as in Windows Terminal. Without it,
// tabs only get the environment TerminalS itself was started with.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const MACHINE_KEY = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment';
const USER_KEY = 'HKCU\\Environment';
const TIMEOUT_MS = 3000;

// Parses a `reg export` file (UTF-16 text). Returns [{ name, value, expand }]
// for REG_SZ and REG_EXPAND_SZ values; other types are skipped.
function parseRegExport(text) {
  const out = [];
  // Long hex values continue on the next line after a trailing backslash.
  const lines = text.replace(/^﻿/, '').replace(/\\\r?\n\s*/g, '').split(/\r?\n/);
  for (const line of lines) {
    const m = /^"((?:[^"\\]|\\.)*)"=(.*)$/.exec(line);
    if (!m) continue;
    const name = m[1].replace(/\\(.)/g, '$1');
    const raw = m[2];
    if (raw.startsWith('"')) {
      const s = /^"((?:[^"\\]|\\.)*)"$/.exec(raw);
      if (s) out.push({ name, value: s[1].replace(/\\(.)/g, '$1'), expand: false });
    } else if (raw.startsWith('hex(2):')) {
      const bytes = raw.slice(7).split(',').filter(Boolean).map((b) => parseInt(b, 16));
      if (bytes.some((b) => Number.isNaN(b))) continue;
      const value = Buffer.from(bytes).toString('utf16le').replace(/\0+$/, '');
      out.push({ name, value, expand: true });
    }
  }
  return out;
}

// Case-insensitive lookup, as Windows environment names are.
function keyOf(env, name) {
  const lower = name.toLowerCase();
  return Object.keys(env).find((k) => k.toLowerCase() === lower);
}

function expand(value, env) {
  return value.replace(/%([^%]+)%/g, (whole, name) => {
    const k = keyOf(env, name);
    return k ? env[k] : whole;
  });
}

// Overlays machine then user variables on `base`, like Windows does at logon:
// user values win, except PATH, which is the machine PATH followed by the user PATH.
function mergeEnv(base, machine, user) {
  const env = { ...base };
  const set = (name, value) => {
    const k = keyOf(env, name);
    if (k && k !== name) delete env[k];
    env[name] = value;
  };
  for (const v of machine) set(v.name, v.expand ? expand(v.value, env) : v.value);
  const machinePath = (machine.find((v) => v.name.toLowerCase() === 'path') || {}).value;
  for (const v of user) {
    let value = v.expand ? expand(v.value, env) : v.value;
    if (v.name.toLowerCase() === 'path' && machinePath !== undefined) {
      const k = keyOf(env, 'path');
      value = [env[k], value].filter(Boolean).join(';');
    }
    set(v.name, value);
  }
  return env;
}

function exportKey(key) {
  const file = path.join(os.tmpdir(), `terminals-env-${process.pid}-${Math.random().toString(36).slice(2)}.reg`);
  return new Promise((resolve) => {
    execFile('reg.exe', ['export', key, file, '/y'], { windowsHide: true, timeout: TIMEOUT_MS }, (err) => {
      let vars = null;
      try {
        if (!err) vars = parseRegExport(fs.readFileSync(file).toString('utf16le'));
      } catch {
        vars = null;
      }
      fs.rm(file, { force: true }, () => {});
      resolve(vars);
    });
  });
}

// `base` with the registry's current values applied, or `base` unchanged if
// the registry can't be read (or not on Windows).
async function freshEnv(base) {
  if (process.platform !== 'win32') return base;
  const [machine, user] = await Promise.all([exportKey(MACHINE_KEY), exportKey(USER_KEY)]);
  if (!machine) return base;
  return mergeEnv(base, machine, user || []);
}

module.exports = { freshEnv, parseRegExport, mergeEnv };
