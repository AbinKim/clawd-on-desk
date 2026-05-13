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

// ── Per-model context window limit (tokens). Defaults follow Anthropic's
// "headline" tier for each family. Opus 4.7 ships with 1M context as the
// public maximum; Sonnet/Haiku 4.x are still 200K. Users on a smaller
// tier (e.g. legacy 200K Opus accounts) can override via the optional
// overrides argument — getContextLimit also auto-bumps if a measured
// turn exceeds the configured limit, so the gauge never lies.
const DEFAULT_CONTEXT_LIMITS = {
  "claude-opus-4-7": 1_000_000,
  "claude-opus-4-6": 200_000,
  "claude-sonnet-4-6": 200_000,
  "claude-sonnet-4-5": 200_000,
  "claude-haiku-4-5": 200_000,
};

const CONTEXT_FAMILY_FALLBACK = [
  { prefix: "claude-opus-4-7", limit: 1_000_000 },
  { prefix: "claude-opus-4", limit: 200_000 },
  { prefix: "claude-sonnet-4", limit: 200_000 },
  { prefix: "claude-haiku-4", limit: 200_000 },
];

function getContextLimit(modelId, overrides, measuredSize) {
  let base = 200_000;
  if (modelId && typeof modelId === "string") {
    const table = overrides && typeof overrides === "object"
      ? { ...DEFAULT_CONTEXT_LIMITS, ...overrides }
      : DEFAULT_CONTEXT_LIMITS;
    if (table[modelId]) base = table[modelId];
    else {
      for (const entry of CONTEXT_FAMILY_FALLBACK) {
        if (modelId.startsWith(entry.prefix)) { base = entry.limit; break; }
      }
    }
  }
  // Auto-bump to the next standard tier if we observe an actual turn
  // larger than our table. Avoids the gauge showing >100% when the user
  // is on a higher tier than we knew about.
  const measured = Number(measuredSize) || 0;
  if (measured > base) {
    if (measured <= 1_000_000) return 1_000_000;
    if (measured <= 2_000_000) return 2_000_000;
    return measured;
  }
  return base;
}

module.exports = {
  DEFAULT_PRICING,
  DEFAULT_CONTEXT_LIMITS,
  getPricing,
  getContextLimit,
  computeCostUsd,
};
