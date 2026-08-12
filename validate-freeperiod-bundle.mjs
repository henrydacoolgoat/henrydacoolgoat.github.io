import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const projectDirectory = path.dirname(fileURLToPath(import.meta.url));
const source = await readFile(path.join(projectDirectory, 'index.html'), 'utf8');
const bundleMatch = source.match(/const FREE_PERIOD_HTML_BASE64='([A-Za-z0-9+/=]+)'/);

if (!bundleMatch) {
  throw new Error('Asteroid OS does not contain the FreePeriod base64 document.');
}

const encoded = bundleMatch[1];
const decodedBytes = Buffer.from(encoded, 'base64');
const html = decodedBytes.toString('utf8');
const roundTrip = decodedBytes.equals(Buffer.from(html, 'utf8'));
const title = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() || '';
const manifestMatch = html.match(/const FREE_PERIOD_GAME_NAMES = Object\.freeze\((\[[\s\S]*?\])\);/);
const gameNames = manifestMatch ? JSON.parse(manifestMatch[1]) : [];
const startupFunction = html.match(/async function initZipButtons\(\) \{([\s\S]*?)\n\}/)?.[1] || '';
const primeCoversFunction = html.match(/function primeFallbackGameCovers\(\) \{([\s\S]*?)\n\}/)?.[1] || '';
const coverDirectory = path.join(projectDirectory, 'freeperiod-covers');
const coverManifest = JSON.parse(await readFile(path.join(projectDirectory, 'freeperiod-cover-manifest.json'), 'utf8'));
const coverManifestEntries = Object.entries(coverManifest.games || {});
const publishedCoverEntries = coverManifestEntries.filter(([, entry]) => entry?.file);
const titleCardEntries = coverManifestEntries.filter(([, entry]) => entry?.type === 'freeperiod-title-card');
const expectedCoverFiles = publishedCoverEntries.map(([, entry]) => path.basename(entry.file));
const bundledCoverFiles = await readdir(coverDirectory).catch(() => []);
const coverResults = await Promise.all(expectedCoverFiles.map(async fileName => {
  try {
    const bytes = await readFile(path.join(coverDirectory, fileName));
    const jpeg = bytes.length > 900 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    const png = bytes.length > 900 && bytes.subarray(0, 8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]));
    const webp = bytes.length > 900 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
    return {
      fileName,
      bytes: bytes.length,
      validImage: jpeg || png || webp,
    };
  } catch {
    return { fileName, bytes: 0, validImage: false };
  }
}));
const missingCoverFiles = coverResults.filter(result => result.bytes === 0).map(result => result.fileName);
const invalidCoverFiles = coverResults.filter(result => result.bytes > 0 && !result.validImage).map(result => result.fileName);
const unexpectedCoverFiles = bundledCoverFiles.filter(fileName => !expectedCoverFiles.includes(fileName));
const embeddedCoverMap = Object.fromEntries(publishedCoverEntries.map(([game, entry]) => [game, entry.file]));
const scriptPattern = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
let executableScripts = 0;
let scriptNumber = 0;
let match;

while ((match = scriptPattern.exec(html))) {
  scriptNumber += 1;
  const attributes = match[1];
  const body = match[2];
  if (/\bsrc\s*=/i.test(attributes)) continue;
  const type = attributes.match(/\btype\s*=\s*["']([^"']+)["']/i)?.[1]?.toLowerCase() || '';
  if (type && !['text/javascript', 'application/javascript', 'module'].includes(type)) continue;
  if (type === 'module') {
    if (typeof vm.SourceTextModule !== 'function') {
      throw new Error('This Node runtime cannot validate FreePeriod module scripts.');
    }
    new vm.SourceTextModule(body, { identifier: `FreePeriod:script-${scriptNumber}` });
  } else {
    new vm.Script(body, { filename: `FreePeriod:script-${scriptNumber}` });
  }
  executableScripts += 1;
}

const localReferences = [];
const assetTagPattern = /<(?:script|img|link|iframe|source|audio|video)\b[^>]*>/gi;
while ((match = assetTagPattern.exec(html))) {
  const tag = match[0];
  const attributePattern = /\b(?:src|href)\s*=\s*["']([^"']+)["']/gi;
  let attributeMatch;
  while ((attributeMatch = attributePattern.exec(tag))) {
    const reference = attributeMatch[1].trim();
    if (!reference || /^(?:data:|https?:|mailto:|tel:|javascript:|about:|blob:|#)/i.test(reference)) continue;
    localReferences.push(reference);
  }
}

const cssUrlPattern = /\burl\(\s*["']?([^"')]+)["']?\s*\)/gi;
while ((match = cssUrlPattern.exec(html))) {
  const reference = match[1].trim();
  if (!reference || /[+{}$]/.test(reference)
      || /^(?:data:|https?:|mailto:|tel:|javascript:|about:|blob:|#)/i.test(reference)) continue;
  localReferences.push(reference);
}

const checks = [
  ['base64 bytes decode as lossless UTF-8', roundTrip],
  ['decoded FreePeriod document is substantial', decodedBytes.length > 100_000],
  ['decoded document starts with an HTML doctype', /^\s*<!doctype html>/i.test(html)],
  ['decoded document title is FreePeriod', title === 'FreePeriod'],
  ['decoded document contains the FreePeriod application', /\bFreePeriod\b/.test(html)],
  ['full FreePeriod manifest contains exactly 300 games', gameNames.length === 300],
  ['full FreePeriod manifest has 300 unique game names', new Set(gameNames).size === 300],
  ['all catalog entries are standalone HTML games', gameNames.every(name => /\.html?$/i.test(name))],
  ['catalog uses the maintained 300-game raw source', html.includes("const FREE_PERIOD_RAW_BASE = 'https://raw.githubusercontent.com/CoolDude2349/Offline-HTML-Games-Pack/master/offline/';")],
  ['startup renders the complete manifest without downloading ZIP packs', startupFunction.includes('loadBuiltInGameCatalog();') && !startupFunction.includes('loadZip(') && !startupFunction.includes('canvas.instructure.com')],
  ['catalog downloads only a selected game on demand', html.includes('const content = await freePeriodLoadGameContent(name, sourceUrls);') && !startupFunction.includes('freePeriodLoadGameContent(')],
  ['first launches race the raw source against a delayed CDN fallback', html.includes('FREE_PERIOD_SOURCE_RACE_DELAY_MS = 350') && html.includes('return await Promise.any(attempts)') && html.includes('controllers.forEach(controller => controller.abort())')],
  ['downloaded games persist in a revisioned local OPFS cache', html.includes("const FREE_PERIOD_GAME_CACHE_DIR = 'apps/freeperiod/runtime-cache';") && html.includes('freePeriodOPFS?.readBlob?.(freePeriodCachedGamePath(name))') && html.includes('freePeriodOPFS?.writeBlob?.(') && html.includes('encodeURIComponent(FREE_PERIOD_LIBRARY_REVISION)')],
  ['pointer, touch, and keyboard intent warm the selected game before its click', html.includes('pointerenter", warmGame') && html.includes('pointerdown", warmGame') && html.includes('touchstart", warmGame') && html.includes('focus", warmGame')],
  ['rejected six-game fallback is not bundled', !source.includes('freeperiod-games/') && !html.includes('FREE_PERIOD_STARTER_GAMES')],
  ['the cover manifest defines one non-screenshot presentation for every game', coverManifest.games_total === 300 && coverManifestEntries.length === 300 && gameNames.every(name => coverManifest.games[name])],
  ['the cover policy explicitly forbids runtime game screenshots', coverManifest.policy.includes('Never use screenshots captured from a running game') && html.includes('published-source-art-or-title-card-never-runtime-screenshots')],
  ['published art comes from traceable public GitHub assets', publishedCoverEntries.length >= 150 && publishedCoverEntries.every(([, entry]) => /^https:\/\/raw\.githubusercontent\.com\//.test(entry.source || ''))],
  ['games without published art use visible deterministic title cards', titleCardEntries.length > 0 && titleCardEntries.every(([, entry]) => entry.file === null && entry.source === null) && html.includes('applyFreePeriodTitleCover(btn, trimmedName)') && html.includes('data-cover-monogram')],
  ['FreePeriod embeds the exact published-art manifest', Object.entries(embeddedCoverMap).every(([game, file]) => html.includes(JSON.stringify(game) + ':' + JSON.stringify(file)))],
  ['FreePeriod applies published art and title cards before rendering the catalog', startupFunction.includes('primeFallbackGameCovers();') && !startupFunction.includes('restoreOriginalGameCovers();') && primeCoversFunction.includes('FREE_PERIOD_COVER_ASSETS[gameName]') && primeCoversFunction.includes('freePeriodTitleCoverKeys.add(key)')],
  ['all published cover filenames are unique', expectedCoverFiles.length === publishedCoverEntries.length && new Set(expectedCoverFiles).size === expectedCoverFiles.length],
  ['the bundled cover directory contains only the manifest art files', bundledCoverFiles.length === expectedCoverFiles.length && unexpectedCoverFiles.length === 0],
  ['every published cover file is bundled', missingCoverFiles.length === 0],
  ['every bundled cover is a nontrivial JPEG, PNG, or WebP image', invalidCoverFiles.length === 0],
  ['game frames request eager high-priority loading', html.includes('iframe.loading = "eager";') && html.includes('iframe.setAttribute("fetchpriority", "high")')],
  ['game frames receive fullscreen, audio, and gamepad permissions', html.includes('autoplay; fullscreen; gamepad') && html.includes('iframe.setAttribute("allowfullscreen", "")')],
  ['WebGL games request the high-performance GPU path without changing 2D contexts', html.includes('attributes.powerPreference="high-performance"') && html.includes('attributes.desynchronized=true') && html.includes('return originalGetContext.call(this,type,options);')],
  ['launched games expose the Asteroid high-performance marker', html.includes('window.__asteroidHighPerformanceGameMode=true') && html.includes('data-asteroid-performance')],
  ['FreePeriod exits fullscreen before returning to its catalog', /backButton\.onclick\s*=\s*async\s*\(\)\s*=>[\s\S]{0,420}doc\.exitFullscreen/.test(html)],
  ['Asteroid OS restores its dock and chrome after fullscreen exits', source.includes('restoreAsteroidChromeAfterFullscreen') && source.includes("document.addEventListener('fullscreenchange',handleAsteroidFullscreenChange)")],
  ['all inline executable scripts pass Node syntax validation', executableScripts > 0],
  ['FreePeriod has no missing local file dependencies', localReferences.length === 0],
  ['Asteroid OS exposes the FreePeriod decoder', source.includes('function getFreePeriodHTML()')],
  ['Asteroid OS mounts FreePeriod with iframe srcdoc', source.includes('frame.srcdoc=getFreePeriodHTML();')],
  ['Asteroid OS registers the FreePeriod application', /id:\s*['"]freeperiod['"]/i.test(source)],
];

const failures = checks.filter(([, passed]) => !passed).map(([name]) => name);
const report = {
  ok: failures.length === 0,
  title,
  encodedCharacters: encoded.length,
  decodedBytes: decodedBytes.length,
  executableScripts,
  manifestGames: gameNames.length,
  bundledCovers: bundledCoverFiles.length,
  titleCards: titleCardEntries.length,
  missingCoverFiles,
  invalidCoverFiles,
  unexpectedCoverFiles,
  localReferences,
  passed: checks.length - failures.length,
  total: checks.length,
  failures,
  checks: Object.fromEntries(checks),
};

console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exitCode = 1;
