'use client';

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { MoreVertical, type LucideIcon } from 'lucide-react';

export type KebabMenuItem =
  | {
      kind: 'item';
      id: string;
      label: string;
      icon?: LucideIcon;
      onSelect: () => void;
      destructive?: boolean;
      disabled?: boolean;
      shortcut?: string;
    }
  | { kind: 'separator' }
  | { kind: 'label'; text: string };

export interface KebabMenuProps {
  ariaLabel: string;
  items: KebabMenuItem[];
  placement?: 'auto' | 'top' | 'bottom';
  triggerClassName?: string;
  disabled?: boolean;
  onOpenChange?: (open: boolean) => void;
}

const PANEL_HEIGHT_BUDGET = 220;
const PANEL_MIN_WIDTH = 180;
const VIEWPORT_EDGE_GUARD = 8;

const DEFAULT_TRIGGER_CLASS =
  'w-8 h-8 flex items-center justify-center bg-black/50 text-white rounded-lg backdrop-blur-md ' +
  'transition-colors hover:bg-[#c5a062]/80 hover:text-zinc-900 ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e6ff] focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950 ' +
  'disabled:opacity-40 disabled:cursor-not-allowed';

const OPEN_TRIGGER_CLASS =
  'bg-[#c5a062] text-zinc-900 ring-2 ring-[#00e6ff]/50';

export function KebabMenu({
  ariaLabel,
  items,
  placement = 'auto',
  triggerClassName,
  disabled,
  onOpenChange,
}: KebabMenuProps) {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [resolvedPlacement, setResolvedPlacement] = useState<'top' | 'bottom'>(
    placement === 'top' ? 'top' : 'bottom',
  );
  const [resolvedAlign, setResolvedAlign] = useState<'left' | 'right'>('right');
  const [panelStyle, setPanelStyle] = useState<CSSProperties>({ position: 'fixed', top: 0, left: 0 });
  const [activeIndex, setActiveIndex] = useState<number>(-1);
  const [reduceMotion, setReduceMotion] = useState(false);

  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const typeAheadRef = useRef<{ buffer: string; lastAt: number }>({ buffer: '', lastAt: 0 });
  const menuId = useId();

  const focusableIndexes = useMemo(() => {
    const out: number[] = [];
    items.forEach((it, i) => {
      if (it.kind === 'item' && !it.disabled) out.push(i);
    });
    return out;
  }, [items]);

  // V105.1-REACT-19: setReduceMotion is the one-time init from the
  // media-query system, not a render-derived value. The setState here
  // is what subscribes this component to the system (same pattern as
  // useSyncExternalStore). Deferring it via queueMicrotask breaks the
  // tests that assert reduce-motion behavior synchronously after mount.
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setReduceMotion(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setReduceMotion(e.matches);
    mq.addEventListener?.('change', onChange);
    return () => mq.removeEventListener?.('change', onChange);
  }, []);

  const close = useCallback(
    (returnFocus: boolean) => {
      setOpen(false);
      setActiveIndex(-1);
      if (returnFocus) {
        window.setTimeout(() => triggerRef.current?.focus(), 0);
      }
    },
    [],
  );

  useEffect(() => {
    onOpenChange?.(open);
  }, [open, onOpenChange]);

  // V105.1-REACT-19: setMounted is the standard SSR-skip / deferred
  // mount pattern — when `open` becomes true we mount the popover,
  // when it becomes false we delay-unmount to allow the close
  // animation. The setMounted calls are not cascading because they
  // represent the "I am now in DOM" signal, not a render-derived
  // value. Tests assert the menu items are visible synchronously
  // after the kebab click, so deferring via queueMicrotask breaks
  // them. Keeping the synchronous setState with a documented
  // justification.
  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setMounted(true);
      return;
    }
    const dur = reduceMotion ? 0 : 80;
    const t = window.setTimeout(() => setMounted(false), dur);
    return () => window.clearTimeout(t);
  }, [open, reduceMotion]);

  const recomputePlacement = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const vh = window.innerHeight;
    const vw = window.innerWidth;

    let next: 'top' | 'bottom' = 'bottom';
    if (placement === 'top') next = 'top';
    else if (placement === 'bottom') next = 'bottom';
    else {
      const spaceBelow = vh - rect.bottom;
      next = spaceBelow < PANEL_HEIGHT_BUDGET + VIEWPORT_EDGE_GUARD ? 'top' : 'bottom';
    }

    let align: 'left' | 'right' = 'right';
    if (rect.right - PANEL_MIN_WIDTH < VIEWPORT_EDGE_GUARD) align = 'left';
    else if (rect.left + PANEL_MIN_WIDTH > vw - VIEWPORT_EDGE_GUARD) align = 'right';

    const style: CSSProperties = { position: 'fixed' };
    if (next === 'bottom') style.top = rect.bottom + 4;
    else style.bottom = vh - rect.top + 4;
    if (align === 'right') style.right = vw - rect.right;
    else style.left = rect.left;

    setResolvedPlacement(next);
    setResolvedAlign(align);
    setPanelStyle(style);
  }, [placement]);

  useLayoutEffect(() => {
    if (!open) return;
    recomputePlacement();
  }, [open, recomputePlacement]);

  useEffect(() => {
    if (!open) return;
    const onResize = () => recomputePlacement();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [open, recomputePlacement]);

  useEffect(() => {
    if (!open) return;
    const onScroll = (e: Event) => {
      if (panelRef.current?.contains(e.target as Node)) return;
      close(false);
    };
    window.addEventListener('scroll', onScroll, true);
    return () => window.removeEventListener('scroll', onScroll, true);
  }, [open, close]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (panelRef.current?.contains(target)) return;
      if (triggerRef.current?.contains(target)) return;
      close(false);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [open, close]);

  useEffect(() => {
    if (!open) return;
    const onFocus = (e: FocusEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (panelRef.current?.contains(target)) return;
      if (triggerRef.current?.contains(target)) return;
      close(false);
    };
    document.addEventListener('focusin', onFocus);
    return () => document.removeEventListener('focusin', onFocus);
  }, [open, close]);

  useLayoutEffect(() => {
    if (!open) return;
    if (activeIndex < 0) return;
    itemRefs.current[activeIndex]?.focus();
  }, [open, activeIndex]);

  const openMenu = useCallback(
    (focusFirst: boolean) => {
      if (disabled) return;
      setOpen(true);
      if (focusFirst && focusableIndexes.length > 0) {
        setActiveIndex(focusableIndexes[0]);
      } else {
        setActiveIndex(-1);
      }
    },
    [disabled, focusableIndexes],
  );

  const moveFocus = useCallback(
    (direction: 1 | -1) => {
      if (focusableIndexes.length === 0) return;
      setActiveIndex((cur) => {
        const pos = focusableIndexes.indexOf(cur);
        if (pos === -1) return focusableIndexes[direction === 1 ? 0 : focusableIndexes.length - 1];
        const nextPos = (pos + direction + focusableIndexes.length) % focusableIndexes.length;
        return focusableIndexes[nextPos];
      });
    },
    [focusableIndexes],
  );

  const focusFirst = useCallback(() => {
    if (focusableIndexes.length > 0) setActiveIndex(focusableIndexes[0]);
  }, [focusableIndexes]);

  const focusLast = useCallback(() => {
    if (focusableIndexes.length > 0) setActiveIndex(focusableIndexes[focusableIndexes.length - 1]);
  }, [focusableIndexes]);

  const handleTypeAhead = useCallback(
    (char: string) => {
      const now = Date.now();
      if (now - typeAheadRef.current.lastAt > 600) typeAheadRef.current.buffer = '';
      typeAheadRef.current.buffer += char.toLowerCase();
      typeAheadRef.current.lastAt = now;
      const buf = typeAheadRef.current.buffer;
      const startFrom = activeIndex === -1 ? -1 : focusableIndexes.indexOf(activeIndex);
      for (let off = 1; off <= focusableIndexes.length; off++) {
        const idx = focusableIndexes[(startFrom + off + focusableIndexes.length) % focusableIndexes.length];
        const item = items[idx];
        if (item.kind === 'item' && item.label.toLowerCase().startsWith(buf)) {
          setActiveIndex(idx);
          return;
        }
      }
    },
    [items, focusableIndexes, activeIndex],
  );

  const handleTriggerKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLButtonElement>) => {
      if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (open) moveFocus(1);
        else openMenu(true);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (!open) {
          openMenu(true);
          focusLast();
        } else moveFocus(-1);
      } else if (e.key === 'Escape' && open) {
        e.preventDefault();
        close(true);
      }
    },
    [open, openMenu, moveFocus, focusLast, close],
  );

  const handlePanelKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); moveFocus(1); return; }
      if (e.key === 'ArrowUp')   { e.preventDefault(); moveFocus(-1); return; }
      if (e.key === 'Home')      { e.preventDefault(); focusFirst(); return; }
      if (e.key === 'End')       { e.preventDefault(); focusLast(); return; }
      if (e.key === 'Escape')    { e.preventDefault(); close(true); return; }
      if (e.key === 'Tab')       { close(false); return; }
      if (e.key.length === 1 && /\S/.test(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        handleTypeAhead(e.key);
      }
    },
    [moveFocus, focusFirst, focusLast, close, handleTypeAhead],
  );

  const handleTriggerClick = useCallback(
    (e: ReactMouseEvent<HTMLButtonElement>) => {
      e.stopPropagation();
      if (open) close(false);
      else openMenu(false);
    },
    [open, openMenu, close],
  );

  const activate = useCallback(
    (idx: number) => {
      const item = items[idx];
      if (!item || item.kind !== 'item' || item.disabled) return;
      item.onSelect();
      close(true);
    },
    [items, close],
  );

  const triggerClass = `${triggerClassName ?? DEFAULT_TRIGGER_CLASS} ${open ? OPEN_TRIGGER_CLASS : ''}`;

  if (items.length === 0) return null;

  const enterTransform = resolvedPlacement === 'top' ? 'translate-y-1' : '-translate-y-1';

  const panel = mounted ? (
    <div
      ref={panelRef}
      id={menuId}
      role="menu"
      aria-label={ariaLabel}
      tabIndex={-1}
      onKeyDown={handlePanelKeyDown}
      onClick={(e) => e.stopPropagation()}
      style={panelStyle}
      className={[
        'z-[9999] min-w-[180px] max-w-[240px] p-1.5',
        'bg-zinc-900/95 backdrop-blur-md border border-[#c5a062]/30',
        'rounded-xl shadow-2xl shadow-black/60',
        resolvedAlign === 'right' ? 'origin-top-right' : 'origin-top-left',
        reduceMotion
          ? open ? 'opacity-100' : 'opacity-0'
          : open
            ? 'opacity-100 scale-100 translate-y-0 transition-[opacity,transform] duration-[120ms] ease-out'
            : `opacity-0 scale-95 ${enterTransform} transition-[opacity,transform] duration-[80ms] ease-in`,
      ].join(' ')}
    >
          {items.map((item, idx) => {
            if (item.kind === 'separator') {
              return (
                <div
                  key={`sep-${idx}`}
                  role="separator"
                  className="my-1 border-t border-zinc-800"
                />
              );
            }
            if (item.kind === 'label') {
              return (
                <div
                  key={`lbl-${idx}-${item.text}`}
                  role="presentation"
                  className="px-2.5 py-1 text-[10px] font-bold text-zinc-500 uppercase tracking-widest"
                >
                  {item.text}
                </div>
              );
            }
            const Icon = item.icon;
            const destructive = item.destructive;
            const isPriorDestructive =
              destructive &&
              (idx === 0 || items[idx - 1].kind !== 'separator') &&
              !(idx > 0 && items[idx - 1].kind === 'item' && (items[idx - 1] as { destructive?: boolean }).destructive);
            return (
              <button
                key={item.id}
                ref={(el) => { itemRefs.current[idx] = el; }}
                role="menuitem"
                type="button"
                tabIndex={activeIndex === idx ? 0 : -1}
                disabled={item.disabled}
                onClick={(e) => { e.stopPropagation(); activate(idx); }}
                onMouseEnter={() => setActiveIndex(idx)}
                className={[
                  'group flex items-center gap-2.5 w-full px-2.5 py-2 rounded-lg text-left text-xs',
                  'focus-visible:outline-none transition-colors',
                  'disabled:opacity-40 disabled:cursor-not-allowed',
                  destructive
                    ? 'text-red-400 hover:bg-red-500/15 hover:text-red-300 focus-visible:bg-red-500/15'
                    : 'text-zinc-300 hover:bg-[#c5a062]/15 hover:text-white focus-visible:bg-[#c5a062]/15',
                  isPriorDestructive ? 'border-t border-zinc-800 mt-1 pt-2' : '',
                ].join(' ')}
              >
                {Icon && (
                  <Icon
                    className={[
                      'w-3.5 h-3.5 shrink-0',
                      destructive
                        ? 'text-red-400 group-hover:text-red-300'
                        : 'text-zinc-400 group-hover:text-[#c5a062]',
                    ].join(' ')}
                  />
                )}
                <span className="flex-1 truncate">{item.label}</span>
                {item.shortcut && (
                  <span className="text-[10px] text-zinc-500 font-mono">{item.shortcut}</span>
                )}
              </button>
            );
          })}
    </div>
  ) : null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={handleTriggerClick}
        onKeyDown={handleTriggerKeyDown}
        className={triggerClass}
      >
        <MoreVertical className="w-4 h-4" />
      </button>
      {panel && typeof document !== 'undefined' ? createPortal(panel, document.body) : null}
    </>
  );
}
