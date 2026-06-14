// V040-DES-003: pure pill that summarizes a carousel's approval state
// from per-image counts. No context access — callers pass counts.

export type CarouselImageState = 'pending' | 'approved' | 'rejected';

export function CarouselStatusPill({
  pending,
  approved,
  rejected,
  total,
}: {
  pending: number;
  approved: number;
  rejected: number;
  total: number;
}) {
  if (total === 0) return null;

  if (pending === total) {
    return <Pill cls="bg-indigo-500/15 text-indigo-300 border-indigo-500/30">Pending</Pill>;
  }
  if (rejected === total) {
    return <Pill cls="bg-red-500/15 text-red-300 border-red-500/30">Rejected</Pill>;
  }
  if (pending === 0) {
    const label = rejected > 0 ? `Queued · dropped ${rejected}` : 'Queued';
    return <Pill cls="bg-emerald-500/15 text-emerald-300 border-emerald-500/30">{label}</Pill>;
  }
  return (
    <Pill cls="bg-[#c5a062]/15 text-[#c5a062] border-[#c5a062]/30">
      Partial · {approved} of {total}
    </Pill>
  );
}

function Pill({ children, cls }: { children: React.ReactNode; cls: string }) {
  return (
    <span className={`text-[10px] px-2 py-0.5 rounded-full border font-semibold ${cls}`}>
      {children}
    </span>
  );
}
