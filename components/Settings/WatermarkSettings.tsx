'use client';

import { Image as ImageIcon, Trash2 } from 'lucide-react';
import { Stamp as WatermarkIcon } from 'lucide-react';
import {
  persistWatermarkToDisk,
  displayWatermarkUrlAsync,
  removeWatermarkFile,
  parseDataUrl,
  hashBytes,
} from '@/lib/watermarks/storage';
import {
  buildWatermarkUploadPatch,
  buildWatermarkRemovePatch,
} from '@/lib/watermarks/migrate';
import { showToast } from '@/components/Toast';
import type { UserSettings, WatermarkSettings } from '@/types/mashup';
import { SettingsSection } from './SettingsSection';
import { Switch } from './Switch';

/**
 * M3.4-P4-B2: Watermark settings block, extracted from
 * `components/SettingsModal.tsx` to keep that file under the 2k-LOC
 * mark. Renders the `SettingsSection`-wrapped Watermark card with the
 * Enable toggle, Upload Logo control, visual preview, and the
 * position / opacity / size selectors.
 *
 * The component is a leaf — it doesn't own the active-tab state, the
 * save-pill state, or the modal chrome. The parent (SettingsModal)
 * passes the current `settings.watermark` slice plus an `updateSettings`
 * callback that targets the same UserSettings store.
 *
 * Watermark data flow (V1.7.1-M3.2b-WATERMARK-DISK):
 * 1. User picks a file.
 * 2. Bytes are written to disk via `persistWatermarkToDisk` (Tauri only).
 * 3. The store gets a thin `imageRef` plus an `assetUrl` that
 *    `applyWatermark` / GalleryCard / ImageDetailModal can consume
 *    without any per-call-site changes.
 * 4. Off-Tauri (web preview) falls back to a data-URL so the user
 *    still sees their logo.
 */
export interface WatermarkSettingsProps {
  settings: UserSettings;
  updateSettings: (
    patch:
      | Partial<UserSettings>
      | ((prev: UserSettings) => Partial<UserSettings>),
  ) => void;
}

export function WatermarkSettings({ settings, updateSettings }: WatermarkSettingsProps) {
  const wm = settings.watermark || ({} as WatermarkSettings);

  return (
    <SettingsSection
      icon={WatermarkIcon}
      title="Watermark"
      subtitle="Brand every generated image with a small overlay so it's recognisable in feeds."
    >
      <div className="flex items-center justify-between mb-4">
        <span className="text-sm text-zinc-300">Enable Watermark</span>
        <Switch
          checked={!!wm.enabled}
          onChange={(v) => updateSettings({ watermark: { enabled: v } as WatermarkSettings })}
          label="Watermark"
          size="md"
        />
      </div>

      {wm.enabled && (
        <div className="space-y-4 bg-zinc-950/50 p-4 rounded-xl border border-zinc-800/60">
          <div>
            <label className="block text-sm text-zinc-400 mb-2">Upload Logo</label>
            <input
              type="file"
              id="watermark-upload"
              accept=".png,.jpg,.jpeg,.svg,image/png,image/jpeg,image/svg+xml"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                // V1.7.1-M3.2b-WATERMARK-DISK: write the bytes to
                // disk via persistWatermarkToDisk. The store keeps
                // only a thin imageRef; the runtime `image` field
                // becomes an asset:// URL so consumers (applyWatermark,
                // GalleryCard, ImageDetailModal) don't have to change.
                const ref = await persistWatermarkToDisk({
                  bytes: new Uint8Array(await file.arrayBuffer()),
                  mime: file.type || 'image/png',
                });
                if (!ref) {
                  // Off-Tauri or write failure — fall back to the
                  // legacy data-URL so the user still sees their logo
                  // (web preview build, or fs-permission denied).
                  const reader = new FileReader();
                  reader.onload = (event) => {
                    const dataUrl = event.target?.result as string;
                    if (!dataUrl) return;
                    const parsed = parseDataUrl(dataUrl);
                    if (!parsed) return;
                    updateSettings({
                      watermark: buildWatermarkUploadPatch(wm, {
                        dataUrl,
                        assetUrl: dataUrl,
                        hash: hashBytes(parsed.bytes),
                        filename: '',
                        mimeType: parsed.mime,
                        size: parsed.bytes.byteLength,
                      }),
                    });
                  };
                  reader.readAsDataURL(file);
                  return;
                }
                const assetUrl = await displayWatermarkUrlAsync(ref);
                if (!assetUrl) {
                  // Disk write succeeded but we couldn't resolve the
                  // asset:// URL — extremely unlikely, but handle it
                  // by leaving a stale ref and a missing image rather
                  // than crashing the modal.
                  return;
                }
                updateSettings({
                  watermark: buildWatermarkUploadPatch(wm, {
                    dataUrl: '',
                    assetUrl,
                    hash: ref.hash,
                    filename: ref.filename,
                    mimeType: ref.mimeType,
                    size: ref.size,
                  }),
                });
              }}
              className="hidden"
            />
            <label
              htmlFor="watermark-upload"
              className="flex items-center justify-center w-full py-3 px-4 rounded-xl border-2 border-dashed border-zinc-800 hover:border-[#00e6ff]/40 hover:bg-[#00e6ff]/5 transition-all cursor-pointer group"
            >
              <div className="flex flex-col items-center gap-1">
                <ImageIcon className="w-5 h-5 text-zinc-500 group-hover:text-[#00e6ff]" />
                <span className="text-xs text-zinc-500 group-hover:text-zinc-400 font-medium">
                  {wm.image ? 'Change Logo' : 'Choose File'}
                </span>
              </div>
            </label>

            {wm.image && (
              <div className="mt-4 space-y-4">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-zinc-500 uppercase tracking-wider">Visual Preview</span>
                  <button
                    onClick={async () => {
                      // V1.7.1-M3.2b-WATERMARK-DISK: clear the runtime
                      // image AND the persistent ref, then best-effort
                      // delete the on-disk file. The store write
                      // happens first so a disk-write failure can't
                      // leave the user thinking their logo is gone
                      // when it isn't.
                      await removeWatermarkFile();
                      updateSettings({
                        watermark: buildWatermarkRemovePatch(wm),
                      });
                    }}
                    className="text-xs text-red-400 hover:text-red-300 transition-colors flex items-center gap-1"
                  >
                    <Trash2 className="w-3 h-3" /> Remove
                  </button>
                </div>

                {/* Visual Indicator Box */}
                <div className="relative aspect-video bg-zinc-900 rounded-xl border border-zinc-800/60 overflow-hidden flex items-center justify-center group">
                  <div className="absolute inset-0 opacity-20 bg-[radial-gradient(#333_1px,transparent_1px)] [background-size:16px_16px]" />
                  <span className="text-[10px] text-zinc-700 font-mono uppercase tracking-[0.2em] select-none">Image Canvas Preview</span>

                  {/* The Watermark Mockup */}
                  <div
                    className="absolute transition-all duration-300 flex items-center justify-center"
                    style={{
                      top: wm.position?.includes('top') ? '10%' : wm.position === 'center' ? '50%' : 'auto',
                      bottom: wm.position?.includes('bottom') ? '10%' : 'auto',
                      left: wm.position?.includes('left') ? '10%' : wm.position === 'center' ? '50%' : 'auto',
                      right: wm.position?.includes('right') ? '10%' : 'auto',
                      transform: wm.position === 'center' ? 'translate(-50%, -50%)' : 'none',
                      opacity: wm.opacity || 0.8,
                      width: `${(wm.scale || 0.15) * 100}%`,
                      aspectRatio: '1/1',
                      maxWidth: '40%',
                      maxHeight: '40%',
                    }}
                  >
                    <img
                      src={wm.image}
                      alt="Watermark preview"
                      className="absolute inset-0 w-full h-full object-contain drop-shadow-lg"
                    />
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* FEAT-002b bug fix: Manage Collections + Channel Name used
              to live HERE, nested inside the watermark.enabled wrapper —
              so disabling the watermark made them disappear. They have
              been lifted up to the top of the General tab. */}

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider">Position</label>
              <select
                value={wm.position || 'bottom-right'}
                onChange={(e) =>
                  updateSettings({
                    watermark: { position: e.target.value as WatermarkSettings['position'] } as WatermarkSettings,
                  })
                }
                className="w-full bg-zinc-900 border border-zinc-800/60 rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-[#c5a062]/30 cursor-pointer"
              >
                <option value="bottom-right">Bottom Right</option>
                <option value="bottom-left">Bottom Left</option>
                <option value="top-right">Top Right</option>
                <option value="top-left">Top Left</option>
                <option value="center">Center</option>
              </select>
            </div>

            <div className="space-y-2">
              <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider">Opacity</label>
              <select
                value={wm.opacity || 0.8}
                onChange={(e) =>
                  updateSettings({
                    watermark: { opacity: parseFloat(e.target.value) } as WatermarkSettings,
                  })
                }
                className="w-full bg-zinc-900 border border-zinc-800/60 rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-[#c5a062]/30 cursor-pointer"
              >
                {[0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0].map((val) => (
                  <option key={val} value={val}>{Math.round(val * 100)}%</option>
                ))}
              </select>
            </div>
          </div>

          <div className="space-y-2">
            <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider">Size (Relative to Image)</label>
            <select
              value={wm.scale || 0.15}
              onChange={(e) =>
                updateSettings({
                  watermark: { scale: parseFloat(e.target.value) } as WatermarkSettings,
                })
              }
              className="w-full bg-zinc-900 border border-zinc-800/60 rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-[#c5a062]/30 cursor-pointer"
            >
              {[0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5].map((val) => (
                <option key={val} value={val}>{Math.round(val * 100)}%</option>
              ))}
            </select>
          </div>
        </div>
      )}
    </SettingsSection>
  );
}
