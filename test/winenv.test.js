'use strict';

const assert = require('node:assert/strict');
const { parseRegExport, mergeEnv, freshEnv } = require('../src/main/winenv');

// REG_EXPAND_SZ values are exported as UTF-16LE bytes, wrapped over several lines.
function hex2(s) {
  const bytes = [...Buffer.from(`${s}\0`, 'utf16le')].map((b) => b.toString(16).padStart(2, '0'));
  const lines = [];
  for (let i = 0; i < bytes.length; i += 20) lines.push(bytes.slice(i, i + 20).join(','));
  return `hex(2):${lines.join(',\\\r\n  ')}`;
}

const machineExport = [
  '\uFEFFWindows Registry Editor Version 5.00',
  '',
  '[HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment]',
  `"Path"=${hex2('%SystemRoot%\\system32;C:\\Program Files\\Git\\cmd')}`,
  '"OS"="Windows_NT"',
  '"NUMBER_OF_PROCESSORS"="8"',
  '"Quoted"="say \\"hi\\" C:\\\\tmp"',
  '"Flags"=dword:00000001',
  '',
].join('\r\n');

const userExport = [
  '\uFEFFWindows Registry Editor Version 5.00',
  '',
  '[HKEY_CURRENT_USER\\Environment]',
  `"Path"=${hex2('%USERPROFILE%\\AppData\\Local\\Programs\\Ollama;C:\\Users\\אביב\\bin')}`,
  '"TEMP"="C:\\\\Users\\\\me\\\\AppData\\\\Local\\\\Temp"',
  '"OS"="UserWins"',
  '',
].join('\r\n');

const machine = parseRegExport(machineExport);
assert.deepEqual(machine.map((v) => v.name), ['Path', 'OS', 'NUMBER_OF_PROCESSORS', 'Quoted']);
assert.equal(machine[0].value, '%SystemRoot%\\system32;C:\\Program Files\\Git\\cmd');
assert.equal(machine[0].expand, true);
assert.equal(machine[3].value, 'say "hi" C:\\tmp');

const user = parseRegExport(userExport);
assert.equal(user[0].value, '%USERPROFILE%\\AppData\\Local\\Programs\\Ollama;C:\\Users\\אביב\\bin');

const base = { PATH: 'C:\\old', SystemRoot: 'C:\\Windows', USERPROFILE: 'C:\\Users\\me', KEEP: '1' };
const env = mergeEnv(base, machine, user);
// One PATH key, keeping the registry's spelling; machine PATH then user PATH, expanded.
assert.deepEqual(Object.keys(env).filter((k) => k.toLowerCase() === 'path'), ['Path']);
assert.equal(env.Path, 'C:\\Windows\\system32;C:\\Program Files\\Git\\cmd;C:\\Users\\me\\AppData\\Local\\Programs\\Ollama;C:\\Users\\אביב\\bin');
assert.equal(env.OS, 'UserWins');
assert.equal(env.TEMP, 'C:\\Users\\me\\AppData\\Local\\Temp');
assert.equal(env.KEEP, '1');
// Unknown %VARS% stay as they are.
assert.equal(mergeEnv({}, [{ name: 'X', value: '%NOPE%\\a', expand: true }], []).X, '%NOPE%\\a');
// No user PATH: machine PATH only.
assert.equal(mergeEnv({ Path: 'old' }, [{ name: 'Path', value: 'm', expand: false }], []).Path, 'm');

// On Windows, read the real registry: PATH must come back with System32 in it.
async function live() {
  if (process.platform !== 'win32') return 'skipped live registry read (not Windows)';
  const env = await freshEnv({ KEEP: '1' });
  const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path');
  assert.ok(pathKey, 'PATH read from the registry');
  assert.match(env[pathKey], /system32/i);
  assert.doesNotMatch(env[pathKey], /%SystemRoot%/i);
  assert.equal(env.KEEP, '1');
  return 'live registry read ok';
}

live().then((note) => console.log(`winenv: all cases passed (${note})`), (err) => {
  console.error(err);
  process.exit(1);
});
