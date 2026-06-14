import { NextRequest, NextResponse } from 'next/server';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

// Force Node runtime — fs/promises not available in edge.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/crash
 * Desktop-only endpoint (returns 404 in web mode). Receives unhandled
 * React errors from global-error.tsx and writes them to the crash dir
 * alongside the Rust and Node crash logs.
 *
 * Body: { source: string; message: string; stack?: string; url?: string }
 */
export async function POST(req: NextRequest) {
  // Only active in the Tauri sidecar where MASHUPFORGE_DESKTOP=1 and
  // MASHUPFORGE_CRASH_DIR are both set by the Rust launcher.
  if (process.env.MASHUPFORGE_DESKTOP !== '1') {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const crashDir = process.env.MASHUPFORGE_CRASH_DIR;
  if (!crashDir) {
    return NextResponse.json({ error: 'Crash dir not configured' }, { status: 500 });
  }

  let body: { source?: string; message?: string; stack?: string; url?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const ts = Date.now();
  const lines = [
    'MashupForge webview crash report',
    `source: ${body.source ?? 'unknown'}`,
    `timestamp: ${new Date(ts).toISOString()}`,
    body.url ? `url: ${body.url}` : null,
    '---',
    body.message ?? '(no message)',
    body.stack ? `\n${body.stack}` : null,
  ].filter(Boolean).join('\n');

  try {
    await mkdir(crashDir, { recursive: true });
    await writeFile(join(crashDir, `crash-webview-${ts}.log`), lines, 'utf8');
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
