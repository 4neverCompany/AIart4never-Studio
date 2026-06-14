'use client';

import { useEffect } from 'react';

/**
 * Next.js global error boundary (app/global-error.tsx).
 * Catches unhandled React errors that bubble past all nested boundaries.
 * In desktop mode, POSTs the error to /api/crash so it lands in the
 * local crash log alongside Rust and Node crash reports.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Fire-and-forget — best-effort crash report. Never blocks the UI.
    const body = {
      source: 'react-global-error',
      message: error?.message ?? String(error),
      stack: error?.stack,
      url: typeof window !== 'undefined' ? window.location.href : undefined,
    };
    fetch('/api/crash', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).catch(() => {/* non-blocking */});
  }, [error]);

  return (
    <html lang="en">
      <body className="bg-zinc-950 text-white flex items-center justify-center min-h-screen p-8">
        <div className="max-w-md text-center space-y-4">
          <h1 className="text-2xl font-bold text-red-400">Something went wrong</h1>
          <p className="text-zinc-400 text-sm">
            An unexpected error occurred. If this keeps happening, check the crash
            logs in your MashupForge app data folder.
          </p>
          {error?.message && (
            <pre className="text-xs text-zinc-500 bg-zinc-900 rounded-lg p-3 text-left overflow-auto max-h-40">
              {error.message}
            </pre>
          )}
          <button
            onClick={reset}
            className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 rounded-lg text-sm transition-colors"
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
