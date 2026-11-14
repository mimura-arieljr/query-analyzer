// True when the viewer asked for less motion.
// - Without matchMedia (tests, very old browsers) there is no way to ask, so stay still.
export function prefersReducedMotion(): boolean {
  const mm = (globalThis as { matchMedia?: (q: string) => MediaQueryList }).matchMedia;
  if (typeof mm !== 'function') return true;
  return mm('(prefers-reduced-motion: reduce)').matches;
}
