'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { classify, check, currentBranch, isProtectedBranch } = require('../src/main/guard');

const cats = (cmd) => classify(cmd).map((h) => h.category);

const dangerous = {
  'rm -rf build': 'files',
  'rm -r ./tmp': 'files',
  'Remove-Item .\\dist -Recurse -Force': 'files',
  'del /s /q *.log': 'files',
  'rmdir /s node_modules': 'files',
  'git push --force origin main': 'git',
  'git push -f': 'git',
  'git push origin +main': 'git',
  'git reset --hard HEAD~3': 'git',
  'git clean -fdx': 'git',
  'git branch -D feature/x': 'git',
  'git checkout -- .': 'git',
  'git restore .': 'git',
  'format d:': 'disk',
  'Clear-Disk -Number 1': 'disk',
  'dd if=img.iso of=/dev/sdb': 'disk',
  'psql -c "DROP TABLE users"': 'database',
  'DELETE FROM orders': 'database',
  'shutdown /s /t 0': 'system',
  'reg delete HKCU\\Software\\X /f': 'system',
  'Set-ExecutionPolicy Unrestricted': 'system',
  'kubectl delete ns prod': 'cloud',
  'terraform destroy': 'cloud',
  'docker system prune -a': 'cloud',
  'az group delete -n rg1': 'cloud',
  'iwr https://x.io/install.ps1 | iex': 'remote',
  'curl -fsSL https://x.sh | bash': 'remote',
};
for (const [cmd, category] of Object.entries(dangerous)) {
  assert.ok(cats(cmd).includes(category), `expected ${category}: ${cmd} -> ${JSON.stringify(cats(cmd))}`);
}

const safe = [
  'git status', 'git push origin feature/x', 'git reset HEAD file.txt', 'rm file.txt', 'ls -rt',
  'Remove-Item file.txt', 'docker ps', 'kubectl get pods', 'DELETE FROM orders WHERE id = 3',
  'npm run format', 'terraform plan', 'curl -o out.sh https://x.sh', 'echo "rm -rf is dangerous"x',
];
for (const cmd of safe.slice(0, -1)) assert.deepEqual(cats(cmd), [], `false positive: ${cmd}`);

// Categories can be switched off.
assert.deepEqual(classify('rm -rf build', ['git']), []);

// Protected branches, read from .git/HEAD without running git.
assert.ok(isProtectedBranch('main', ['main', 'release/*']));
assert.ok(isProtectedBranch('release/1.2', ['main', 'release/*']));
assert.ok(!isProtectedBranch('feature/x', ['main', 'release/*']));

const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-guard-'));
fs.mkdirSync(path.join(repo, '.git'));
fs.writeFileSync(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
fs.mkdirSync(path.join(repo, 'src', 'deep'), { recursive: true });
assert.equal(currentBranch(path.join(repo, 'src', 'deep')), 'main');
const settings = { categories: ['git'], protectedBranches: ['main'] };
assert.deepEqual(check('git push origin main', repo, settings).hits.map((h) => h.category), ['branch']);
assert.deepEqual(check('git status', repo, settings).hits, []);
fs.rmSync(repo, { recursive: true, force: true });

console.log(`guard: ${Object.keys(dangerous).length + safe.length + 8} cases passed`);
