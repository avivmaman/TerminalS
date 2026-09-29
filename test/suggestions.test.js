'use strict';

const assert = require('node:assert/strict');
const { parseSuggestions } = require('../src/main/suggestions');

const reply = (items) => JSON.stringify({ suggestions: items });

// Extends vs replaces, notes kept, count respected.
let out = parseSuggestions(reply([
  { command: 'git status', note: 'show working tree status' },
  { command: 'git stash pop', note: 're-apply last stash' },
  { command: 'gti status', note: 'typo' },
  { command: 'git st', note: 'same as input' },
]), 'git st', 5);
assert.deepEqual(out.map((i) => [i.command, i.kind]), [['git status', 'extend'], ['git stash pop', 'extend'], ['gti status', 'replace']]);
assert.equal(out[0].note, 'show working tree status');

assert.equal(parseSuggestions(reply([{ command: 'a1' }, { command: 'a2' }, { command: 'a3' }]), 'a', 2).length, 2);

// Markdown fences and prose around the JSON are tolerated.
out = parseSuggestions('Here you go:\n```json\n' + reply([{ command: 'npm run build' }]) + '\n```', 'npm r', 5);
assert.deepEqual(out.map((i) => i.command), ['npm run build']);

// Case-only differences are normalised to what the user typed.
out = parseSuggestions(reply([{ command: 'Get-ChildItem -Recurse' }]), 'get-ch', 5);
assert.equal(out[0].command, 'get-childItem -Recurse');
assert.equal(out[0].kind, 'extend');

// Natural-language requests are always replacements.
out = parseSuggestions(reply([{ command: 'Get-ChildItem -Recurse | Where-Object Length -gt 100MB' }]), '# files over 100MB', 5);
assert.equal(out[0].kind, 'replace');

// Malformed entries, control characters, duplicates and junk are dropped.
out = parseSuggestions(reply([
  { command: 'ls\n rm -rf /' },
  { command: 'ls\x1b[31m' },
  { command: 42 },
  null,
  { command: 'ls -la' },
  { command: 'ls -la' },
]), 'ls', 5);
assert.deepEqual(out.map((i) => i.command), ['ls -la']);
assert.deepEqual(parseSuggestions('not json at all', 'x', 5), []);
assert.deepEqual(parseSuggestions('{"suggestions": "nope"}', 'x', 5), []);

// Destructive commands are flagged even if the model says otherwise.
out = parseSuggestions(reply([
  { command: 'rm -rf build', destructive: false },
  { command: 'Remove-Item .\\dist -Recurse -Force' },
  { command: 'git push --force origin main' },
  { command: 'git reset --hard HEAD~1' },
  { command: 'git push origin main' },
]), '', 5);
assert.deepEqual(out.map((i) => i.destructive), [true, true, true, true, false]);

console.log('suggestions: all cases passed');
