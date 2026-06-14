// Shared YYYY-MM-DD formatter using the caller's local timezone.
//
// Pulled out of weekly-fill.ts and smartScheduler.ts so both layers
// produce identical date strings for the same Date — earlier those two
// disagreed (smartScheduler used `toISOString` = UTC, weekly-fill used
// local components) which caused off-by-one mismatches between the
// scheduler's slot-pick and the daemon's "filled?" check for any
// timezone offset other than UTC.
export function formatLocalDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
