'use strict';

// Picks the version to release: package.json's version, or the next free one
// if that is already released, so every merge to main ships as an update.
//   0.2.0-beta.1 taken -> 0.2.0-beta.2 (after the highest existing beta.N)
//   0.2.0 taken        -> 0.2.1
// Usage: git tags / release tags on stdin, one per line (with or without "v").

function nextVersion(base, taken) {
  const used = new Set(taken.map((t) => t.trim().replace(/^v/, '')).filter(Boolean));
  if (!used.has(base)) return base;
  const pre = /^(\d+\.\d+\.\d+)-([0-9A-Za-z-]+)\.(\d+)$/.exec(base);
  if (pre) {
    const [, core, id] = pre;
    let max = Number(pre[3]);
    for (const v of used) {
      const m = /^(\d+\.\d+\.\d+)-([0-9A-Za-z-]+)\.(\d+)$/.exec(v);
      if (m && m[1] === core && m[2] === id) max = Math.max(max, Number(m[3]));
    }
    return `${core}-${id}.${max + 1}`;
  }
  const stable = /^(\d+)\.(\d+)\.(\d+)$/.exec(base);
  if (!stable) throw new Error(`Unsupported version: ${base}`);
  let patch = Number(stable[3]);
  let candidate;
  do {
    patch += 1;
    candidate = `${stable[1]}.${stable[2]}.${patch}`;
  } while (used.has(candidate));
  return candidate;
}

if (require.main === module) {
  const base = process.argv[2] || require('../package.json').version;
  const input = require('fs').readFileSync(0, 'utf8');
  process.stdout.write(nextVersion(base, input.split(/\r?\n/)));
}

module.exports = { nextVersion };
