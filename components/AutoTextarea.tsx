'use client';

/**
 * Auto-sizing textarea that grows with its content. Resets to
 * scrollHeight on every render so deletions shrink it too. Shared by
 * Captioning Studio and Post Ready tabs so long captions don't get
 * clipped behind a fixed row count.
 */
import React from 'react';

interface AutoTextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  minRows?: number;
}

function AutoTextareaInner(
  { minRows = 2, className, value, ...rest }: AutoTextareaProps,
  ref: React.Ref<HTMLTextAreaElement>,
) {
  // Always auto-size off a LOCAL ref. AutoTextarea is used both with and
  // without a forwarded ref (the Captioning Studio cards pass none), so the
  // previous `(ref as React.RefObject).current` cast crashed with
  // "Cannot read properties of null (reading 'current')" whenever the
  // forwarded `ref` was null (no ref passed) or a callback ref. Reading a
  // local ref instead makes the effect independent of how the caller wired
  // the ref.
  const innerRef = React.useRef<HTMLTextAreaElement | null>(null);
  React.useLayoutEffect(() => {
    const el = innerRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);
  // Merge the local ref with the optional forwarded ref so callers that DO
  // pass one still receive the node, while ref-less callers stay safe.
  const setRefs = React.useCallback(
    (node: HTMLTextAreaElement | null) => {
      innerRef.current = node;
      if (typeof ref === 'function') ref(node);
      else if (ref) (ref as React.MutableRefObject<HTMLTextAreaElement | null>).current = node;
    },
    [ref],
  );
  return (
    <textarea
      ref={setRefs}
      rows={minRows}
      value={value}
      className={`resize-none overflow-hidden ${className || ''}`}
      {...rest}
    />
  );
}

export const AutoTextarea = React.forwardRef<HTMLTextAreaElement, AutoTextareaProps>(
  AutoTextareaInner,
);
AutoTextarea.displayName = 'AutoTextarea';
