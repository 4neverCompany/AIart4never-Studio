/**
 * Next.js App Router loading file.
 * Renders automatically during route segment suspense / navigation.
 * Intentionally lightweight — the full branded loader is DesktopLoadingScreen,
 * used at the app-shell level in MashupStudio.tsx.
 */
export default function Loading() {
  return (
    <div className="fixed inset-0 flex items-center justify-center bg-[#050505]">
      <div className="relative w-8 h-8">
        <div className="absolute inset-0 rounded-full border border-[#00e6ff]/10" />
        <div
          className="absolute inset-0 rounded-full border-[1.5px] border-transparent border-t-[#00e6ff] animate-spin"
          style={{ boxShadow: '0 0 8px rgba(0,230,255,0.4)' }}
        />
        <div className="absolute inset-[9px] rounded-full bg-[#c5a062]/70" />
      </div>
    </div>
  );
}
