'use client';

import { useMemo } from 'react';

interface TimePicker24Props {
  value: string;           // "HH:MM" in 24h format (e.g. "19:00")
  onChange: (v: string) => void;
  className?: string;
  /** Step in minutes. Default 15. */
  step?: number;
}

/**
 * Formats a 24h "HH:MM" string into "19:00 (7:00 PM)" display.
 * Returns the raw value if parsing fails.
 */
export function formatTime24(time: string): string {
  const match = /^(\d{2}):(\d{2})$/.exec(time);
  if (!match) return time;
  const h = parseInt(match[1], 10);
  const m = match[2];
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return `${h}:${m} (${h12}:${m} ${ampm})`;
}

/**
 * Formats a 24h time for compact display: "19:00" or "7 PM" style.
 */
export function formatTimeShort(time: string): string {
  const match = /^(\d{2}):(\d{2})$/.exec(time);
  if (!match) return time;
  const h = parseInt(match[1], 10);
  const m = match[2];
  if (m === '00') {
    const ampm = h >= 12 ? 'PM' : 'AM';
    const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
    return `${h12} ${ampm}`;
  }
  return `${h}:${m}`;
}

export default function TimePicker24({ value, onChange, className, step = 15 }: TimePicker24Props) {
  const options = useMemo(() => {
    const slots: { value: string; label: string }[] = [];
    for (let mins = 0; mins < 24 * 60; mins += step) {
      const h = Math.floor(mins / 60);
      const m = mins % 60;
      const hh = String(h).padStart(2, '0');
      const mm = String(m).padStart(2, '0');
      const ampm = h >= 12 ? 'PM' : 'AM';
      const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
      const label = m === 0
        ? `${hh}:${mm}  (${h12} ${ampm})`
        : `${hh}:${mm}  (${h12}:${mm} ${ampm})`;
      slots.push({ value: `${hh}:${mm}`, label });
    }
    return slots;
  }, [step]);

  // Snap value to nearest step if needed
  const snappedValue = useMemo(() => {
    const match = /^(\d{2}):(\d{2})$/.exec(value);
    if (!match) return value;
    const h = parseInt(match[1], 10);
    const m = parseInt(match[2], 10);
    const totalMins = h * 60 + m;
    const snapped = Math.round(totalMins / step) * step;
    const sh = Math.floor(snapped / 60) % 24;
    const sm = snapped % 60;
    return `${String(sh).padStart(2, '0')}:${String(sm).padStart(2, '0')}`;
  }, [value, step]);

  return (
    <select
      value={snappedValue}
      onChange={(e) => onChange(e.target.value)}
      className={className || 'w-full bg-zinc-900 border border-zinc-800/60 rounded-lg px-2 py-1.5 text-xs text-white focus:outline-none focus:ring-2 focus:ring-emerald-500/30'}
    >
      {options.map((opt) => (
        <option key={opt.value} value={opt.value}>
          {opt.label}
        </option>
      ))}
    </select>
  );
}
