// V040-DES-003 / V040-HOTFIX-002 / V080-DEV-003: transient amber
// notice shown on a carousel approval card when the user is at the
// per-image reject floor. The floor is 1 image (you can't drop the
// carousel to zero — for that, use "Reject carousel"). A 2-image
// carousel CAN now have one image rejected; the survivor auto-
// collapses to a single-image post via groupApprovalPosts.
// Presentational only; the parent card decides when to make it
// visible based on the per-image local status map.

import { AlertTriangle } from 'lucide-react';

export function DegradeNotice({
  visible,
  message = 'Cannot reject the last image — use "Reject carousel" to remove the whole post',
}: {
  visible: boolean;
  message?: string;
}) {
  if (!visible) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-center gap-2 text-xs px-3 py-2 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-200 motion-safe:animate-[fadeIn_200ms_ease-out]"
    >
      <AlertTriangle className="w-3.5 h-3.5" aria-hidden="true" />
      <span>{message}</span>
    </div>
  );
}
