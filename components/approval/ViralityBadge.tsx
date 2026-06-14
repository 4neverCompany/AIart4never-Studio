/**
 * V1.3: Virality score badge for the approval queue.
 *
 * Shows a small pill "Virality: NN" with a colour scale:
 *   0–30  → red/dim   (low predicted engagement)
 *   31–60 → amber     (moderate)
 *   61–100 → green    (high predicted engagement)
 *
 * Rendered null when score is absent (pre-v1.3 posts, provider
 * unavailable, or computation failed).
 */

export function ViralityBadge({ score }: { score: number | null | undefined }) {
  if (score == null) return null;

  const cls =
    score >= 61
      ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
      : score >= 31
        ? 'bg-amber-500/15 text-amber-300 border-amber-500/30'
        : 'bg-red-500/15 text-red-300 border-red-500/30';

  return (
    <span className={`text-[10px] px-2 py-0.5 rounded-full border font-semibold ${cls}`}>
      Virality: {score}
    </span>
  );
}
