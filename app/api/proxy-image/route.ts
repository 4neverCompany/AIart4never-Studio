import { NextResponse } from 'next/server';

// SSRF guard: only proxy images from hosts we actually use.
// cdn.leonardo.ai           — Leonardo image CDN
// *.storage.googleapis.com  — Leonardo's underlying GCS bucket
// i.uguu.se                 — uguu image host (used by Pinterest upload path)
// *.aliyuncs.com             — MiniMax `image_generation` signed URLs
const ALLOWED_HOSTS = new Set<string>(['cdn.leonardo.ai', 'i.uguu.se']);
const ALLOWED_HOST_SUFFIXES = ['.storage.googleapis.com', '.aliyuncs.com'];

// Hosts that may also be fetched over plain HTTP (in addition to
// HTTPS). MiniMax's image_generation endpoint returns Aliyun OSS
// signed URLs whose signature is scheme-locked to http; the same URL
// over https returns 403. Browsers won't load http content from an
// https page (mixed-content), so the only way to surface MiniMax
// images in the production UI is to proxy them server-side, fetching
// over http and re-serving the bytes over the page's https origin.
// Keep this list as narrow as possible — every entry weakens
// transport security for that specific host.
const HTTP_ALLOWED_HOST_SUFFIXES = ['.aliyuncs.com'];

// In-memory LRU image cache — avoids re-fetching the same Leonardo CDN URLs
// during parallel pipeline runs. Entries are FRESH for FRESH_TTL_MS; past that
// they are still kept up to MAX_STALE_MS so the GET handler can fall back to
// a stale buffer when the upstream CDN URL has expired (Leonardo signed URLs
// rotate). Map is capped at MAX_ENTRIES, oldest-inserted evicted first.
const MAX_ENTRIES = 100;
const FRESH_TTL_MS = 60 * 60 * 1000; // 1 hour: served as fresh
const MAX_STALE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days: served as stale-while-error
const MAX_ENTRY_BYTES = 10 * 1024 * 1024; // 10 MB — skip caching huge images

interface CacheEntry {
  buffer: ArrayBuffer;
  contentType: string;
  cachedAt: number;
}

const imageCache = new Map<string, CacheEntry>();

function evictUnusable(): void {
  const now = Date.now();
  for (const [key, entry] of imageCache) {
    if (now - entry.cachedAt >= MAX_STALE_MS) imageCache.delete(key);
  }
}

function evictOldest(): void {
  const firstKey = imageCache.keys().next().value;
  if (firstKey !== undefined) imageCache.delete(firstKey);
}

export function getCacheEntry(url: string): CacheEntry | undefined {
  const entry = imageCache.get(url);
  if (!entry) return undefined;
  if (Date.now() - entry.cachedAt >= FRESH_TTL_MS) return undefined;
  return entry;
}

export function getStaleEntry(url: string): CacheEntry | undefined {
  const entry = imageCache.get(url);
  if (!entry) return undefined;
  if (Date.now() - entry.cachedAt >= MAX_STALE_MS) {
    imageCache.delete(url);
    return undefined;
  }
  return entry;
}

export function setCacheEntry(url: string, buffer: ArrayBuffer, contentType: string): void {
  if (buffer.byteLength > MAX_ENTRY_BYTES) return;
  evictUnusable();
  if (imageCache.size >= MAX_ENTRIES) evictOldest();
  imageCache.set(url, { buffer, contentType, cachedAt: Date.now() });
}

export function clearCache(): void {
  imageCache.clear();
}

export function getCacheSize(): number {
  return imageCache.size;
}

export function isAllowedUrl(raw: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  if (parsed.protocol === 'https:') {
    if (ALLOWED_HOSTS.has(host)) return true;
    return ALLOWED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
  }
  if (parsed.protocol === 'http:') {
    return HTTP_ALLOWED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
  }
  return false;
}

const SAFE_IMAGE_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif',
]);

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const url = searchParams.get('url');

  if (!url) {
    return new NextResponse('Missing url parameter', { status: 400 });
  }

  if (!isAllowedUrl(url)) {
    return new NextResponse('URL host not allowed', { status: 403 });
  }

  const cached = getCacheEntry(url);
  if (cached) {
    return new NextResponse(cached.buffer, {
      headers: {
        'Content-Type': cached.contentType,
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=86400, immutable',
        'X-Cache': 'HIT',
      },
    });
  }

  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(15000) });

    if (!response.ok) {
      const stale = getStaleEntry(url);
      if (stale) {
        return new NextResponse(stale.buffer, {
          headers: {
            'Content-Type': stale.contentType,
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'public, max-age=86400, immutable',
            'X-Cache': 'STALE',
          },
        });
      }
      return new NextResponse(`Failed to fetch image: ${response.statusText}`, { status: response.status });
    }

    const buffer = await response.arrayBuffer();
    const upstreamType = response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() ?? '';
    const contentType = SAFE_IMAGE_TYPES.has(upstreamType) ? upstreamType : 'application/octet-stream';

    setCacheEntry(url, buffer, contentType);

    return new NextResponse(buffer, {
      headers: {
        'Content-Type': contentType,
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=86400, immutable',
        'X-Cache': 'MISS',
      },
    });
  } catch (e: unknown) {
    const stale = getStaleEntry(url);
    if (stale) {
      return new NextResponse(stale.buffer, {
        headers: {
          'Content-Type': stale.contentType,
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'public, max-age=86400, immutable',
          'X-Cache': 'STALE',
        },
      });
    }
    return new NextResponse('Error fetching image', { status: 500 });
  }
}
