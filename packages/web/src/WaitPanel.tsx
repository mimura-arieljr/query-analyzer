import { useEffect, useRef, useState } from 'react';
import { prefersReducedMotion } from './motion';

export const WAIT_STEPS = ['Working out the query language', 'Checking for risky patterns', 'Explaining each part'];

// How long the first two steps last; the last one spins until the answer arrives.
const STEP_MS = [700, 1400];
const FINISH_TICK_MS = 150;

interface Props {
  // True once the answer has arrived.
  done: boolean;
  onFinished: () => void;
  onStep?: (index: number) => void;
}

// The steps run on a timer: the backend is one request, so they show progress, not track it.
export function WaitPanel({ done, onFinished, onStep }: Props) {
  const [current, setCurrent] = useState(0);
  const reduced = useRef(prefersReducedMotion()).current;
  const finished = useRef(false);

  useEffect(() => {
    if (done || current >= STEP_MS.length) return;
    const t = setTimeout(() => setCurrent((c) => c + 1), STEP_MS[current]);
    return () => clearTimeout(t);
  }, [current, done]);

  // Once the answer is in, tick off the remaining steps quickly.
  useEffect(() => {
    if (!done) return;
    if (reduced || current >= WAIT_STEPS.length) {
      if (!finished.current) {
        finished.current = true;
        onFinished();
      }
      return;
    }
    const t = setTimeout(() => setCurrent((c) => c + 1), FINISH_TICK_MS);
    return () => clearTimeout(t);
  }, [done, current, reduced, onFinished]);

  useEffect(() => {
    onStep?.(current);
  }, [current, onStep]);

  return (
    <div className="wait" role="status">
      <div className="status">{WAIT_STEPS[Math.min(current, WAIT_STEPS.length - 1)]}</div>
      <ol>
        {WAIT_STEPS.map((s, i) => (
          <li key={s} className={i < current ? 'done' : i === current ? 'on' : ''}>
            <span className="dot" aria-hidden="true">
              {i < current && (
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                  <path d="M2 5.2 4.1 7.3 8 3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
            </span>
            {s}
          </li>
        ))}
      </ol>
    </div>
  );
}
