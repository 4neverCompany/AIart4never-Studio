#!/usr/bin/env node
// Fails the build if any route's first-load JS exceeds the budget.
import {readFileSync, readdirSync} from 'node:fs';
import {join, relative} from 'node:path';
import {gzipSync} from 'node:zlib';

const BUDGET_KB = 300;
const BUDGET_BYTES = BUDGET_KB * 1024;
const NEXT_DIR = join(process.cwd(), '.next');
const APP_DIR = join(NEXT_DIR, 'server', 'app');

const sizeCache = new Map();

function gzipSizeOf(relPath) {
  if (sizeCache.has(relPath)) return sizeCache.get(relPath);
  try {
    const size = gzipSync(readFileSync(join(NEXT_DIR, relPath))).length;
    sizeCache.set(relPath, size);
    return size;
  } catch {
    sizeCache.set(relPath, 0);
    return 0;
  }
}

function loadJSON(name) {
  try {
    return JSON.parse(readFileSync(join(NEXT_DIR, name), 'utf8'));
  } catch {
    return null;
  }
}

function findHtmlFiles(dir, files = []) {
  for (const entry of readdirSync(dir, {withFileTypes: true})) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) findHtmlFiles(full, files);
    else if (entry.name.endsWith('.html')) files.push(full);
  }
  return files;
}

function routeFromHtml(htmlPath) {
  let route = '/' + relative(APP_DIR, htmlPath).replace(/\.html$/, '');
  if (route.endsWith('/index')) route = route.slice(0, -'/index'.length) || '/';
  if (route === '/index') route = '/';
  return route;
}

// Polyfills are loaded with noModule — exclude from first-load count
const buildManifest = loadJSON('build-manifest.json');
const polyfills = new Set(buildManifest?.polyfillFiles ?? []);

function extractChunks(htmlPath) {
  const html = readFileSync(htmlPath, 'utf8');
  const chunks = new Set();
  for (const m of html.matchAll(/(?:static\/[^"']*?\.js)/g)) {
    if (!polyfills.has(m[0])) chunks.add(m[0]);
  }
  return [...chunks];
}

let htmlFiles;
try {
  htmlFiles = findHtmlFiles(APP_DIR);
} catch {
  console.error('No .next/server/app/ directory — run next build first.');
  process.exit(1);
}

if (!htmlFiles.length) {
  console.log('No prerendered pages found — nothing to check.');
  process.exit(0);
}

const violations = [];

console.log(`\nBundle-size budget: ${BUDGET_KB} KB gzipped first-load JS\n`);
console.log('Route'.padEnd(44) + 'First Load JS');
console.log('-'.repeat(60));

for (const htmlFile of htmlFiles) {
  const route = routeFromHtml(htmlFile);
  if (route.startsWith('/_')) continue;

  const chunks = extractChunks(htmlFile);
  const firstLoad = chunks.reduce((s, c) => s + gzipSizeOf(c), 0);
  const kb = firstLoad / 1024;
  const marker = firstLoad > BUDGET_BYTES ? ' OVER' : '';
  console.log(`${route.padEnd(44)} ${kb.toFixed(1)} KB${marker}`);
  if (firstLoad > BUDGET_BYTES) violations.push({route, kb});
}

console.log('');

if (violations.length) {
  console.error(`FAIL: ${violations.length} route(s) over ${BUDGET_KB} KB budget:\n`);
  for (const v of violations) console.error(`  ${v.route}: ${v.kb.toFixed(1)} KB`);
  console.error('');
  process.exit(1);
}

console.log(`PASS: all routes within ${BUDGET_KB} KB budget\n`);
