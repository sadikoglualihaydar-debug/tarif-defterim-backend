import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { getCachedRecipe, setCachedRecipe } from './usageStore.mjs';
import {
  hasTesseractBinary,
  ocrImageBuffer,
  ocrVideoKeyframes,
  parseRecipeFromOcrText,
} from './ocrEngine.mjs';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PARENT_TOOLS_DIR = path.join(__dirname, '..', 'tools');
const LOCAL_TMP_ROOT =
  process.env.TMP_DIR ||
  (process.env.K_SERVICE ? '/tmp/tarif-defterim-tmp' : path.join(__dirname, '.tmp'));
const DIST_DIR = path.join(__dirname, '..', 'dist');

const PORT = Number(process.env.PORT) || 8081;

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

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-User-Id',
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
    };
  } catch {
    return null;
  }
}

async function downloadVideoToTmp(ytDlpBin, url) {
  fs.mkdirSync(LOCAL_TMP_ROOT, { recursive: true });
  const tmpDir = fs.mkdtempSync(path.join(LOCAL_TMP_ROOT, 'vid-'));
  const outTemplate = path.join(tmpDir, 'media.%(ext)s');

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
        'best[ext=mp4][height<=720][filesize<40M]/best[filesize<40M]/best',
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
      throw new Error('Video indirilemedi (gizli hesap veya boyut sınırı olabilir).');
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

async function handleAnalyzeVideoUrl(req, res) {
  const tmpDirs = [];

  try {
    const body = await readJsonBody(req, 1024 * 1024);
    const rawUrl = String(body.url || '').trim();
    const forceRefresh = Boolean(body.forceRefresh);
    const normalizedUrl = /^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`;

    if (!isSafeExternalUrl(normalizedUrl)) {
      sendJson(res, 400, { ok: false, error: 'Geçerli bir video linki girin.' });
      return;
    }

    if (!forceRefresh) {
      const cached = getCachedRecipe(normalizedUrl);
      if (cached) {
        sendJson(res, 200, { ok: true, draft: cached });
        return;
      }
    }

    const [ytDlp, ffmpegReady, tesseractReady] = await Promise.all([
      resolveYtDlpBinary(),
      hasFfmpegBinary(),
      hasTesseractBinary(),
    ]);
    const isInstagram = /instagram\.com/i.test(normalizedUrl);

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

    // 1) Try parsing description directly if it already looks like a recipe
    if (meta?.description && meta.description.length > 80) {
      const descParsed = parseRecipeFromOcrText(meta.description, {
        title: meta.title,
        imageUri: meta.thumbnail,
        sourceUrl: normalizedUrl,
      });
      if (descParsed._ocrQuality.ingredientCount >= 2 && descParsed._ocrQuality.stepCount >= 1) {
        const { _ocrQuality, ...draft } = descParsed;
        setCachedRecipe(normalizedUrl, draft);
        sendJson(res, 200, { ok: true, draft });
        return;
      }
    }

    // 2) Download video & run free Tesseract Turkish OCR on keyframes
    let downloadedVideoPath = null;
    let downloadedTmpDir = null;
    let title = meta?.title || '';
    let caption = meta?.description || '';
    let thumbnail = meta?.thumbnail || '';

    if (ytDlp) {
      try {
        const dl = await downloadVideoToTmp(ytDlp, normalizedUrl);
        downloadedTmpDir = dl.tmpDir;
        tmpDirs.push(dl.tmpDir);
        downloadedVideoPath = dl.filePath;
        title = title || dl.title;
        caption = caption || dl.description;
        thumbnail = thumbnail || dl.thumbnail;
      } catch {
        if (isInstagram && meta?.videoUrl) {
          const vidRes = await fetch(meta.videoUrl);
          if (vidRes.ok) {
            fs.mkdirSync(LOCAL_TMP_ROOT, { recursive: true });
            downloadedTmpDir = fs.mkdtempSync(path.join(LOCAL_TMP_ROOT, 'ig-'));
            tmpDirs.push(downloadedTmpDir);
            downloadedVideoPath = path.join(downloadedTmpDir, 'reel.mp4');
            fs.writeFileSync(downloadedVideoPath, Buffer.from(await vidRes.arrayBuffer()));
          }
        }
      }
    }

    if (downloadedVideoPath && ffmpegReady && tesseractReady && downloadedTmpDir) {
      const ocrRes = await ocrVideoKeyframes(downloadedVideoPath, downloadedTmpDir);
      const mergedText = [title, caption, ocrRes.text].filter(Boolean).join('\n\n');
      const ocrParsed = parseRecipeFromOcrText(mergedText, {
        title,
        imageUri: thumbnail,
        sourceUrl: normalizedUrl,
      });

      if (ocrParsed._ocrQuality.charCount >= 20) {
        const { _ocrQuality, ...draft } = ocrParsed;
        setCachedRecipe(normalizedUrl, draft);
        sendJson(res, 200, { ok: true, draft });
        return;
      }
    }

    // 3) Fallback: return partial description if available
    if (caption && caption.trim().length > 20) {
      const fallbackParsed = parseRecipeFromOcrText([title, caption].filter(Boolean).join('\n'), {
        title,
        imageUri: thumbnail,
        sourceUrl: normalizedUrl,
      });
      const { _ocrQuality, ...draft } = fallbackParsed;
      sendJson(res, 200, { ok: true, draft });
      return;
    }

    sendJson(res, 422, {
      ok: false,
      error:
        'Bu videodan yazılı tarif okunamadı. Videoyu indirip "Dosya Yükle" ile deneyebilir veya açıklamayı "Metin" sekmesine yapıştırabilirsiniz.',
    });
  } catch (err) {
    sendJson(res, 500, {
      ok: false,
      error: err instanceof Error ? err.message : 'Video okuma sırasında hata oluştu.',
    });
  } finally {
    for (const dir of tmpDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}

async function handleAnalyzeMedia(req, res) {
  const tmpDirs = [];

  try {
    const body = await readJsonBody(req, 65 * 1024 * 1024);
    const base64 = String(body.base64 || '').trim();
    const mimeType = String(body.mimeType || 'image/jpeg').trim();

    if (!base64) {
      sendJson(res, 400, { ok: false, error: 'Yüklenecek video veya fotoğraf seçilmedi.' });
      return;
    }

    const cleanBase64 = base64.includes(',') ? base64.split(',')[1] : base64;
    const buffer = Buffer.from(cleanBase64, 'base64');
    const [ffmpegReady, tesseractReady] = await Promise.all([
      hasFfmpegBinary(),
      hasTesseractBinary(),
    ]);

    if (!tesseractReady) {
      sendJson(res, 503, { ok: false, error: 'Sunucuda Tesseract OCR motoru hazır değil.' });
      return;
    }

    if (mimeType.startsWith('image/')) {
      fs.mkdirSync(LOCAL_TMP_ROOT, { recursive: true });
      const tmpDir = fs.mkdtempSync(path.join(LOCAL_TMP_ROOT, 'ocr-img-'));
      tmpDirs.push(tmpDir);
      const ext = mimeType.includes('png') ? '.png' : '.jpg';
      const ocrText = await ocrImageBuffer(buffer, tmpDir, ext);

      if (ocrText.trim().length < 15) {
        sendJson(res, 422, {
          ok: false,
          error: 'Fotoğrafta okunabilir tarif yazısı bulunamadı. Daha net bir görsel deneyin.',
        });
        return;
      }

      const ocrParsed = parseRecipeFromOcrText(ocrText, {
        imageUri: `data:${mimeType};base64,${cleanBase64}`,
      });
      const { _ocrQuality, ...draft } = ocrParsed;
      draft.sourceType = 'manual';
      sendJson(res, 200, { ok: true, draft });
      return;
    }

    if (ffmpegReady && mimeType.startsWith('video/')) {
      fs.mkdirSync(LOCAL_TMP_ROOT, { recursive: true });
      const tmpDir = fs.mkdtempSync(path.join(LOCAL_TMP_ROOT, 'ocr-vid-'));
      tmpDirs.push(tmpDir);
      const inPath = path.join(tmpDir, 'input.mp4');
      fs.writeFileSync(inPath, buffer);

      const ocrRes = await ocrVideoKeyframes(inPath, tmpDir);
      if (ocrRes.text.trim().length < 20) {
        sendJson(res, 422, {
          ok: false,
          error: 'Videodaki karelerde okunabilir yazı tespit edilemedi.',
        });
        return;
      }

      const ocrParsed = parseRecipeFromOcrText(ocrRes.text);
      const { _ocrQuality, ...draft } = ocrParsed;
      draft.sourceType = 'manual';
      sendJson(res, 200, { ok: true, draft });
      return;
    }

    sendJson(res, 400, { ok: false, error: 'Desteklenmeyen dosya formatı.' });
  } catch (err) {
    sendJson(res, 500, {
      ok: false,
      error: err instanceof Error ? err.message : 'OCR okuma sırasında hata oluştu.',
    });
  } finally {
    for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
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
      'Access-Control-Allow-Headers': 'Content-Type, X-User-Id',
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
    const [ytDlp, ffmpeg, tesseract] = await Promise.all([
      resolveYtDlpBinary(),
      hasFfmpegBinary(),
      hasTesseractBinary(),
    ]);
    sendJson(res, 200, {
      ok: true,
      hasYtDlp: Boolean(ytDlp),
      hasFfmpeg: ffmpeg,
      hasTesseract: tesseract,
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
    service: 'Tarif Defterim Free OCR & Web API',
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Tarif Defterim Free OCR Backend hazir: http://localhost:${PORT}`);
});
