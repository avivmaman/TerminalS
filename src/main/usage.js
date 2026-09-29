'use strict';

// Local AI usage meter. Stores per-day counters only (requests, tokens,
// estimated cost) — never command text, output or responses.

const path = require('path');
const store = require('./store');

const KEEP_DAYS = 90;

// USD per million tokens [input, output]. Claude list prices, which also apply
// to Claude on Microsoft Foundry. Azure OpenAI pricing varies by contract, so
// it gets no estimate.
const PRICES = {
  'claude-opus-5': [5, 25],
  'claude-sonnet-5': [2, 10],
  'claude-haiku-4-5': [1, 5],
};

let data = null;
let saveTimer = null;

function file() {
  return path.join(store.dataDir(), 'usage.json');
}

function load() {
  if (!data) {
    const saved = store.readJson(file(), {});
    data = { days: saved && typeof saved.days === 'object' ? saved.days : {} };
  }
  return data;
}

function flush() {
  clearTimeout(saveTimer);
  if (data) store.writeJsonAtomic(file(), data);
}

function dayKey(date = new Date()) {
  const d = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return d.toISOString().slice(0, 10);
}

function emptyDay() {
  return { requests: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, errors: 0, byType: {}, byProvider: {} };
}

function priceFor(provider, model) {
  if (provider === 'azure-openai') return null;
  return PRICES[model] || null;
}

// Normalises the usage block of an Anthropic or OpenAI response.
function tokensFrom(usage) {
  if (!usage) return { input: 0, output: 0 };
  const input = (usage.input_tokens || usage.prompt_tokens || 0)
    + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
  const output = usage.output_tokens || usage.completion_tokens || 0;
  return { input, output };
}

function record({ type, provider, model, usage, error }) {
  const all = load();
  const key = dayKey();
  const day = all.days[key] || (all.days[key] = emptyDay());
  const { input, output } = tokensFrom(usage);
  day.requests += 1;
  if (error) day.errors += 1;
  day.inputTokens += input;
  day.outputTokens += output;
  const price = priceFor(provider, model);
  if (price) day.costUsd += (input * price[0] + output * price[1]) / 1e6;
  day.byType[type] = (day.byType[type] || 0) + 1;
  day.byProvider[provider] = (day.byProvider[provider] || 0) + 1;

  const keys = Object.keys(all.days).sort();
  for (const old of keys.slice(0, Math.max(0, keys.length - KEEP_DAYS))) delete all.days[old];
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, 1000);
}

function today() {
  return load().days[dayKey()] || emptyDay();
}

// Summary for the status bar and Settings: today, last 7 and 30 days.
function summary() {
  const all = load();
  const sum = (n) => {
    const out = emptyDay();
    for (let i = 0; i < n; i++) {
      const d = all.days[dayKey(new Date(Date.now() - i * 86400000))];
      if (!d) continue;
      out.requests += d.requests;
      out.inputTokens += d.inputTokens;
      out.outputTokens += d.outputTokens;
      out.costUsd += d.costUsd;
      out.errors += d.errors;
      for (const [k, v] of Object.entries(d.byType)) out.byType[k] = (out.byType[k] || 0) + v;
    }
    return out;
  };
  return { today: today(), week: sum(7), month: sum(30) };
}

// Daily caps from Settings (0 = no cap). Returns a reason string when reached.
function capReached(caps) {
  if (!caps) return null;
  const d = today();
  if (caps.dailyRequests > 0 && d.requests >= caps.dailyRequests) return `Daily AI request cap reached (${caps.dailyRequests}).`;
  if (caps.dailyTokens > 0 && d.inputTokens + d.outputTokens >= caps.dailyTokens) return `Daily AI token cap reached (${caps.dailyTokens.toLocaleString()}).`;
  return null;
}

function reset() {
  data = { days: {} };
  flush();
}

module.exports = { record, summary, capReached, reset, flush, tokensFrom };
