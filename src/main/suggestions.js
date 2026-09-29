'use strict';

// Validation of AI suggestion lists. Pure functions, no Electron, so they can be unit tested.

const MAX_SUGGESTION = 500;

const { classify } = require('./guard');

function cleanLine(value, max) {
  if (typeof value !== 'string') return null;
  const line = value.trim().replace(/^`+|`+$/g, '').trim();
  if (!line || line.length > max || /[\x00-\x1f\x7f]/.test(line)) return null;
  return line;
}

// Parses the model's JSON and validates every item. Anything malformed is dropped.
function parseSuggestions(text, input, count) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return [];
  let data;
  try {
    data = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  const raw = Array.isArray(data && data.suggestions) ? data.suggestions : [];
  const natural = input.trimStart().startsWith('#');
  const seen = new Set();
  const items = [];
  for (const s of raw) {
    if (!s || typeof s !== 'object') continue;
    let command = cleanLine(s.command, MAX_SUGGESTION);
    if (!command || seen.has(command)) continue;
    // Tolerate case-only differences in what the user typed.
    if (!natural && !command.startsWith(input) && command.toLowerCase().startsWith(input.toLowerCase())) {
      command = input + command.slice(input.length);
    }
    const extends_ = !natural && command.startsWith(input) && command.length > input.length;
    if (!natural && command === input.trim()) continue;
    seen.add(command);
    items.push({
      command,
      note: cleanLine(s.note, 120) || '',
      kind: extends_ ? 'extend' : 'replace',
      destructive: Boolean(s.destructive) || classify(command).length > 0,
    });
    if (items.length >= count) break;
  }
  return items;
}

module.exports = { parseSuggestions, MAX_SUGGESTION };
