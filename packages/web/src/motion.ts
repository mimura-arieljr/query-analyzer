import { useEffect, useState } from 'react';

// True when the viewer asked for less motion.
// - Without matchMedia (tests, very old browsers) there is no way to ask, so stay still.
export function prefersReducedMotion(): boolean {
  const mm = (globalThis as { matchMedia?: (q: string) => MediaQueryList }).matchMedia;
  if (typeof mm !== 'function') return true;
  return mm('(prefers-reduced-motion: reduce)').matches;
}

// Index of the part being scanned while `active`, looping; null when inactive or with reduced motion.
export function useScan(active: boolean, count: number, stepMs: number): number | null {
  const [index, setIndex] = useState(0);
  const enabled = active && count > 0 && !prefersReducedMotion();
  useEffect(() => {
    if (!enabled) return;
    setIndex(0);
    const t = setInterval(() => setIndex((i) => (i + 1) % count), stepMs);
    return () => clearInterval(t);
  }, [enabled, count, stepMs]);
  return enabled ? index : null;
}
