'use strict';

const assert = require('node:assert/strict');
const { detect, foreignTo, translateLocal } = require('../src/main/translate');

// Detection.
assert.equal(detect('export NODE_ENV=production').dialect, 'bash');
assert.equal(detect('sudo apt-get install jq').dialect, 'bash');
assert.equal(detect('cat app.log | grep ERROR | wc -l').dialect, 'bash');
assert.equal(detect('Get-ChildItem -Recurse | Where-Object Length -gt 1MB').dialect, 'powershell');
assert.equal(detect('$env:API_URL = "http://localhost"').dialect, 'powershell');
assert.equal(detect('set PATH=%PATH%;C:\\tools').dialect, 'cmd');
assert.equal(detect('npm install').dialect, null, 'portable commands are not foreign');
assert.equal(detect('git status').dialect, null);

// When to offer translation.
assert.deepEqual(foreignTo('export A=1', 'powershell').from, 'bash');
assert.equal(foreignTo('export A=1', 'bash'), null, 'same shell: no offer');
assert.equal(foreignTo('export A=1', 'wsl'), null, 'wsl is bash');
assert.equal(foreignTo('npm run build', 'powershell'), null);
assert.equal(foreignTo('Get-Process', 'cmd').to, 'cmd');

// Instant local translations.
const t = (cmd, from, to, v) => translateLocal(cmd, from, to, { psVersion: v });
assert.equal(t('export API_URL=https://x', 'bash', 'powershell'), "$env:API_URL = 'https://x'");
assert.equal(t("export MSG='it''s'", 'bash', 'powershell'), "$env:MSG = 'it''''s'");
assert.equal(t('which node', 'bash', 'powershell'), 'Get-Command node');
assert.equal(t('rm -rf dist', 'bash', 'powershell'), 'Remove-Item -Recurse -Force dist');
assert.equal(t('mkdir -p src/a && cd src/a', 'bash', 'powershell', 7), 'New-Item -ItemType Directory -Force src/a && cd src/a');
assert.equal(t('mkdir -p src/a && cd src/a', 'bash', 'powershell', 5), 'New-Item -ItemType Directory -Force src/a; if ($?) { cd src/a }');
assert.equal(t('cd ~/projects', 'bash', 'powershell'), 'cd $HOME/projects');
assert.equal(t('echo $JAVA_HOME', 'bash', 'powershell'), 'echo $env:JAVA_HOME');
assert.equal(t('echo $HOME', 'bash', 'powershell'), null, '$HOME means the same in PowerShell');
assert.equal(t('set X=1', 'cmd', 'powershell'), "$env:X = '1'");
assert.equal(t('echo %USERPROFILE%', 'cmd', 'powershell'), 'echo $env:USERPROFILE');
assert.equal(t("$env:TOKEN_URL = 'https://a'", 'powershell', 'bash'), 'export TOKEN_URL=https://a');
assert.equal(t('Get-Content a.txt', 'powershell', 'cmd'), 'type a.txt');

// Anything not fully understood is left to the AI.
assert.equal(t('cat app.log | grep ERROR', 'bash', 'powershell'), null);
assert.equal(t('sed -i s/a/b/ f.txt', 'bash', 'powershell'), null);
assert.equal(t('export A=$(date)', 'bash', 'powershell'), null);
assert.equal(t('npm install', 'bash', 'powershell'), null, 'unchanged -> nothing to offer');

// Which history entries can be suggested across shells.
const { isPortable } = require('../src/main/translate');
for (const c of ['npm run build', 'git log --oneline', 'docker compose up -d', 'python -m venv .venv', 'cd src', 'kubectl get pods -n dev']) {
  assert.ok(isPortable(c), `should be portable: ${c}`);
}
for (const c of ['echo $env:PATH', 'echo %PATH%', 'git log | Where-Object { $_ }', 'Get-ChildItem', 'ls -la', 'export A=1', 'set A=1', 'echo $HOME', 'npm run build `']) {
  assert.ok(!isPortable(c), `should not be portable: ${c}`);
}

console.log('translate: all cases passed');
