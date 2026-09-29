'use strict';

// Shell-dialect detection and instant local translations. Pure functions: no
// network, so detection on paste never sends anything anywhere.

const DIALECTS = ['bash', 'powershell', 'cmd'];

// [dialect, pattern, weight]
const SIGNALS = [
  ['bash', /(^|[;&|]\s*)export\s+[A-Za-z_]\w*=/, 3],
  ['bash', /\$\([^)]*\)/, 1],
  ['bash', /(^|[;&|]\s*)sudo\s/, 3],
  ['bash', /\|\s*(?:grep|sed|awk|xargs|head|tail|wc|sort|uniq|cut|tr)\b/, 2],
  ['bash', /(^|[;&|]\s*)(?:grep|sed|awk|chmod|chown|ln\s+-s|source|apt(?:-get)?|brew|yum)\s/, 2],
  ['bash', /(^|\s)~\//, 1],
  ['bash', /\/dev\/null/, 2],
  ['bash', /\\\s*$/m, 2],
  ['bash', /\[\[\s.*\s\]\]/, 2],
  ['bash', /\$\{?[A-Z_][A-Z0-9_]*\}?/, 1],
  ['bash', /(^|[;&|]\s*)ls\s+-[a-zA-Z]+/, 1],
  ['powershell', /\b(?:Get|Set|New|Remove|Invoke|Start|Stop|Select|Where|ForEach|Test|Write|Out|Import|Export)-[A-Z][A-Za-z]+/, 3],
  ['powershell', /\$env:[A-Za-z_]/, 3],
  ['powershell', /\s-(?:ErrorAction|Recurse|Force|Filter|Path|Value)\b/, 1],
  ['powershell', /`\s*$/m, 2],
  ['powershell', /\|\s*(?:%|\?)\s*\{/, 2],
  ['powershell', /\$_\b|\$PSScriptRoot|\$null\b|\$true\b|\$false\b/, 2],
  ['cmd', /%[A-Za-z_][A-Za-z0-9_]*%/, 3],
  ['cmd', /(^|&\s*)set\s+[A-Za-z_]\w*=/i, 3],
  ['cmd', /\^\s*$/m, 2],
  ['cmd', /(^|&\s*)(?:dir|copy|xcopy|move|del|type)\s+.*\/[a-z]\b/i, 2],
  ['cmd', /(^|&\s*)@?echo\s+off\b/i, 3],
];

const KIND_TO_DIALECT = { powershell: 'powershell', cmd: 'cmd', bash: 'bash', wsl: 'bash' };

// Guesses the dialect of a command. confidence is 0..1; ambiguous text
// (valid in several shells, like "npm install") scores near 0.
function detect(text) {
  const scores = { bash: 0, powershell: 0, cmd: 0 };
  const signals = [];
  for (const [dialect, re, weight] of SIGNALS) {
    if (re.test(text)) {
      scores[dialect] += weight;
      signals.push(dialect);
    }
  }
  const ranked = DIALECTS.map((d) => [d, scores[d]]).sort((a, b) => b[1] - a[1]);
  const [best, second] = ranked;
  if (best[1] === 0) return { dialect: null, confidence: 0 };
  const margin = best[1] - second[1];
  return { dialect: best[0], confidence: Math.min(1, margin / 4), score: best[1] };
}

// Should we offer to translate text pasted into a shell of this kind?
function foreignTo(text, shellKind, threshold = 0.5) {
  const target = KIND_TO_DIALECT[shellKind];
  if (!target) return null;
  const d = detect(text);
  if (!d.dialect || d.dialect === target || d.confidence < threshold) return null;
  return { from: d.dialect, to: target, confidence: d.confidence };
}

// Commands that mean the same thing in every shell.
const PORTABLE_RE = /^(?:npm|npx|pnpm|yarn|node|git|docker|kubectl|helm|terraform|az|aws|gcloud|python|python3|py|pip|pip3|dotnet|go|cargo|rustc|java|mvn|gradle|code|ssh|scp|ping|curl\.exe|winget|choco|cd|echo|pwd|exit|clear|cls)(?:\s|$)/;

function unquote(v) {
  const m = /^(['"])(.*)\1$/.exec(v.trim());
  return m ? m[2] : v.trim();
}

function psQuote(v) {
  return `'${v.replace(/'/g, "''")}'`;
}

function shQuote(v) {
  return /^[\w./:@%+,=-]+$/.test(v) ? v : `'${v.replace(/'/g, "'\\''")}'`;
}

// One simple command -> converted string, or null if no rule applies.
const RULES = {
  'bash>powershell': [
    [/^export\s+([A-Za-z_]\w*)=(.*)$/, (m) => `$env:${m[1]} = ${psQuote(unquote(m[2]))}`],
    [/^which\s+(\S+)$/, (m) => `Get-Command ${m[1]}`],
    [/^ls\s+-(?:la|al|a|lA|Al)$/, () => 'Get-ChildItem -Force'],
    [/^ls\s+-l$/, () => 'Get-ChildItem'],
    [/^rm\s+-(?:rf|fr|r|Rf)\s+(.+)$/, (m) => `Remove-Item -Recurse -Force ${m[1]}`],
    [/^rm\s+-f\s+(.+)$/, (m) => `Remove-Item -Force ${m[1]}`],
    [/^mkdir\s+-p\s+(.+)$/, (m) => `New-Item -ItemType Directory -Force ${m[1]}`],
    [/^cat\s+(\S+)$/, (m) => `Get-Content ${m[1]}`],
    [/^cp\s+-r\s+(\S+)\s+(\S+)$/, (m) => `Copy-Item -Recurse ${m[1]} ${m[2]}`],
    [/^mv\s+(\S+)\s+(\S+)$/, (m) => `Move-Item ${m[1]} ${m[2]}`],
    [/^unset\s+([A-Za-z_]\w*)$/, (m) => `Remove-Item Env:${m[1]}`],
    [/^env$/, () => 'Get-ChildItem Env:'],
  ],
  'cmd>powershell': [
    [/^set\s+([A-Za-z_]\w*)=(.*)$/i, (m) => `$env:${m[1]} = ${psQuote(unquote(m[2]))}`],
    [/^dir$/i, () => 'Get-ChildItem'],
    [/^dir\s+\/s\s+\/b$/i, () => 'Get-ChildItem -Recurse -Name'],
    [/^type\s+(\S+)$/i, (m) => `Get-Content ${m[1]}`],
    [/^del\s+(\S+)$/i, (m) => `Remove-Item ${m[1]}`],
    [/^where\s+(\S+)$/i, (m) => `Get-Command ${m[1]}`],
  ],
  'powershell>bash': [
    [/^\$env:([A-Za-z_]\w*)\s*=\s*(.*)$/, (m) => `export ${m[1]}=${shQuote(unquote(m[2]))}`],
    [/^Get-Command\s+(\S+)$/i, (m) => `which ${m[1]}`],
    [/^Get-ChildItem(?:\s+-Force)?$/i, () => 'ls -la'],
    [/^Remove-Item\s+-Recurse\s+-Force\s+(.+)$/i, (m) => `rm -rf ${m[1]}`],
    [/^Get-Content\s+(\S+)$/i, (m) => `cat ${m[1]}`],
    [/^New-Item\s+-ItemType\s+Directory(?:\s+-Force)?\s+(.+)$/i, (m) => `mkdir -p ${m[1]}`],
  ],
  'cmd>bash': [
    [/^set\s+([A-Za-z_]\w*)=(.*)$/i, (m) => `export ${m[1]}=${shQuote(unquote(m[2]))}`],
    [/^dir$/i, () => 'ls -la'],
    [/^type\s+(\S+)$/i, (m) => `cat ${m[1]}`],
    [/^where\s+(\S+)$/i, (m) => `which ${m[1]}`],
  ],
  'bash>cmd': [
    [/^export\s+([A-Za-z_]\w*)=(.*)$/, (m) => `set ${m[1]}=${unquote(m[2])}`],
    [/^cat\s+(\S+)$/, (m) => `type ${m[1]}`],
    [/^which\s+(\S+)$/, (m) => `where ${m[1]}`],
  ],
  'powershell>cmd': [
    [/^\$env:([A-Za-z_]\w*)\s*=\s*(.*)$/, (m) => `set ${m[1]}=${unquote(m[2])}`],
    [/^Get-Content\s+(\S+)$/i, (m) => `type ${m[1]}`],
  ],
};

// PowerShell automatic variables that mean the same as their bash namesakes.
const PS_AUTOMATIC = new Set(['HOME', 'PWD']);

// Token-level rewrites applied inside otherwise-portable commands.
function rewriteTokens(cmd, from, to) {
  let out = cmd;
  if (to === 'powershell') {
    if (from === 'bash') {
      out = out.replace(/(^|\s)~\//g, '$1$HOME/').replace(/\/dev\/null/g, '$null')
        .replace(/\$\{([A-Z_][A-Z0-9_]*)\}|\$([A-Z_][A-Z0-9_]*)\b/g, (_, a, b) => (PS_AUTOMATIC.has(a || b) ? `$${a || b}` : `$env:${a || b}`));
    }
    if (from === 'cmd') out = out.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, '$env:$1');
  } else if (to === 'bash') {
    if (from === 'powershell') out = out.replace(/\$env:([A-Za-z_]\w*)/g, '$$$1').replace(/\$null\b/g, '/dev/null');
    if (from === 'cmd') out = out.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, '$$$1');
  } else if (to === 'cmd') {
    if (from === 'powershell') out = out.replace(/\$env:([A-Za-z_]\w*)/g, '%$1%');
    if (from === 'bash') out = out.replace(/\$\{([A-Z_][A-Z0-9_]*)\}|\$([A-Z_][A-Z0-9_]*)\b/g, (_, a, b) => `%${a || b}%`);
  }
  return out;
}

function convertSegment(seg, from, to) {
  const trimmed = seg.trim();
  for (const [re, fn] of RULES[`${from}>${to}`] || []) {
    const m = re.exec(trimmed);
    if (m) return fn(m);
  }
  if (PORTABLE_RE.test(trimmed)) return rewriteTokens(trimmed, from, to);
  return null;
}

// Joins converted segments with the target's "and then if it worked" operator.
// PowerShell 5.1 has no &&; 7+ does.
function joinAnd(parts, to, psVersion) {
  if (parts.length === 1) return parts[0];
  if (to === 'powershell' && psVersion < 7) {
    return parts.reduce((acc, p) => `${acc}; if ($?) { ${p} }`);
  }
  return parts.join(' && ');
}

// Full-command local translation. Returns a string only when every segment
// could be translated confidently; otherwise null (and the AI takes over).
function translateLocal(command, from, to, { psVersion = 7 } = {}) {
  if (!command || from === to || /[|<>`]|\$\(/.test(command.replace(/\/dev\/null/g, ''))) return null;
  const segments = command.split(/\s*&&\s*/);
  if (segments.some((s) => /;/.test(s))) return null;
  const parts = [];
  for (const seg of segments) {
    const converted = convertSegment(seg, from, to);
    if (converted == null) return null;
    parts.push(converted);
  }
  const result = joinAnd(parts, to, psVersion);
  return result === command ? null : result;
}

// Syntax that ties a command to one shell even if the program is portable.
const SHELL_SPECIFIC_RE = /\$env:|%[A-Za-z_][A-Za-z0-9_]*%|\$[A-Za-z_{(]|`|\|\s*(?:%|\?|Where-Object|Select-Object|ForEach-Object)\b|\bexport\s|\bset\s+\w+=/i;

// A command that can be suggested in any shell, e.g. "npm run build" or
// "git log --oneline" (but not "echo $env:PATH").
function isPortable(command) {
  return typeof command === 'string' && PORTABLE_RE.test(command.trim()) && !SHELL_SPECIFIC_RE.test(command);
}

module.exports = { detect, foreignTo, translateLocal, isPortable, PORTABLE_RE, SHELL_SPECIFIC_RE, DIALECTS, KIND_TO_DIALECT };
