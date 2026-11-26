import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  checkBudgetAndCredits,
  getCachedRecipe,
  getUserCredits,
  loadMetrics,
  recordUsage,
  setCachedRecipe,
} from './usageStore.mjs';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PARENT_TOOLS_DIR = path.join(__dirname, '..', 'tools');
const LOCAL_TMP_ROOT =
  process.env.TMP_DIR ||
  (process.env.K_SERVICE ? '/tmp/tarif-defterim-tmp' : path.join(__dirname, '.tmp'));
const DIST_DIR = path.join(__dirname, '..', 'dist');

// Load .env if present (zero external dependency dotenv loader)
function loadDotEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
    if (key && !(key in process.env)) {
      process.env[key] = val;
    }
  }
}
loadDotEnv();

const PORT = Number(process.env.PORT) || 8081;
const GEMINI_TEXT_MODEL = (process.env.GEMINI_TEXT_MODEL || 'gemini-3.8-flash').trim();
const GEMINI_MEDIA_MODEL = (process.env.GEMINI_MEDIA_MODEL || 'gemini-3.8-flash').trim();
const OPENROUTER_TEXT_MODEL = (
  process.env.OPENROUTER_TEXT_MODEL || 'google/gemini-2.5-flash'
).trim();
const OPENROUTER_MEDIA_MODEL = (
  process.env.OPENROUTER_MEDIA_MODEL || 'google/gemini-2.5-flash'
).trim();
const DAILY_BUDGET_USD = Number(process.env.DAILY_BUDGET_USD || 5.0);
const APP_CLIENT_TOKEN = (process.env.APP_CLIENT_TOKEN || '').trim();
const REQUIRE_CREDITS = String(process.env.REQUIRE_CREDITS || 'false').toLowerCase() === 'true';
const FREE_STARTER_CREDITS = Number(process.env.FREE_STARTER_CREDITS || 10);

function readEnvKey(keyName) {
  if (process.env[keyName] && process.env[keyName].trim()) {
    return process.env[keyName].trim().replace(/^["']|["']$/g, '');
  }
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
    const re = new RegExp(`^\\s*${keyName}\\s*=\\s*(.+)\\s*$`);
    for (const line of lines) {
      const m = line.match(re);
      if (m?.[1]) {
        const val = m[1].trim().replace(/^["']|["']$/g, '');
        if (val) return val;
      }
    }
  }
  return '';
}

function getOpenRouterApiKey() {
  return readEnvKey('OPENROUTER_API_KEY');
}

function getGeminiApiKey() {
  return readEnvKey('GEMINI_API_KEY');
}

function getActiveProvider() {
  if (getOpenRouterApiKey()) return 'openrouter';
  if (getGeminiApiKey()) return 'gemini';
  return 'none';
}

const VALID_CATEGORIES = new Set([
  'Ana Yemek',
  'Kahvaltı',
  'Çorba',
  'Salata & Meze',
  'Hamur İşi',
  'Tatlı',
  'İçecek',
  'Atıştırmalık',
  'Diğer',
]);

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.webp': 'image/webp',
};

const RECIPE_JSON_PROMPT = `Sen uzman bir Türkçe yemek tarifi asistanısın.
Sana verilen içerikten (metin açıklaması, konuşma sesi veya video görseli) eksiksiz bir yemek tarifi çıkar.
Kurallar:
- Çıktıyı SADECE geçerli JSON olarak ver (markdown kod bloğu ekleme).
- Dil tamamen doğal Türkçe olsun (içerik yabancı dildeyse Türkçeye çevir).
- Malzemelerde ölçü/miktar belirtildiyse mutlaka ekle.
- Pişirme sürelerini adımlara açıkça yaz (ör. "180 derece fırında 25 dakika pişirin.").
- category alanı şu listeden birebir biri olmalı: "Ana Yemek", "Kahvaltı", "Çorba", "Salata & Meze", "Hamur İşi", "Tatlı", "İçecek", "Atıştırmalık", "Diğer".
- Eğer bu aşamada verilen seste veya metinde gerçek bir tarif anlatımı YOKSA (örneğin video sadece müzikli ve tarif ekranda yazılı gösteriliyorsa), "needsVisualAnalysis": true döndür.
JSON şeması:
{
  "needsVisualAnalysis": false,
  "title": "Tarif adı",
  "description": "1-2 cümlelik kısa özet",
  "category": "Ana Yemek",
  "prepMinutes": 15,
  "cookMinutes": 25,
  "servings": 4,
  "ingredients": ["malzeme 1", "malzeme 2"],
  "steps": ["adım 1", "adım 2"],
  "notes": "Püf noktaları (yoksa boş string)"
}`;

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-App-Token, X-User-Id',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  });
  res.end(JSON.stringify(payload));
}

function readJsonBody(req, maxBytes = 65 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('Dosya boyutu çok büyük (maksimum 45 MB).'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('Geçersiz JSON isteği.'));
      }
    });
    req.on('error', reject);
  });
}

function isSafeExternalUrl(raw) {
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    const host = parsed.hostname.toLowerCase();
    if (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '0.0.0.0' ||
      host === '::1' ||
      host.startsWith('10.') ||
      host.startsWith('192.168.') ||
      host.startsWith('169.254.') ||
      /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function checkClientAuth(req) {
  if (!APP_CLIENT_TOKEN) return true;
  return req.headers['x-app-token'] === APP_CLIENT_TOKEN;
}

async function resolveYtDlpBinary() {
  const localWin = path.join(PARENT_TOOLS_DIR, 'yt-dlp.exe');
  if (fs.existsSync(localWin)) return localWin;
  const localUnix = path.join(PARENT_TOOLS_DIR, 'yt-dlp');
  if (fs.existsSync(localUnix)) return localUnix;
  try {
    await execFileAsync('yt-dlp', ['--version'], { timeout: 5000 });
    return 'yt-dlp';
  } catch {
    return null;
  }
}

async function hasFfmpegBinary() {
  try {
    await execFileAsync('ffmpeg', ['-version'], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

function normalizeGeminiRecipe(rawObj, fallbackMeta = {}) {
  const category = VALID_CATEGORIES.has(rawObj?.category) ? rawObj.category : 'Ana Yemek';
  const ingredients = Array.isArray(rawObj?.ingredients)
    ? rawObj.ingredients.map((x) => String(x).trim()).filter(Boolean)
    : [];
  const steps = Array.isArray(rawObj?.steps)
    ? rawObj.steps.map((x) => String(x).trim()).filter(Boolean)
    : [];

  return {
    title: String(rawObj?.title || fallbackMeta.title || 'Video Tarifi').trim(),
    description: String(rawObj?.description || '').trim().slice(0, 260),
    category,
    imageUri: fallbackMeta.imageUri || undefined,
    prepMinutes: Math.max(0, Number(rawObj?.prepMinutes) || 15),
    cookMinutes: Math.max(0, Number(rawObj?.cookMinutes) || 25),
    servings: Math.max(1, Number(rawObj?.servings) || 4),
    ingredients: ingredients.length > 0 ? ingredients : ['Malzemeler tespit edilemedi, elle ekleyin'],
    steps: steps.length > 0 ? steps : ['Adımlar tespit edilemedi, elle ekleyin'],
    notes: String(rawObj?.notes || '').trim(),
    sourceUrl: fallbackMeta.sourceUrl || undefined,
    sourceType: 'url',
  };
}

/** Checks if a video caption already looks like a full written recipe (to skip heavy video AI!) */
function captionLooksLikeCompleteRecipe(caption) {
  if (!caption || caption.length < 180) return false;
  const lower = caption.toLocaleLowerCase('tr-TR');
  const hasIngredientCue = /(malzeme|içindekiler|ingredients|su bardağı|yemek kaşığı|çay kaşığı|gram|gr\b|adet\b)/i.test(
    lower
  );
  const hasStepCue = /(yapılışı|hazırlanışı|nasıl yapılır|tarif|pişirin|karıştırın|ekleyin|instructions|directions|1[.)])/i.test(
    lower
  );
  const lineCount = caption.split('\n').filter((l) => l.trim().length > 3).length;
  return hasIngredientCue && hasStepCue && lineCount >= 5;
}

function parseJsonFromGeminiText(text) {
  const cleaned = String(text || '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  return JSON.parse(cleaned);
}

async function callOpenRouter(model, contentBlocks) {
  const apiKey = getOpenRouterApiKey();
  if (!apiKey) {
    throw new Error('Sunucuda OPENROUTER_API_KEY tanımlı değil.');
  }

  const fallbackModels = (
    process.env.OPENROUTER_FALLBACK_MODELS ||
    'google/gemini-3.8-flash,google/gemini-flash-latest,google/gemini-2.5-flash'
  )
    .split(',')
    .map((m) => m.trim())
    .filter((m) => m && m !== model);

  const candidates = [model, ...fallbackModels];
  let lastError = new Error('OpenRouter API yanıt vermedi.');

  for (let cIdx = 0; cIdx < candidates.length; cIdx++) {
    const activeModel = candidates[cIdx];
    const maxAttempts = cIdx === 0 ? 2 : 1;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://tarif-defterim-api.onrender.com',
          'X-Title': 'Tarif Defterim',
        },
        body: JSON.stringify({
          model: activeModel,
          temperature: 0.2,
          response_format: { type: 'json_object' },
          messages: [{ role: 'user', content: contentBlocks }],
        }),
      });

      const data = await res.json();
      if (res.ok) {
        const rawContent = data?.choices?.[0]?.message?.content;
        const text = Array.isArray(rawContent)
          ? rawContent.map((c) => c.text || '').join('').trim()
          : String(rawContent || '').trim();
        if (!text) {
          throw new Error('OpenRouter boş yanıt döndürdü.');
        }

        const usage = data?.usage || {};
        return {
          parsed: parseJsonFromGeminiText(text),
          promptTokens: Number(usage.prompt_tokens || 0),
          outputTokens: Number(usage.completion_tokens || 0),
          usedModel: data?.model || activeModel,
        };
      }

      const msg =
        data?.error?.metadata?.raw ||
        data?.error?.message ||
        `OpenRouter API hatası (HTTP ${res.status})`;
      lastError = new Error(String(msg));

      const isRetryable =
        res.status === 503 ||
        res.status === 429 ||
        res.status === 502 ||
        /high demand|overloaded|rate limit|temporarily/i.test(String(msg));

      if (isRetryable && attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }

      if (isRetryable || res.status === 404 || res.status === 400) {
        break;
      }

      throw lastError;
    }
  }

  throw lastError;
}

async function analyzeWithAi({
  kind,
  prompt,
  buffer,
  base64,
  mimeType = 'video/mp4',
  fileName = 'media.mp4',
  youtubeUrl,
  uploadedFiles,
}) {
  const provider = getActiveProvider();
  if (provider === 'none') {
    throw new Error(
      'Sunucuda OPENROUTER_API_KEY veya GEMINI_API_KEY tanımlı değil. Render Environment sekmesine anahtarınızı ekleyin.'
    );
  }

  if (provider === 'openrouter') {
    const model = kind === 'text' ? OPENROUTER_TEXT_MODEL : OPENROUTER_MEDIA_MODEL;
    const blocks = [];

    if (kind === 'audio' && buffer) {
      blocks.push({
        type: 'input_audio',
        input_audio: {
          data: buffer.toString('base64'),
          format: mimeType.includes('wav') ? 'wav' : 'mp3',
        },
      });
    } else if (kind === 'video' && buffer) {
      blocks.push({
        type: 'video_url',
        video_url: {
          url: `data:${mimeType || 'video/mp4'};base64,${buffer.toString('base64')}`,
        },
      });
    } else if (kind === 'youtube' && youtubeUrl) {
      blocks.push({
        type: 'video_url',
        video_url: { url: youtubeUrl },
      });
    } else if (kind === 'image' && base64) {
      blocks.push({
        type: 'image_url',
        image_url: { url: `data:${mimeType};base64,${base64}` },
      });
    }

    blocks.push({ type: 'text', text: prompt });
    return callOpenRouter(model, blocks);
  }

  // Direct Google Gemini API path
  const model = kind === 'text' ? GEMINI_TEXT_MODEL : GEMINI_MEDIA_MODEL;
  if (kind === 'text') {
    return callGemini(model, [{ text: prompt }]);
  }
  if (kind === 'youtube' && youtubeUrl) {
    return callGemini(model, [{ fileData: { fileUri: youtubeUrl } }, { text: prompt }]);
  }
  if (kind === 'image' && base64) {
    return callGemini(model, [{ inlineData: { mimeType, data: base64 } }, { text: prompt }]);
  }
  if ((kind === 'audio' || kind === 'video') && buffer) {
    const uploaded = await uploadBufferToGeminiFiles(buffer, mimeType, fileName);
    if (Array.isArray(uploadedFiles)) uploadedFiles.push(uploaded.name);
    return callGemini(model, [
      { fileData: { mimeType: uploaded.mimeType || mimeType, fileUri: uploaded.uri } },
      { text: prompt },
    ]);
  }
  throw new Error('Geçersiz analiz türü.');
}

async function callGemini(model, parts) {
  const apiKey = getGeminiApiKey();
  if (!apiKey) {
    throw new Error(
      'Sunucuda GEMINI_API_KEY tanımlı değil. Sunucu .env / ortam değişkenlerine Gemini API anahtarınızı ekleyin.'
    );
  }

  const fallbackModels = (process.env.GEMINI_FALLBACK_MODELS || 'gemini-3.7-flash,gemini-3.6-flash')
    .split(',')
    .map((m) => m.trim())
    .filter((m) => m && m !== model);

  const candidates = [model, ...fallbackModels];
  let lastError = new Error('Gemini API yanıt vermedi.');

  for (let cIdx = 0; cIdx < candidates.length; cIdx++) {
    const activeModel = candidates[cIdx];
    const maxAttempts = cIdx === 0 ? 3 : 1;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${activeModel}:generateContent?key=${encodeURIComponent(
        apiKey
      )}`;

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts }],
          generationConfig: {
            temperature: 0.2,
            responseMimeType: 'application/json',
          },
        }),
      });

      const data = await res.json();
      if (res.ok) {
        const text = data?.candidates?.[0]?.content?.parts
          ?.map((p) => p.text || '')
          .join('')
          .trim();
        if (!text) {
          throw new Error('Gemini boş yanıt döndürdü.');
        }

        const usageMeta = data?.usageMetadata || {};
        return {
          parsed: parseJsonFromGeminiText(text),
          promptTokens: Number(usageMeta.promptTokenCount || 0),
          outputTokens: Number(usageMeta.candidatesTokenCount || 0),
          usedModel: activeModel,
        };
      }

      const msg = data?.error?.message || `Gemini API hatası (HTTP ${res.status})`;
      lastError = new Error(msg);

      const isOverloaded =
        res.status === 503 ||
        res.status === 429 ||
        /high demand|overloaded|temporarily unavailable/i.test(msg);

      if (isOverloaded && attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, attempt * 2500));
        continue;
      }

      // If model is overloaded or unavailable on this candidate, try next fallback model
      if (isOverloaded || res.status === 404) {
        break;
      }

      throw lastError;
    }
  }

  throw lastError;
}

async function uploadBufferToGeminiFiles(buffer, mimeType, displayName) {
  const apiKey = getGeminiApiKey();
  const startUrl = `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${encodeURIComponent(
    apiKey
  )}`;

  const startRes = await fetch(startUrl, {
    method: 'POST',
    headers: {
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(buffer.length),
      'X-Goog-Upload-Header-Content-Type': mimeType,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ file: { display_name: displayName } }),
  });

  if (!startRes.ok) {
    throw new Error(`Gemini dosya yükleme başlatılamadı (HTTP ${startRes.status}).`);
  }

  const uploadUrl = startRes.headers.get('x-goog-upload-url');
  if (!uploadUrl) throw new Error('Gemini yükleme adresi alınamadı.');

  const uploadRes = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      'Content-Length': String(buffer.length),
      'X-Goog-Upload-Offset': '0',
      'X-Goog-Upload-Command': 'upload, finalize',
    },
    body: buffer,
  });

  const uploadData = await uploadRes.json();
  if (!uploadRes.ok || !uploadData?.file?.uri) {
    throw new Error(uploadData?.error?.message || 'Dosya Gemini sunucusuna yüklenemedi.');
  }

  let fileMeta = uploadData.file;
  const deadline = Date.now() + 90_000;
  while (fileMeta.state === 'PROCESSING' && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    const checkRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/${fileMeta.name}?key=${encodeURIComponent(
        apiKey
      )}`
    );
    if (checkRes.ok) fileMeta = await checkRes.json();
  }

  if (fileMeta.state === 'FAILED') {
    throw new Error('Gemini medya dosyasını işleyemedi.');
  }

  return fileMeta;
}

async function deleteGeminiFile(fileName) {
  const apiKey = getGeminiApiKey();
  if (!fileName || !apiKey) return;
  try {
    await fetch(
      `https://generativelanguage.googleapis.com/v1beta/${fileName}?key=${encodeURIComponent(
        apiKey
      )}`,
      { method: 'DELETE' }
    );
  } catch {
    // ignore cleanup failure
  }
}

async function fetchMetadataOnlyWithYtDlp(ytDlpBin, url) {
  try {
    const { stdout } = await execFileAsync(
      ytDlpBin,
      ['--no-playlist', '--no-warnings', '--dump-single-json', '--skip-download', url],
      { timeout: 25_000, maxBuffer: 8 * 1024 * 1024 }
    );
    const info = JSON.parse(stdout);
    return {
      title: info.title || info.fulltitle || '',
      description: info.description || '',
      thumbnail: info.thumbnail || '',
      duration: Number(info.duration || 0),
    };
  } catch {
    return null;
  }
}

async function downloadMediaToTmp(ytDlpBin, url, audioOnly = false) {
  fs.mkdirSync(LOCAL_TMP_ROOT, { recursive: true });
  const tmpDir = fs.mkdtempSync(path.join(LOCAL_TMP_ROOT, 'vid-'));
  const outTemplate = path.join(tmpDir, 'media.%(ext)s');

  const formatSpec = audioOnly
    ? 'bestaudio[filesize<25M]/best[filesize<35M]/bestaudio/best'
    : 'best[ext=mp4][height<=720][filesize<40M]/best[filesize<40M]/best';

  try {
    await execFileAsync(
      ytDlpBin,
      [
        '--no-playlist',
        '--no-warnings',
        '--write-info-json',
        '--max-filesize',
        '42M',
        '-f',
        formatSpec,
        '-o',
        outTemplate,
        url,
      ],
      { timeout: 90_000, maxBuffer: 10 * 1024 * 1024 }
    );

    const files = fs.readdirSync(tmpDir);
    const infoFile = files.find((f) => f.endsWith('.info.json'));
    const mediaFile = files.find(
      (f) => f.startsWith('media.') && !f.endsWith('.json') && !f.endsWith('.part')
    );

    let info = {};
    if (infoFile) {
      try {
        info = JSON.parse(fs.readFileSync(path.join(tmpDir, infoFile), 'utf8'));
      } catch {
        info = {};
      }
    }

    if (!mediaFile) {
      throw new Error('Video/ses indirilemedi (gizli hesap veya boyut sınırı olabilir).');
    }

    return {
      tmpDir,
      filePath: path.join(tmpDir, mediaFile),
      title: info.title || info.fulltitle || '',
      description: info.description || '',
      thumbnail: info.thumbnail || '',
    };
  } catch (err) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    throw err;
  }
}

/** Compresses media into tiny 32kbps mono MP3 (~250KB/min) for ultra-cheap Gemini audio analysis */
async function compressToSpeechMp3(inputPath, tmpDir) {
  const outPath = path.join(tmpDir, 'speech.mp3');
  await execFileAsync(
    'ffmpeg',
    ['-y', '-i', inputPath, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '32k', outPath],
    { timeout: 60_000 }
  );
  return outPath;
}

/** Compresses video into 1 fps 480p MP4 so silent on-screen recipe text is readable at ~80% lower token cost */
async function compressToLowFpsVideo(inputPath, tmpDir) {
  const outPath = path.join(tmpDir, 'compact.mp4');
  await execFileAsync(
    'ffmpeg',
    [
      '-y',
      '-i',
      inputPath,
      '-vf',
      "fps=1,scale='min(480,iw)':-2",
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '30',
      '-c:a',
      'aac',
      '-ac',
      '1',
      '-b:a',
      '32k',
      outPath,
    ],
    { timeout: 90_000 }
  );
  return outPath;
}

async function tryFetchInstagramEmbed(url) {
  const match = url.match(/instagram\.com\/(?:reel|reels|p|tv)\/([A-Za-z0-9_-]+)/i);
  if (!match) return null;
  const embedUrl = `https://www.instagram.com/p/${match[1]}/embed/captioned/`;
  try {
    const res = await fetch(embedUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        'Accept-Language': 'tr-TR,tr;q=0.9,en;q=0.8',
      },
    });
    if (!res.ok) return null;
    const html = await res.text();
    const captionMatch = html.match(/class="Caption"[^>]*>([\s\S]*?)<\/div>/i);
    const caption = captionMatch
      ? captionMatch[1]
          .replace(/<br\s*\/?>/gi, '\n')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+\n/g, '\n')
          .replace(/[ \t]+/g, ' ')
          .trim()
      : '';
    const imgMatch =
      html.match(/class="EmbeddedMediaImage"[^>]+src="([^"]+)"/i) ||
      html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i);
    const thumbnail = imgMatch ? imgMatch[1].replace(/&amp;/g, '&') : '';
    const videoMatch = html.match(/"video_url":"((?:\\.|[^"\\])*)"/);
    let videoUrl = '';
    if (videoMatch?.[1]) {
      try {
        videoUrl = JSON.parse(`"${videoMatch[1]}"`);
      } catch {
        videoUrl = '';
      }
    }
    return { caption, thumbnail, videoUrl };
  } catch {
    return null;
  }
}

/**
 * 3-STAGE COST-OPTIMIZED VIDEO ANALYSIS PIPELINE:
 * Stage 0: URL Cache Hit -> 0 TL (0 tokens)
 * Stage 1: Caption-Only Lite (`gemini-2.5-flash-lite`) if full recipe is in description (~95% cheaper!)
 * Stage 2: Compressed Audio (`ffmpeg` 32kbps mono MP3 + `gemini-2.5-flash`) (~85% cheaper than video!)
 * Stage 3: Low-FPS Visual Video (`ffmpeg` 1fps 480p MP4 + `gemini-2.5-flash`) only if video has no narration!
 */
async function handleAnalyzeVideoUrl(req, res) {
  const uploadedFiles = [];
  const tmpDirs = [];

  try {
    if (!checkClientAuth(req)) {
      sendJson(res, 401, { ok: false, error: 'Yetkisiz istemci isteği.' });
      return;
    }

    const userId = String(req.headers['x-user-id'] || 'default-user').slice(0, 64);
    const body = await readJsonBody(req, 1024 * 1024);
    const rawUrl = String(body.url || '').trim();
    const forceRefresh = Boolean(body.forceRefresh);
    const normalizedUrl = /^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`;

    if (!isSafeExternalUrl(normalizedUrl)) {
      sendJson(res, 400, { ok: false, error: 'Geçerli bir video linki girin.' });
      return;
    }

    // STAGE 0: Cache lookup (0 TL!)
    if (!forceRefresh) {
      const cached = getCachedRecipe(normalizedUrl);
      if (cached) {
        const usage = recordUsage({
          userId,
          stage: 'cache_hit',
          model: 'none',
          freeStarterCredits: FREE_STARTER_CREDITS,
        });
        sendJson(res, 200, {
          ok: true,
          analysisMode: 'cache_hit',
          costNote: 'Önbellekten anında getirildi (0 TL maliyet).',
          draft: cached,
          usage,
        });
        return;
      }
    }

    // Check daily budget & pay-as-you-go credits
    const gate = checkBudgetAndCredits({
      userId,
      dailyBudgetUsd: DAILY_BUDGET_USD,
      requireCredits: REQUIRE_CREDITS,
      freeStarterCredits: FREE_STARTER_CREDITS,
    });
    if (!gate.allowed) {
      sendJson(res, gate.status, { ok: false, error: gate.error });
      return;
    }

    const [ytDlp, ffmpegReady] = await Promise.all([resolveYtDlpBinary(), hasFfmpegBinary()]);
    const isYouTube = /(?:youtube\.com|youtu\.be)/i.test(normalizedUrl);
    const isInstagram = /instagram\.com/i.test(normalizedUrl);

    // Gather lightweight metadata/caption first (zero download cost!)
    let meta = ytDlp ? await fetchMetadataOnlyWithYtDlp(ytDlp, normalizedUrl) : null;
    if (!meta && isInstagram) {
      const embed = await tryFetchInstagramEmbed(normalizedUrl);
      if (embed) {
        meta = {
          title: '',
          description: embed.caption || '',
          thumbnail: embed.thumbnail || '',
          videoUrl: embed.videoUrl || '',
        };
      }
    }

    // STAGE 1: If description already contains full ingredients + steps -> tiny text-only call!
    if (meta?.description && captionLooksLikeCompleteRecipe(meta.description)) {
      const { parsed, promptTokens, outputTokens, usedModel } = await analyzeWithAi({
        kind: 'text',
        prompt: `${RECIPE_JSON_PROMPT}\n\nAşağıdaki gönderi açıklamasından tarifi eksiksiz çıkar. Eğer açıklama yetersizse needsVisualAnalysis: true döndür.\n\nBaşlık: ${meta.title || ''}\nAçıklama:\n${meta.description.slice(0, 6000)}`,
      });

      if (!parsed.needsVisualAnalysis && Array.isArray(parsed.ingredients) && parsed.ingredients.length >= 2) {
        const draft = normalizeGeminiRecipe(parsed, {
          title: meta.title,
          imageUri: meta.thumbnail,
          sourceUrl: normalizedUrl,
        });
        setCachedRecipe(normalizedUrl, draft);
        const usage = recordUsage({
          userId,
          stage: 'caption_lite',
          model: usedModel || GEMINI_TEXT_MODEL,
          promptTokens,
          outputTokens,
          freeStarterCredits: FREE_STARTER_CREDITS,
        });
        sendJson(res, 200, {
          ok: true,
          analysisMode: 'caption_lite',
          costNote: 'Aşama 1 (Ekonomik Metin): Açıklamadan çözüldü (~%95 maliyet tasarrufu).',
          draft,
          usage,
        });
        return;
      }
    }

    // STAGE 2: Audio-First Compressed Analysis (Speech -> Recipe, ~85% cheaper than full video!)
    let downloadedVideoPath = null;
    let downloadedTmpDir = null;
    let title = meta?.title || '';
    let caption = meta?.description || '';
    let thumbnail = meta?.thumbnail || '';

    if (ytDlp) {
      try {
        const dl = await downloadMediaToTmp(ytDlp, normalizedUrl, false);
        downloadedTmpDir = dl.tmpDir;
        tmpDirs.push(dl.tmpDir);
        downloadedVideoPath = dl.filePath;
        title = title || dl.title;
        caption = caption || dl.description;
        thumbnail = thumbnail || dl.thumbnail;
      } catch (dlErr) {
        if (isInstagram && meta?.videoUrl) {
          const vidRes = await fetch(meta.videoUrl);
          if (vidRes.ok) {
            fs.mkdirSync(LOCAL_TMP_ROOT, { recursive: true });
            downloadedTmpDir = fs.mkdtempSync(path.join(LOCAL_TMP_ROOT, 'ig-'));
            tmpDirs.push(downloadedTmpDir);
            downloadedVideoPath = path.join(downloadedTmpDir, 'reel.mp4');
            fs.writeFileSync(downloadedVideoPath, Buffer.from(await vidRes.arrayBuffer()));
          }
        } else if (isYouTube) {
          // YouTube direct fallback if yt-dlp blocked by YouTube bot-check on cloud IP
          const { parsed, promptTokens, outputTokens, usedModel } = await analyzeWithAi({
            kind: 'youtube',
            youtubeUrl: normalizedUrl,
            prompt: `${RECIPE_JSON_PROMPT}\n\nYouTube videosunu izleyip dinleyerek tarifi çıkar.${
              title ? `\nBaşlık: ${title}` : ''
            }${caption ? `\nAçıklama:\n${caption.slice(0, 3000)}` : ''}`,
          });
          const draft = normalizeGeminiRecipe(parsed, {
            title,
            imageUri: thumbnail,
            sourceUrl: normalizedUrl,
          });
          setCachedRecipe(normalizedUrl, draft);
          const usage = recordUsage({
            userId,
            stage: 'youtube_direct',
            model: usedModel || GEMINI_MEDIA_MODEL,
            promptTokens,
            outputTokens,
            freeStarterCredits: FREE_STARTER_CREDITS,
          });
          sendJson(res, 200, {
            ok: true,
            analysisMode: 'youtube_direct',
            costNote: 'YouTube videosu doğrudan yapay zekâ ile analiz edildi.',
            draft,
            usage,
          });
          return;
        } else {
          throw new Error(
            isInstagram
              ? 'Instagram bu videoya giriş olmadan erişimi kısıtladı. Videoyu kaydedip "Dosya Yükle" sekmesinden gönderebilirsiniz.'
              : `Video indirilemedi: ${dlErr instanceof Error ? dlErr.message : 'Bilinmeyen hata'}`
          );
        }
      }
    }

    if (downloadedVideoPath && ffmpegReady && downloadedTmpDir) {
      // Try Stage 2: Extract tiny 32kbps mono MP3 speech first!
      try {
        const mp3Path = await compressToSpeechMp3(downloadedVideoPath, downloadedTmpDir);
        const mp3Buf = fs.readFileSync(mp3Path);
        if (mp3Buf.length > 2000) {
          const { parsed, promptTokens, outputTokens, usedModel } = await analyzeWithAi({
            kind: 'audio',
            buffer: mp3Buf,
            mimeType: 'audio/mpeg',
            fileName: 'speech.mp3',
            uploadedFiles,
            prompt: `${RECIPE_JSON_PROMPT}\n\nBu ses kaydındaki sözlü tarif anlatımını ve varsa aşağıdaki açıklamayı analiz et. Eğer ses sadece müzik/efekt ise ve tarif anlatılmıyorsa mutlaka "needsVisualAnalysis": true döndür.${
              title ? `\nBaşlık: ${title}` : ''
            }${caption ? `\nAçıklama:\n${caption.slice(0, 3000)}` : ''}`,
          });

          if (
            !parsed.needsVisualAnalysis &&
            Array.isArray(parsed.ingredients) &&
            parsed.ingredients.length >= 2 &&
            Array.isArray(parsed.steps) &&
            parsed.steps.length >= 2
          ) {
            const draft = normalizeGeminiRecipe(parsed, {
              title,
              imageUri: thumbnail,
              sourceUrl: normalizedUrl,
            });
            setCachedRecipe(normalizedUrl, draft);
            const usage = recordUsage({
              userId,
              stage: 'audio_compressed',
              model: usedModel || GEMINI_MEDIA_MODEL,
              promptTokens,
              outputTokens,
              freeStarterCredits: FREE_STARTER_CREDITS,
            });
            sendJson(res, 200, {
              ok: true,
              analysisMode: 'audio_compressed',
              costNote: 'Aşama 2 (Sıkıştırılmış Ses): Konuşmadan çözüldü (~%85 maliyet tasarrufu).',
              draft,
              usage,
            });
            return;
          }
        }
      } catch {
        // Proceed to Stage 3 visual video fallback
      }

      // STAGE 3: Low-FPS 480p Visual Video Analysis (for silent/text-overlay Reels & videos!)
      const compactPath = await compressToLowFpsVideo(downloadedVideoPath, downloadedTmpDir);
      const compactBuf = fs.readFileSync(compactPath);
      const { parsed, promptTokens, outputTokens, usedModel } = await analyzeWithAi({
        kind: 'video',
        buffer: compactBuf,
        mimeType: 'video/mp4',
        fileName: 'compact.mp4',
        uploadedFiles,
        prompt: `${RECIPE_JSON_PROMPT}\n\nVideodaki ekrana yazılan tüm malzemeleri, yapılan görsel adımları ve sesi birlikte analiz ederek eksiksiz tarifi çıkar.${
          title ? `\nBaşlık: ${title}` : ''
        }${caption ? `\nAçıklama:\n${caption.slice(0, 3000)}` : ''}`,
      });

      const draft = normalizeGeminiRecipe(parsed, {
        title,
        imageUri: thumbnail,
        sourceUrl: normalizedUrl,
      });
      setCachedRecipe(normalizedUrl, draft);
      const usage = recordUsage({
        userId,
        stage: 'video_visual',
        model: usedModel || GEMINI_MEDIA_MODEL,
        promptTokens,
        outputTokens,
        freeStarterCredits: FREE_STARTER_CREDITS,
      });
      sendJson(res, 200, {
        ok: true,
        analysisMode: 'video_visual',
        costNote: 'Aşama 3 (1 FPS 480p Görsel+Ses): Ekrandaki yazılar ve video birlikte çözüldü.',
        draft,
        usage,
      });
      return;
    }

    sendJson(res, 422, {
      ok: false,
      error: 'Video indirilemedi. Videoyu cihazınıza kaydedip "Dosya Yükle" sekmesinden gönderebilirsiniz.',
    });
  } catch (err) {
    sendJson(res, 500, {
      ok: false,
      error: err instanceof Error ? err.message : 'Video analizi sırasında hata oluştu.',
    });
  } finally {
    for (const dir of tmpDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    for (const fileName of uploadedFiles) {
      void deleteGeminiFile(fileName);
    }
  }
}

async function handleAnalyzeMedia(req, res) {
  const uploadedFiles = [];
  const tmpDirs = [];

  try {
    if (!checkClientAuth(req)) {
      sendJson(res, 401, { ok: false, error: 'Yetkisiz istemci isteği.' });
      return;
    }

    const userId = String(req.headers['x-user-id'] || 'default-user').slice(0, 64);
    const gate = checkBudgetAndCredits({
      userId,
      dailyBudgetUsd: DAILY_BUDGET_USD,
      requireCredits: REQUIRE_CREDITS,
      freeStarterCredits: FREE_STARTER_CREDITS,
    });
    if (!gate.allowed) {
      sendJson(res, gate.status, { ok: false, error: gate.error });
      return;
    }

    const body = await readJsonBody(req, 65 * 1024 * 1024);
    const base64 = String(body.base64 || '').trim();
    const mimeType = String(body.mimeType || 'video/mp4').trim();
    const fileName = String(body.fileName || 'tarif-medya').trim();

    if (!base64) {
      sendJson(res, 400, { ok: false, error: 'Yüklenecek video veya fotoğraf seçilmedi.' });
      return;
    }

    const cleanBase64 = base64.includes(',') ? base64.split(',')[1] : base64;
    const buffer = Buffer.from(cleanBase64, 'base64');

    if (mimeType.startsWith('image/') && buffer.length < 12 * 1024 * 1024) {
      const { parsed, promptTokens, outputTokens, usedModel } = await analyzeWithAi({
        kind: 'image',
        base64: cleanBase64,
        mimeType,
        prompt: `${RECIPE_JSON_PROMPT}\n\nBu fotoğraftaki/ekran görüntüsündeki tarifi analiz ederek eksiksiz Türkçe tarif JSON'u oluştur.`,
      });
      const draft = normalizeGeminiRecipe(parsed, {
        imageUri: `data:${mimeType};base64,${cleanBase64}`,
      });
      draft.sourceType = 'manual';
      const usage = recordUsage({
        userId,
        stage: 'image_ai',
        model: usedModel || GEMINI_MEDIA_MODEL,
        promptTokens,
        outputTokens,
        freeStarterCredits: FREE_STARTER_CREDITS,
      });
      sendJson(res, 200, {
        ok: true,
        analysisMode: 'image_ai',
        costNote: 'Fotoğraf/ekran görüntüsü analiz edildi.',
        draft,
        usage,
      });
      return;
    }

    // Uploaded video: apply same cost-saving compression with ffmpeg when available!
    const ffmpegReady = await hasFfmpegBinary();
    let finalBuf = buffer;
    let finalMime = mimeType;

    if (ffmpegReady && mimeType.startsWith('video/')) {
      fs.mkdirSync(LOCAL_TMP_ROOT, { recursive: true });
      const tmpDir = fs.mkdtempSync(path.join(LOCAL_TMP_ROOT, 'up-'));
      tmpDirs.push(tmpDir);
      const inPath = path.join(tmpDir, 'input.mp4');
      fs.writeFileSync(inPath, buffer);
      try {
        const compactPath = await compressToLowFpsVideo(inPath, tmpDir);
        finalBuf = fs.readFileSync(compactPath);
        finalMime = 'video/mp4';
      } catch {
        // Fallback to original buffer if compression fails
      }
    }

    const { parsed, promptTokens, outputTokens, usedModel } = await analyzeWithAi({
      kind: 'video',
      buffer: finalBuf,
      mimeType: finalMime,
      fileName,
      uploadedFiles,
      prompt: `${RECIPE_JSON_PROMPT}\n\nBu videodaki konuşmayı dinle, ekrandaki yazıları ve yapılan işlemleri izle, eksiksiz Türkçe tarifi JSON olarak çıkar.`,
    });

    const draft = normalizeGeminiRecipe(parsed);
    draft.sourceType = 'manual';
    const usage = recordUsage({
      userId,
      stage: 'uploaded_video_ai',
      model: usedModel || GEMINI_MEDIA_MODEL,
      promptTokens,
      outputTokens,
      freeStarterCredits: FREE_STARTER_CREDITS,
    });

    sendJson(res, 200, {
      ok: true,
      analysisMode: 'uploaded_video_ai',
      costNote: 'Video sıkıştırılarak ses + görsel birlikte analiz edildi.',
      draft,
      usage,
    });
  } catch (err) {
    sendJson(res, 500, {
      ok: false,
      error: err instanceof Error ? err.message : 'Medya analizi sırasında hata oluştu.',
    });
  } finally {
    for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
    for (const fileName of uploadedFiles) void deleteGeminiFile(fileName);
  }
}

async function handleFetchRecipe(req, res) {
  const parsedReq = new URL(req.url || '/', `http://127.0.0.1:${PORT}`);
  const target = parsedReq.searchParams.get('url')?.trim();

  if (!target || !isSafeExternalUrl(target)) {
    sendJson(res, 400, { ok: false, error: 'Geçerli bir http/https bağlantısı girin.' });
    return;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 14_000);

  try {
    const upstream = await fetch(target, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7',
      },
    });

    if (!upstream.ok) {
      sendJson(res, 502, {
        ok: false,
        error: `Hedef site yanıt vermedi (HTTP ${upstream.status}).`,
      });
      return;
    }

    const html = await upstream.text();
    const userId = String(req.headers['x-user-id'] || 'default-user').slice(0, 64);
    recordUsage({
      userId,
      stage: 'web_free',
      model: 'none',
      freeStarterCredits: FREE_STARTER_CREDITS,
    });

    sendJson(res, 200, {
      ok: true,
      finalUrl: upstream.url || target,
      html: html.slice(0, 1_500_000),
    });
  } catch (err) {
    const message =
      err && err.name === 'AbortError'
        ? 'Site yanıt süresi doldu (zaman aşımı).'
        : 'Bağlantıya ulaşılamadı. Site erişimi engelliyor olabilir.';
    sendJson(res, 502, { ok: false, error: message });
  } finally {
    clearTimeout(timeout);
  }
}

const server = http.createServer(async (req, res) => {
  const reqUrl = req.url || '/';

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, X-App-Token, X-User-Id',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    });
    res.end();
    return;
  }

  if (reqUrl.startsWith('/api/health')) {
    sendJson(res, 200, { ok: true, status: 'healthy', timestamp: new Date().toISOString() });
    return;
  }

  if (reqUrl.startsWith('/api/capabilities')) {
    const [ytDlp, ffmpeg] = await Promise.all([resolveYtDlpBinary(), hasFfmpegBinary()]);
    const userId = String(req.headers['x-user-id'] || 'default-user').slice(0, 64);
    const metrics = loadMetrics();
    const today = new Date().toISOString().slice(0, 10);
    const provider = getActiveProvider();
    sendJson(res, 200, {
      ok: true,
      serverConfigured: provider !== 'none',
      provider,
      hasYtDlp: Boolean(ytDlp),
      hasFfmpeg: ffmpeg,
      textModel: provider === 'openrouter' ? OPENROUTER_TEXT_MODEL : GEMINI_TEXT_MODEL,
      mediaModel: provider === 'openrouter' ? OPENROUTER_MEDIA_MODEL : GEMINI_MEDIA_MODEL,
      payAsYouGo: {
        requireCredits: REQUIRE_CREDITS,
        remainingCredits: getUserCredits(userId, FREE_STARTER_CREDITS),
        dailyBudgetUsd: DAILY_BUDGET_USD,
        todaySpentUsd: Number(metrics.dailyUsd?.[today] || 0),
        totalRequests: metrics.totalRequests || 0,
        byStage: metrics.byStage || {},
      },
    });
    return;
  }

  if (reqUrl.startsWith('/api/fetch-recipe')) {
    await handleFetchRecipe(req, res);
    return;
  }

  if (reqUrl.startsWith('/api/analyze-video-url') && req.method === 'POST') {
    await handleAnalyzeVideoUrl(req, res);
    return;
  }

  if (reqUrl.startsWith('/api/analyze-media') && req.method === 'POST') {
    await handleAnalyzeMedia(req, res);
    return;
  }

  // Optional static web UI serving if ../dist exists (useful for local web preview)
  if (fs.existsSync(DIST_DIR)) {
    const urlPath = reqUrl.split('?')[0];
    let safePath = path.normalize(decodeURIComponent(urlPath)).replace(/^(\.\.[/\\])+/, '');
    if (safePath === '/' || safePath === '\\') safePath = 'index.html';

    let filePath = path.join(DIST_DIR, safePath);
    if (!filePath.startsWith(DIST_DIR) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      filePath = path.join(DIST_DIR, 'index.html');
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    fs.readFile(filePath, (err, content) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Sunucu hatası');
        return;
      }
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content);
    });
    return;
  }

  sendJson(res, 200, {
    ok: true,
    service: 'Tarif Defterim Cloud API',
    endpoints: ['/api/health', '/api/capabilities', '/api/fetch-recipe', '/api/analyze-video-url', '/api/analyze-media'],
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Tarif Defterim Backend hazir: http://localhost:${PORT}`);
  const provider = getActiveProvider();
  console.log(
    `AI Saglayici: ${
      provider === 'openrouter'
        ? `OPENROUTER AKTIF (${OPENROUTER_MEDIA_MODEL})`
        : provider === 'gemini'
          ? `GEMINI DIRECT AKTIF (${GEMINI_MEDIA_MODEL})`
          : 'TANIMLI DEGIL (OPENROUTER_API_KEY veya GEMINI_API_KEY ekleyin)'
    }`
  );
  console.log(`Maliyet koruma gunluk limiti: $${DAILY_BUDGET_USD.toFixed(2)} | Kredi modu: ${REQUIRE_CREDITS}`);
});
