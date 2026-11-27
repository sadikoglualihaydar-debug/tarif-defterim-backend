import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const CACHE_FILE = path.join(DATA_DIR, 'url_cache.json');

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

export function normalizeCacheKey(rawUrl) {
  try {
    const u = new URL(rawUrl.trim());
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
  const keys = Object.keys(cache);
  if (keys.length > 1000) {
    keys
      .sort((a, b) => (cache[a].cachedAt || 0) - (cache[b].cachedAt || 0))
      .slice(0, keys.length - 1000)
      .forEach((oldKey) => delete cache[oldKey]);
  }
  writeJsonSafe(CACHE_FILE, cache);
}
