import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const INGREDIENT_HEADERS = [
  /^malzemeler\s*:?$/i,
  /^içindekiler\s*:?$/i,
  /^gerekli\s+malzemeler\s*:?$/i,
  /^ingredients\s*:?$/i,
  /^sosu?\s+için\s*:?$/i,
  /^hamuru?\s+için\s*:?$/i,
  /^üzeri\s+için\s*:?$/i,
  /^kreması\s+için\s*:?$/i,
];

const STEP_HEADERS = [
  /^yapılışı\s*:?$/i,
  /^hazırlanışı\s*:?$/i,
  /^hazırlama\s*:?$/i,
  /^nasıl\s+yapılır\s*\??:?$/i,
  /^tarif(in\s+yapılışı)?\s*:?$/i,
  /^adımlar\s*:?$/i,
  /^instructions?\s*:?$/i,
  /^directions?\s*:?$/i,
  /^method\s*:?$/i,
  /^steps?\s*:?$/i,
];

const NOTE_HEADERS = [/^notlar?\s*:?$/i, /^püf\s+noktas[ıi]\s*:?$/i, /^ipucu\s*:?$/i, /^notes?\s*:?$/i];

export async function hasTesseractBinary() {
  try {
    await execFileAsync('tesseract', ['--version'], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

async function runTesseractOnFile(imagePath) {
  // Try Turkish + English first, fall back to English if tur data missing locally
  try {
    const { stdout } = await execFileAsync(
      'tesseract',
      [imagePath, 'stdout', '-l', 'tur+eng', '--oem', '1', '--psm', '6'],
      { timeout: 25_000, maxBuffer: 4 * 1024 * 1024 }
    );
    return stdout || '';
  } catch {
    const { stdout } = await execFileAsync(
      'tesseract',
      [imagePath, 'stdout', '-l', 'eng', '--oem', '1', '--psm', '6'],
      { timeout: 25_000, maxBuffer: 4 * 1024 * 1024 }
    );
    return stdout || '';
  }
}

function cleanOcrLines(rawText) {
  return String(rawText || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[|_=~`^]{2,}/g, ' ').replace(/\s+/g, ' ').trim())
    .filter((line) => {
      if (line.length < 3) return false;
      // Drop pure noise/symbols with fewer than 2 letters
      const letters = (line.match(/[a-zA-ZçğıöşüÇĞİÖŞÜ]/g) || []).length;
      return letters >= 2;
    });
}

function normalizeForDedup(line) {
  return line
    .toLocaleLowerCase('tr-TR')
    .replace(/[^a-zçğıöşü0-9]+/g, ' ')
    .trim();
}

export async function ocrImageBuffer(buffer, tmpDir, ext = '.png') {
  const rawPath = path.join(tmpDir, `ocr_input${ext}`);
  fs.writeFileSync(rawPath, buffer);

  // Enhance contrast/grayscale with ffmpeg when available for cleaner OCR on photos
  let targetPath = rawPath;
  try {
    const prepPath = path.join(tmpDir, 'ocr_prep.png');
    await execFileAsync(
      'ffmpeg',
      ['-y', '-i', rawPath, '-vf', "scale='min(1600,iw)':-2,format=gray,eq=contrast=1.25", prepPath],
      { timeout: 20_000 }
    );
    if (fs.existsSync(prepPath)) targetPath = prepPath;
  } catch {
    // Use original image if ffmpeg preprocessing fails
  }

  const rawText = await runTesseractOnFile(targetPath);
  const lines = cleanOcrLines(rawText);
  return lines.join('\n');
}

/**
 * Extracts up to 18 evenly-spaced frames from a video and runs sequential Tesseract OCR
 * (low RAM usage: safe inside 512MB containers) to capture all on-screen recipe text.
 */
export async function ocrVideoKeyframes(videoPath, tmpDir) {
  const framesDir = path.join(tmpDir, 'frames');
  fs.mkdirSync(framesDir, { recursive: true });
  const pattern = path.join(framesDir, 'frame_%03d.png');

  // Extract 1 frame every 2.5 seconds (0.4 fps), max 18 frames, grayscale + contrast boost
  await execFileAsync(
    'ffmpeg',
    [
      '-y',
      '-i',
      videoPath,
      '-vf',
      "fps=0.4,scale='min(960,iw)':-2,format=gray,eq=contrast=1.3",
      '-frames:v',
      '18',
      pattern,
    ],
    { timeout: 60_000 }
  );

  const frameFiles = fs
    .readdirSync(framesDir)
    .filter((f) => f.endsWith('.png'))
    .sort();

  const seen = new Set();
  const collected = [];

  for (const file of frameFiles) {
    const full = path.join(framesDir, file);
    try {
      const text = await runTesseractOnFile(full);
      for (const line of cleanOcrLines(text)) {
        const key = normalizeForDedup(line);
        if (key.length < 4 || seen.has(key)) continue;
        // Skip near-duplicate substrings already captured from previous frames
        let isDup = false;
        for (const existing of seen) {
          if (existing.includes(key) || (key.includes(existing) && existing.length > 10)) {
            isDup = true;
            break;
          }
        }
        if (!isDup) {
          seen.add(key);
          collected.push(line);
        }
      }
    } catch {
      // Skip individual frame OCR error
    }
  }

  return {
    frameCount: frameFiles.length,
    text: collected.join('\n'),
  };
}

function inferCategory(text) {
  const lower = String(text || '').toLocaleLowerCase('tr-TR');
  const hasWord = (pattern) =>
    new RegExp(`(^|[^a-zçğıöşü])(${pattern})($|[^a-zçğıöşü])`, 'i').test(lower);

  if (hasWord('çorba|çorbası|soup|yayla|ezogelin|tarhana')) return 'Çorba';
  if (
    hasWord(
      'tatlı|tatlısı|kek|keki|pasta|pastası|kurabiye|kurabiyesi|sütlaç|baklava|brownie|tiramisu|muhallebi|cheesecake|dessert|cake|cookie'
    ) &&
    !/tatlı\s+(toz\s+)?biber/i.test(lower)
  )
    return 'Tatlı';
  if (hasWord('kahvaltı|kahvaltılık|omlet|menemen|pankek|krep|mıhlama|kuymak|breakfast|pancake'))
    return 'Kahvaltı';
  if (hasWord('salata|salatası|meze|cacık|humus|haydari|kısır|tarator|salad'))
    return 'Salata & Meze';
  if (hasWord('börek|böreği|poğaça|açma|simit|pide|lahmacun|pizza|ekmek|mantı|gözleme'))
    return 'Hamur İşi';
  if (
    hasWord('limonata|smoothie|kahve|şerbet|milkshake|kokteyl|latte|drink|juice') ||
    (hasWord('çay|çayı') && !/çay\s+(kaşığı|bardağı)/i.test(lower))
  )
    return 'İçecek';
  if (hasWord('atıştırmalık|sandviç|tost|granola|kraker|cips|snack')) return 'Atıştırmalık';
  if (
    hasWord(
      'tavuk|köfte|balık|makarna|pilav|kebap|güveç|tencere|fırında|karnıyarık|musakka|mantar|yemek'
    )
  )
    return 'Ana Yemek';
  return 'Diğer';
}

function extractMinutes(text) {
  const h = text.match(/(\d+)\s*(saat|sa|hour|hr|h)\b/i);
  const m = text.match(/(\d+)\s*(dakika|dk\.?|min|minute|m)\b/i);
  return (h ? parseInt(h[1], 10) : 0) * 60 + (m ? parseInt(m[1], 10) : 0);
}

/**
 * Pure 0-TL offline/server-side Turkish+English recipe parser for OCR output.
 */
export function parseRecipeFromOcrText(rawText, meta = {}) {
  const lines = cleanOcrLines(rawText);
  let title = meta.title ? String(meta.title).trim() : '';
  let description = '';
  let prepMinutes = 15;
  let cookMinutes = 25;
  let servings = 4;
  const ingredients = [];
  const steps = [];
  const notes = [];

  let section = 'header';

  for (const line of lines) {
    const cleanHeader = line.replace(/^[\*#_•\-\s]+|[\*#_\s]+$/g, '').trim();

    if (INGREDIENT_HEADERS.some((re) => re.test(cleanHeader))) {
      section = 'ingredients';
      continue;
    }
    if (STEP_HEADERS.some((re) => re.test(cleanHeader))) {
      section = 'steps';
      continue;
    }
    if (NOTE_HEADERS.some((re) => re.test(cleanHeader))) {
      section = 'notes';
      continue;
    }

    if (section === 'header') {
      const sm = line.match(/(\d+)\s*(kişilik|porsiyon|kişi|servings?)/i);
      if (sm && line.length < 75) servings = Math.max(1, parseInt(sm[1], 10));

      if (/(hazırlama|prep)/i.test(line) && line.length < 95) {
        const seg = line.match(/(?:hazırlama|prep)[^|•,]*/i)?.[0] ?? line;
        const m = extractMinutes(seg);
        if (m > 0) prepMinutes = m;
      }
      if (/(pişirme|cook)/i.test(line) && line.length < 95) {
        const seg = line.match(/(?:pişirme|cook)[^|•,]*/i)?.[0] ?? line;
        const m = extractMinutes(seg);
        if (m > 0) cookMinutes = m;
      }

      if (
        /^[-•*▪▫]\s+/.test(line) ||
        /^\d+([.,/]\d+)?\s*(su bardağı|çay bardağı|yemek kaşığı|çay kaşığı|tatlı kaşığı|gram|gr|kg|ml|lt|litre|adet|diş|demet|tutam|paket|cup|tbsp|tsp|g|oz)\b/i.test(
          line
        )
      ) {
        section = 'ingredients';
        ingredients.push(line.replace(/^[-•*▪▫]\s*/, '').trim());
        continue;
      }

      if (/^\d+[.)]\s+/.test(line)) {
        section = 'steps';
        steps.push(line.replace(/^\d+[.)]\s*/, '').trim());
        continue;
      }

      if (!title && line.length >= 4 && line.length <= 90) {
        title = cleanHeader;
        continue;
      }

      if (line.length > 15 && !description) {
        description = line.slice(0, 220);
      }
      continue;
    }

    if (section === 'ingredients') {
      if (/^\d+[.)]\s+/.test(line) && line.length > 35) {
        section = 'steps';
        steps.push(line.replace(/^\d+[.)]\s*/, '').trim());
        continue;
      }
      const cleaned = line.replace(/^[-•*▪▫✔✓]\s*/, '').trim();
      if (cleaned) ingredients.push(cleaned);
      continue;
    }

    if (section === 'steps') {
      const cleaned = line.replace(/^(\d+[.)]\s*|[-•*▪▫]\s*|adım\s*\d+\s*[:.-]?\s*)/i, '').trim();
      if (cleaned) steps.push(cleaned);
      continue;
    }

    if (section === 'notes') {
      notes.push(line.replace(/^[-•*]\s*/, '').trim());
    }
  }

  // Fallback classification if no explicit headers were detected in OCR text
  if (ingredients.length === 0 && steps.length === 0 && lines.length > 0) {
    for (const line of lines) {
      if (line === title) continue;
      const looksLikeIngredient =
        line.length <= 65 &&
        /\d|bardak|kaşık|kaşığı|gram|gr\b|kg\b|ml\b|adet|diş|tutam|paket|tuz|yağ|un\b|şeker|süt|soğan|biber|sarımsak|tereyağı|peynir/i.test(
          line
        );
      if (looksLikeIngredient) {
        ingredients.push(line.replace(/^[-•*]\s*/, ''));
      } else if (line.length > 18) {
        steps.push(line.replace(/^\d+[.)]\s*/, ''));
      }
    }
  }

  const titleCat = inferCategory(`${title} ${description}`);
  const category = titleCat !== 'Diğer' ? titleCat : inferCategory(ingredients.join(' '));

  return {
    title: title || 'OCR Tarifi',
    description,
    category,
    imageUri: meta.imageUri || undefined,
    prepMinutes,
    cookMinutes,
    servings,
    ingredients: ingredients.length > 0 ? ingredients : ['OCR metni yetersiz — malzemeleri kontrol edin'],
    steps: steps.length > 0 ? steps : ['OCR adımları yetersiz — yapılışı kontrol edin'],
    notes: notes.join('\n'),
    sourceUrl: meta.sourceUrl || undefined,
    sourceType: meta.sourceUrl ? 'url' : 'manual',
    _ocrQuality: {
      ingredientCount: ingredients.length,
      stepCount: steps.length,
      charCount: rawText.trim().length,
    },
  };
}
