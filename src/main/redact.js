'use strict';

// Best-effort scrubbing of secrets from command lines before they leave the
// machine (AI requests) or get persisted (history). Errs on the side of
// over-redacting: a lost suggestion is cheap, a leaked token is not.

const MASK = '<redacted>';
const QUOTED_OR_BARE = String.raw`("[^"]*"|'[^']*'|[^\s;]+)`;
const SECRET_WORDS = String.raw`(?:password|passwd|pwd|passphrase|secret|token|api[-_]?key|apikey|access[-_]?key|private[-_]?key|client[-_]?secret|credential|auth)s?`;

const RULES = [
  // Private key blocks pasted inline.
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, MASK],
  // NAME=value / NAME: value, including prefixed names like GITHUB_TOKEN and $env:API_KEY.
  [new RegExp(String.raw`([A-Za-z0-9_-]*${SECRET_WORDS}\s*[=:]\s*)${QUOTED_OR_BARE}`, 'gi'), `$1${MASK}`],
  // --password value / --token=value / -Password value (PowerShell parameters).
  [new RegExp(String.raw`(\s--?[A-Za-z-]*${SECRET_WORDS}(?:=|\s+))${QUOTED_OR_BARE}`, 'gi'), `$1${MASK}`],
  // Tools whose -p flag carries a password (mysql -pSECRET, sshpass -p SECRET).
  [/(\b(?:mysql|mysqldump|mysqladmin|mariadb|sshpass|mongo|mongosh)\b[^\n]*?\s-p\s*)(\S+)/gi, `$1${MASK}`],
  [/(ConvertTo-SecureString\s+(?:-String\s+)?)("[^"]*"|'[^']*'|\S+)/gi, `$1${MASK}`],
  [/(\bbearer\s+)[A-Za-z0-9._~+/=-]+/gi, `$1${MASK}`],
  [/(\bbasic\s+)[A-Za-z0-9+/=]{8,}/gi, `$1${MASK}`],
  // Credentials embedded in URLs: scheme://user:pass@host
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)[^\s@/]+@/gi, `$1${MASK}@`],
  // Well-known token formats.
  [/\bsk-[A-Za-z0-9_-]{16,}/g, MASK],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, MASK],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, MASK],
  [/\bglpat-[A-Za-z0-9_-]{20,}/g, MASK],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, MASK],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, MASK],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, MASK],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, MASK],
  // Long high-entropy blobs (base64/hex keys). Also catches git SHAs, which is harmless.
  [/(?<![A-Za-z0-9+/_-])[A-Za-z0-9+/_-]{40,}={0,2}/g, MASK],
];

function redact(text) {
  if (typeof text !== 'string' || text.length === 0) return text;
  let out = text;
  for (const [pattern, replacement] of RULES) out = out.replace(pattern, replacement);
  return out;
}

function looksSensitive(text) {
  return typeof text === 'string' && redact(text) !== text;
}

module.exports = { redact, looksSensitive, MASK };
