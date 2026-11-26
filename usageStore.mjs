import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const CACHE_FILE = path.join(DATA_DIR, 'url_cache.json');
const METRICS_FILE = path.join(DATA_DIR, 'usage_metrics.json');

// Approximate Pay-as-you-go Gemini pricing (USD per 1M tokens)
// Used for live cost tracking & daily budget protection
const MODEL_PRICING = {
  'gemini-3.8-flash': { inputPer1M: 0.3, outputPer1M: 2.5 },
  'gemini-2.5-flash-lite': { inputPer1M: 0.1, outputPer1M: 0.4 },
  'gemini-2.5-flash': { inputPer1M: 0.3, outputPer1M: 2.5 },
  'google/gemini-3.5-flash-lite': { inputPer1M: 0.1, outputPer1M: 0.4 },
  'google/gemini-2.5-flash': { inputPer1M: 0.3, outputPer1M: 2.5 },
  'google/gemini-3.8-flash': { inputPer1M: 0.3, outputPer1M: 2.5 },
  'google/gemini-flash-latest': { inputPer1M: 0.3, outputPer1M: 2.5 },
};

// Credit costs per analysis stage (for Pay-as-you-go user metering)
export const STAGE_CREDIT_COST = {
  cache_hit: 0,
  web_free: 0,
  ocr_free: 0,
  caption_lite: 0.25,
  audio_compressed: 1,
  video_visual: 2,
  youtube_direct: 2,
  image_ai: 0.5,
  uploaded_video_ai: 2,
};

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJsonSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonSafe(filePath, data) {
  ensureDataDir();
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

export function estimateCostUsd(model, promptTokens = 0, outputTokens = 0) {
  const rate = MODEL_PRICING[model] || MODEL_PRICING['gemini-2.5-flash'];
  const cost =
    (promptTokens / 1_000_000) * rate.inputPer1M +
    (outputTokens / 1_000_000) * rate.outputPer1M;
  return Math.round(cost * 1_000_000) / 1_000_000;
}

export function normalizeCacheKey(rawUrl) {
  try {
    const u = new URL(rawUrl.trim());
    // Strip tracking params (utm_*, igsh, si, fbclid) so identical reels hit cache!
    const removeKeys = [];
    for (const key of u.searchParams.keys()) {
      if (/^(utm_|igsh|si$|fbclid$|feature$|pp$)/i.test(key)) {
        removeKeys.push(key);
      }
    }
    for (const k of removeKeys) u.searchParams.delete(k);
    u.hash = '';
    return u.toString().replace(/\/+$/, '').toLowerCase();
  } catch {
    return rawUrl.trim().toLowerCase();
  }
}

export function getCachedRecipe(rawUrl) {
  const cache = readJsonSafe(CACHE_FILE, {});
  const key = normalizeCacheKey(rawUrl);
  const entry = cache[key];
  if (!entry) return null;
  // Cache valid for 30 days
  const ageMs = Date.now() - Number(entry.cachedAt || 0);
  if (ageMs > 30 * 24 * 60 * 60 * 1000) return null;
  return entry.draft || null;
}

export function setCachedRecipe(rawUrl, draft) {
  const cache = readJsonSafe(CACHE_FILE, {});
  const key = normalizeCacheKey(rawUrl);
  cache[key] = {
    cachedAt: Date.now(),
    draft,
  };
  // Keep latest 1000 cached URLs to bound disk usage
  const keys = Object.keys(cache);
  if (keys.length > 1000) {
    keys
      .sort((a, b) => (cache[a].cachedAt || 0) - (cache[b].cachedAt || 0))
      .slice(0, keys.length - 1000)
      .forEach((oldKey) => delete cache[oldKey]);
  }
  writeJsonSafe(CACHE_FILE, cache);
}

function getTodayKey() {
  return new Date().toISOString().slice(0, 10);
}

export function loadMetrics() {
  return readJsonSafe(METRICS_FILE, {
    totalRequests: 0,
    totalEstimatedUsd: 0,
    byStage: {},
    dailyUsd: {},
    users: {},
  });
}

export function checkBudgetAndCredits({ userId, dailyBudgetUsd, requireCredits, freeStarterCredits }) {
  const metrics = loadMetrics();
  const today = getTodayKey();
  const spentToday = Number(metrics.dailyUsd?.[today] || 0);

  if (dailyBudgetUsd > 0 && spentToday >= dailyBudgetUsd) {
    return {
      allowed: false,
      status: 429,
      error: `Günlük sunucu analiz bütçesi ($${dailyBudgetUsd.toFixed(2)}) doldu. Yarın sıfırlanacaktır.`,
    };
  }

  if (requireCredits) {
    const uid = userId || 'anonymous';
    const user = metrics.users[uid] || {
      credits: freeStarterCredits,
      totalAnalyses: 0,
      spentUsd: 0,
    };
    if (user.credits <= 0) {
      return {
        allowed: false,
        status: 402,
        error: 'Kullandığın kadar öde krediniz bitti. Yeni kredi paketi ekleyerek devam edebilirsiniz.',
      };
    }
  }

  return { allowed: true };
}

export function recordUsage({
  userId = 'anonymous',
  stage,
  model = 'none',
  promptTokens = 0,
  outputTokens = 0,
  freeStarterCredits = 10,
}) {
  const metrics = loadMetrics();
  const today = getTodayKey();
  const estimatedCostUsd = model === 'none' ? 0 : estimateCostUsd(model, promptTokens, outputTokens);
  const creditsUsed = STAGE_CREDIT_COST[stage] ?? 1;

  metrics.totalRequests = (metrics.totalRequests || 0) + 1;
  metrics.totalEstimatedUsd =
    Math.round(((metrics.totalEstimatedUsd || 0) + estimatedCostUsd) * 1_000_000) / 1_000_000;
  metrics.byStage[stage] = (metrics.byStage[stage] || 0) + 1;
  metrics.dailyUsd[today] =
    Math.round(((metrics.dailyUsd[today] || 0) + estimatedCostUsd) * 1_000_000) / 1_000_000;

  if (!metrics.users[userId]) {
    metrics.users[userId] = {
      credits: freeStarterCredits,
      totalAnalyses: 0,
      spentUsd: 0,
    };
  }
  metrics.users[userId].totalAnalyses += 1;
  metrics.users[userId].spentUsd =
    Math.round((metrics.users[userId].spentUsd + estimatedCostUsd) * 1_000_000) / 1_000_000;
  metrics.users[userId].credits = Math.max(
    0,
    Math.round((metrics.users[userId].credits - creditsUsed) * 100) / 100
  );

  writeJsonSafe(METRICS_FILE, metrics);

  return {
    stage,
    model,
    promptTokens,
    outputTokens,
    estimatedCostUsd,
    creditsUsed,
    remainingCredits: metrics.users[userId].credits,
    todaySpentUsd: metrics.dailyUsd[today],
  };
}

export function getUserCredits(userId = 'anonymous', freeStarterCredits = 10) {
  const metrics = loadMetrics();
  const u = metrics.users[userId];
  return u ? u.credits : freeStarterCredits;
}
