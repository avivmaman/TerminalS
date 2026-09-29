'use strict';

// Local safety rules for commands about to run (and for AI suggestions).
// Pure pattern matching, no network. Each rule belongs to a category that can
// be switched off in Settings.

const fs = require('fs');
const path = require('path');

const CATEGORIES = {
  files: 'Deletes files',
  git: 'Rewrites or discards git history',
  disk: 'Formats or wipes disks',
  database: 'Destroys database data',
  system: 'Changes or stops the system',
  cloud: 'Destroys cloud or container resources',
  remote: 'Runs a script downloaded from the internet',
};

const RULES = [
  // files
  ['files', /\brm\s+(?:-\w*[rRf]\w*|--recursive|--force)\b/, 'rm with -r/-f removes files without asking'],
  ['files', /\bRemove-Item\b(?=.*\s-(?:Recurse|Force)\b)/i, 'Remove-Item -Recurse/-Force deletes without asking'],
  ['files', /\b(?:ri|rm|del|erase|rd|rmdir)\b.*\s\/[sq]\b/i, 'del/rmdir with /s or /q deletes a whole tree quietly'],
  ['files', /\bshred\b|\bsdelete\b/i, 'securely erases files (unrecoverable)'],
  // git
  ['git', /\bgit\s+push\b.*(?:\s--force(?:-with-lease)?\b|\s-f\b|\s\+\S)/, 'force push can overwrite others\' commits'],
  ['git', /\bgit\s+reset\s+--hard\b/, 'git reset --hard discards uncommitted work'],
  ['git', /\bgit\s+clean\s+-\w*f/, 'git clean -f deletes untracked files'],
  ['git', /\bgit\s+branch\s+-D\b/, 'git branch -D deletes a branch even if unmerged'],
  ['git', /\bgit\s+(?:checkout|restore)\s+(?:--\s+)?\.(?:\s|$)/, 'discards all local changes'],
  ['git', /\bgit\s+stash\s+(?:drop|clear)\b/, 'permanently drops stashed work'],
  // disk
  ['disk', /\bformat\s+[a-z]:/i, 'formats a drive'],
  ['disk', /\b(?:diskpart|Clear-Disk|Format-Volume|Initialize-Disk|mkfs(?:\.\w+)?)\b/i, 'wipes or formats disks'],
  ['disk', /\bdd\s+.*\bof=\/dev\//, 'dd writes raw data to a device'],
  // database
  ['database', /\bDROP\s+(?:TABLE|DATABASE|SCHEMA)\b/i, 'DROP permanently deletes data'],
  ['database', /\bTRUNCATE\s+TABLE\b/i, 'TRUNCATE deletes every row'],
  ['database', /\bDELETE\s+FROM\s+\w+(?![^;]*\bWHERE\b)/i, 'DELETE without WHERE deletes every row'],
  // system
  ['system', /\b(?:shutdown|Stop-Computer|Restart-Computer)\b/i, 'shuts down or restarts the machine'],
  ['system', /\breg(?:\.exe)?\s+delete\b/i, 'deletes registry keys'],
  ['system', /\bbcdedit\b/i, 'changes boot configuration'],
  ['system', /\bnetsh\s+advfirewall\s+set\s+\w+\s+state\s+off\b/i, 'turns the firewall off'],
  ['system', /\bSet-ExecutionPolicy\s+(?:Unrestricted|Bypass)\b/i, 'disables PowerShell script protection'],
  // cloud / containers
  ['cloud', /\bkubectl\s+delete\b/, 'deletes Kubernetes resources'],
  ['cloud', /\bterraform\s+destroy\b/, 'destroys all Terraform-managed infrastructure'],
  ['cloud', /\bhelm\s+(?:uninstall|delete)\b/, 'uninstalls a Helm release'],
  ['cloud', /\bdocker\s+(?:system|volume|image)\s+prune\b/, 'deletes Docker data'],
  ['cloud', /\baz\s+group\s+delete\b/, 'deletes an Azure resource group'],
  ['cloud', /\baws\s+s3\s+(?:rm|rb)\b.*--recursive|\baws\s+s3\s+rb\b.*--force/, 'deletes S3 data'],
  // remote code
  ['remote', /\b(?:iwr|irm|Invoke-WebRequest|Invoke-RestMethod|curl|wget)\b.*\|\s*(?:iex|Invoke-Expression)\b/i, 'downloads and runs a script'],
  ['remote', /\bInvoke-Expression\b.*\b(?:iwr|irm|Invoke-WebRequest|Invoke-RestMethod|DownloadString)\b/i, 'downloads and runs a script'],
  ['remote', /\b(?:curl|wget)\b[^|]*\|\s*(?:sudo\s+)?(?:ba|z)?sh\b/, 'downloads and runs a script'],
];

// Returns the rules a command trips, limited to the enabled categories.
function classify(command, categories = Object.keys(CATEGORIES)) {
  if (typeof command !== 'string' || !command.trim()) return [];
  const enabled = new Set(categories);
  const hits = [];
  const seen = new Set();
  for (const [category, re, reason] of RULES) {
    if (!enabled.has(category) || !re.test(command) || seen.has(reason)) continue;
    seen.add(reason);
    hits.push({ category, label: CATEGORIES[category], reason });
  }
  return hits;
}

function globToRegExp(glob) {
  return new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`, 'i');
}

function isProtectedBranch(branch, patterns) {
  return Boolean(branch) && patterns.some((p) => globToRegExp(p).test(branch));
}

// Reads the current branch from .git/HEAD, walking up from cwd. No git process.
function currentBranch(cwd) {
  if (typeof cwd !== 'string' || !cwd) return null;
  let dir = cwd;
  for (let i = 0; i < 30; i++) {
    const gitPath = path.join(dir, '.git');
    try {
      let gitDir = gitPath;
      if (fs.statSync(gitPath).isFile()) {
        // Worktrees and submodules: ".git" is a file pointing at the real dir.
        const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(gitPath, 'utf8'));
        if (!m) return null;
        gitDir = path.resolve(dir, m[1].trim());
      }
      const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
      const m = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
      return m ? m[1] : null;
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  }
  return null;
}

// Git commands that deserve a warning when run on a protected branch.
const BRANCH_SENSITIVE_RE = /\bgit\s+(?:push|reset|rebase|commit\s+.*--amend|merge)\b/;

// Full check used on Enter. Returns { hits, branch }.
function check(command, cwd, settings) {
  const hits = classify(command, settings.categories);
  let branch = null;
  if (settings.protectedBranches.length && BRANCH_SENSITIVE_RE.test(command)) {
    branch = currentBranch(cwd);
    if (isProtectedBranch(branch, settings.protectedBranches)) {
      hits.push({ category: 'branch', label: 'Protected branch', reason: `you're on ${branch}, a protected branch` });
    }
  }
  return { hits, branch };
}

module.exports = { CATEGORIES, classify, check, currentBranch, isProtectedBranch };
