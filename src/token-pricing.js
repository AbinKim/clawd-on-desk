"use strict";

// Per-million-token USD prices. Match by exact model id first, then prefix.
// Source: Anthropic public pricing (verify periodically; users can override
// via Settings later). All numbers are USD per 1,000,000 tokens.
const DEFAULT_PRICING = {
  // Opus 4 family
  "claude-opus-4-7": {
    input: 15,
    output: 75,
    cache_write_5m: 18.75,
    cache_write_1h: 30,
    cache_read: 1.5,
  },
  "claude-opus-4-6": {
    input: 15,
    output: 75,
    cache_write_5m: 18.75,
    cache_write_1h: 30,
    cache_read: 1.5,
  },
  // Sonnet 4 family
  "claude-sonnet-4-6": {
    input: 3,
    output: 15,
    cache_write_5m: 3.75,
    cache_write_1h: 6,
    cache_read: 0.3,
  },
  "claude-sonnet-4-5": {
    input: 3,
    output: 15,
    cache_write_5m: 3.75,
    cache_write_1h: 6,
    cache_read: 0.3,
  },
  // Haiku 4 family
  "claude-haiku-4-5": {
    input: 0.8,
    output: 4,
    cache_write_5m: 1,
    cache_write_1h: 1.6,
    cache_read: 0.08,
  },
};

const FAMILY_FALLBACK = [
  { prefix: "claude-opus-4", price: DEFAULT_PRICING["claude-opus-4-7"] },
  { prefix: "claude-sonnet-4", price: DEFAULT_PRICING["claude-sonnet-4-6"] },
  { prefix: "claude-haiku-4", price: DEFAULT_PRICING["claude-haiku-4-5"] },
];

function getPricing(modelId, overrides) {
  if (!modelId || typeof modelId !== "string") return null;
  const table = overrides && typeof overrides === "object"
    ? { ...DEFAULT_PRICING, ...overrides }
    : DEFAULT_PRICING;
  if (table[modelId]) return table[modelId];
  for (const entry of FAMILY_FALLBACK) {
    if (modelId.startsWith(entry.prefix)) return entry.price;
  }
  return null;
}

function computeCostUsd(usage, modelId, overrides) {
  const price = getPricing(modelId, overrides);
  if (!price) return null;
  const input = Number(usage?.input_tokens || 0);
  const output = Number(usage?.output_tokens || 0);
  const cacheRead = Number(usage?.cache_read_input_tokens || 0);
  const cache5m = Number(usage?.cache_creation?.ephemeral_5m_input_tokens || 0);
  const cache1h = Number(usage?.cache_creation?.ephemeral_1h_input_tokens || 0);
  const cacheWriteTotal = Number(usage?.cache_creation_input_tokens || 0);
  // If split is missing, treat all cache_creation as 5m (more common default).
  const w5 = cache5m || (cache1h ? 0 : cacheWriteTotal);
  const w1 = cache1h;
  const cost =
    (input * price.input +
      output * price.output +
      w5 * price.cache_write_5m +
      w1 * price.cache_write_1h +
      cacheRead * price.cache_read) /
    1_000_000;
  return Math.round(cost * 1_000_000) / 1_000_000; // 6dp
}

module.exports = {
  DEFAULT_PRICING,
  getPricing,
  computeCostUsd,
};
