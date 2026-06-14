import { NextRequest, NextResponse } from 'next/server';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { getDesktopConfigPath } from '@/lib/desktop-env';
import { getErrorMessage } from '@/lib/errors';
import { DESKTOP_CONFIG_KEYS } from '@/lib/desktop-config-keys';

export const runtime = 'nodejs';

// Re-export so callers that previously imported from here still work.
export { DESKTOP_CONFIG_KEYS };
export type { DesktopConfigKey } from '@/lib/desktop-config-keys';

// Desktop guard — reject on serverless platforms (Vercel, Lambda, etc.)
function isServerless(): boolean {
  return Boolean(
    process.env.VERCEL ||
    process.env.AWS_LAMBDA_FUNCTION_NAME ||
    process.env.NETLIFY ||
    process.env.CF_PAGES
  );
}

// ── GET /api/desktop/config ───────────────────────────────────────────────────

export async function GET() {
  if (isServerless()) {
    return NextResponse.json({ isDesktop: false, configPath: '', keys: {} });
  }

  const configPath = getDesktopConfigPath();
  let keys: Record<string, string> = {};

  if (existsSync(configPath)) {
    try {
      const raw = readFileSync(configPath, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
          if (typeof v === 'string') keys[k] = v;
        }
      }
    } catch (e: unknown) {
      return NextResponse.json(
        { isDesktop: true, configPath, keys: {}, error: getErrorMessage(e) },
        { status: 500 }
      );
    }
  }

  // MUSTFIX-002: FEAT-006 replaced AUTO_UPDATE_ON_LAUNCH ('on'/'off') with
  // UPDATE_BEHAVIOR ('auto'/'notify'/'off'). Users who opted out on v0.2.1
  // had AUTO_UPDATE_ON_LAUNCH='off' in config.json; without this migration
  // they'd silently regress to the default 'notify' and start seeing
  // banners. Carry the opt-out forward. On-disk file is not rewritten —
  // PATCH-time writes will persist UPDATE_BEHAVIOR; the legacy key
  // becomes dead data once the user touches any setting.
  if (keys.UPDATE_BEHAVIOR === undefined && keys.AUTO_UPDATE_ON_LAUNCH === 'off') {
    keys.UPDATE_BEHAVIOR = 'off';
  }

  return NextResponse.json({ isDesktop: true, configPath, keys });
}

// ── PATCH /api/desktop/config ─────────────────────────────────────────────────

export async function PATCH(req: NextRequest) {
  if (isServerless()) {
    return NextResponse.json(
      { success: false, error: 'Desktop config write is not available on serverless platforms.' },
      { status: 503 }
    );
  }

  let body: { keys?: Record<string, unknown> };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid JSON body.' }, { status: 400 });
  }

  if (!body.keys || typeof body.keys !== 'object' || Array.isArray(body.keys)) {
    return NextResponse.json(
      { success: false, error: 'Body must be { keys: Record<string, string> }.' },
      { status: 400 }
    );
  }

  const configPath = getDesktopConfigPath();

  // Load existing config so we preserve any keys we're not overwriting.
  let existing: Record<string, string> = {};
  if (existsSync(configPath)) {
    try {
      const raw = readFileSync(configPath, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
          if (typeof v === 'string') existing[k] = v;
        }
      }
    } catch {
      // Corrupt config — treat as empty; we'll overwrite below.
    }
  }

  // Only accept keys declared in DESKTOP_CONFIG_KEYS — prevents arbitrary
  // env-var injection via the PATCH body (e.g. NODE_OPTIONS, LD_PRELOAD).
  const allowedKeys = new Set(DESKTOP_CONFIG_KEYS.map(({ key }) => key));

  // Merge: empty-string values remove the key; non-empty values upsert.
  for (const [k, v] of Object.entries(body.keys)) {
    if (!allowedKeys.has(k)) continue;
    if (typeof v === 'string' && v.trim().length > 0) {
      existing[k] = v.trim();
      // Also inject immediately so running API routes pick it up without restart.
      process.env[k] = v.trim();
    } else if (v === '' || v === null) {
      delete existing[k];
      delete process.env[k];
    }
  }

  try {
    mkdirSync(dirname(configPath), { recursive: true });
    // 0o600: owner read/write only — config.json contains API keys.
    writeFileSync(configPath, JSON.stringify(existing, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  } catch (e: unknown) {
    return NextResponse.json(
      { success: false, error: getErrorMessage(e) },
      { status: 500 }
    );
  }

  return NextResponse.json({ success: true, configPath, savedKeys: Object.keys(existing) });
}
