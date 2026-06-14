'use client';

import { useEffect, useRef, useState, type ImgHTMLAttributes } from 'react';

// 1x1 transparent gif — occupies the parent's layout box (object-cover etc.)
// without triggering a network request or showing a broken-image icon while
// we wait for the IntersectionObserver to fire.
const PLACEHOLDER =
  'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';

type LazyImgProps = Omit<ImgHTMLAttributes<HTMLImageElement>, 'src'> & {
  src: string;
  // How far before the viewport edge to start loading. 200px lines up with
  // a typical fast scroll: image is ready by the time the user reaches it.
  rootMargin?: string;
};

// PROP-021: defers <img src> assignment until the element scrolls within
// `rootMargin` of the viewport. Use in long galleries (Gallery, PostReady,
// Captioning grid, picker modals) so 500+ entries don't all hit the
// network on tab switch.
export function LazyImg({ src, rootMargin = '200px', ...rest }: LazyImgProps) {
  const ref = useRef<HTMLImageElement>(null);
  const [shouldLoad, setShouldLoad] = useState(false);

  useEffect(() => {
    if (shouldLoad) return;
    // V105.1-REACT-19: setState deferred via queueMicrotask (project
    // convention) so the effect body only attaches the IntersectionObserver,
    // not local state. Return early before constructing the IO when the
    // host doesn't expose one (happy-dom test env) so the microtask
    // actually fires and the fallback path is taken.
    if (typeof IntersectionObserver === 'undefined') {
      queueMicrotask(() => setShouldLoad(true));
      return;
    }
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setShouldLoad(true);
            io.disconnect();
            return;
          }
        }
      },
      { rootMargin },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [shouldLoad, rootMargin]);

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      ref={ref}
      src={shouldLoad ? src : PLACEHOLDER}
      loading="lazy"
      {...rest}
    />
  );
}
