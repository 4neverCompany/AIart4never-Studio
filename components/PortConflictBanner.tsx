'use client';

import { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';

const STABLE_PORT = '19782';

export function PortConflictBanner() {
  const [ephemeral, setEphemeral] = useState(false);

  // V105.1-REACT-19: setState deferred via queueMicrotask (project
  // convention) so the effect body only reads window.location, not
  // local state.
  useEffect(() => {
    queueMicrotask(() => {
      const port = window.location.port;
      if (port && port !== STABLE_PORT) {
        setEphemeral(true);
      }
    });
  }, []);

  if (!ephemeral) return null;

  return (
    <div className="rounded-xl border border-[#c5a062]/40 bg-[#c5a062]/5 p-3 space-y-1">
      <div className="flex items-start gap-2">
        <AlertTriangle className="w-3.5 h-3.5 text-[#c5a062] shrink-0 mt-0.5" />
        <div className="space-y-1">
          <p className="text-xs font-semibold text-[#c5a062]">
            Port conflict detected
          </p>
          <p className="text-[10px] text-zinc-400 leading-relaxed">
            Another process is using port {STABLE_PORT}, so MashupForge launched
            on a temporary port. Watermark settings, scheduled posts, and other
            locally-saved data <strong className="text-zinc-300">will not persist</strong> after
            you close the app. API keys and Instagram credentials (above) are
            unaffected.
          </p>
          <p className="text-[10px] text-zinc-500 leading-relaxed">
            To fix: close any other MashupForge instance or process using port {STABLE_PORT},
            then restart.
          </p>
        </div>
      </div>
    </div>
  );
}
