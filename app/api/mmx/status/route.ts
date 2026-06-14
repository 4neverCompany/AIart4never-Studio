/**
 * GET /api/mmx/status
 *
 * Detailed probe used by the AI Agent settings tab. Reports:
 *   - available:      mmx binary callable (mmx --version exits 0)
 *   - authenticated:  MMX_API_KEY / MINIMAX_API_KEY present in env (the
 *                     CLI itself reads the same vars, so presence is a
 *                     reasonable proxy for "auth is wired up")
 *   - version:        version string parsed from `mmx --version` stdout,
 *                     or empty when the binary isn't available
 *
 * Same auth model as the other /api/mmx routes — unauthenticated, intended
 * for the single-user desktop deployment.
 */

import { spawn } from 'node:child_process';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

const MMX_BIN = process.env.MMX_BIN ?? 'mmx';

interface VersionProbe {
  available: boolean;
  version: string;
}

function probeVersion(): Promise<VersionProbe> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: VersionProbe) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    let child;
    try {
      child = spawn(MMX_BIN, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      finish({ available: false, version: '' });
      return;
    }

    const stdoutChunks: Buffer[] = [];
    child.stdout?.on('data', (c: Buffer) => stdoutChunks.push(c));
    child.stderr?.on('data', () => { /* swallow — we only care about exit */ });

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish({ available: false, version: '' });
    }, 5000);

    child.once('error', () => {
      clearTimeout(timer);
      finish({ available: false, version: '' });
    });

    child.once('close', (code) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(stdoutChunks).toString('utf8').trim();
      finish({ available: code === 0, version: stdout });
    });
  });
}

export async function GET(): Promise<Response> {
  const { available, version } = await probeVersion();
  const authenticated = Boolean(
    process.env.MMX_API_KEY || process.env.MINIMAX_API_KEY,
  );
  return NextResponse.json(
    { available, authenticated, version },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
