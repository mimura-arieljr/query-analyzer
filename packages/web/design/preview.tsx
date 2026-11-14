// Dev-only preview: fakes the API and drives the app into one state, for screenshots and the inspector.
// - ?state=idle | wait | result (default result); &theme=light; &still=1 turns motion off.
// - Not part of the production build: vite builds index.html only.
import { createRoot } from 'react-dom/client';
import { App } from '../src/App';
import '../src/styles.css';
import { SAMPLE_ANALYSIS, SAMPLE_QUERY } from './sample';

const params = new URLSearchParams(location.search);
const state = params.get('state') ?? 'result';

if (params.get('still')) {
  const real = window.matchMedia.bind(window);
  window.matchMedia = (q: string) =>
    q.includes('reduce') ? ({ ...real(q), matches: true } as MediaQueryList) : real(q);
}
if (params.get('theme') === 'light') {
  const real = window.matchMedia.bind(window);
  window.matchMedia = (q: string) =>
    q.includes('prefers-color-scheme: light') ? ({ ...real(q), matches: true } as MediaQueryList) : real(q);
}

window.fetch = async (input: RequestInfo | URL) => {
  const url = String(input);
  if (url.endsWith('/api/check')) return new Response(null, { status: 204 });
  const delay = state === 'wait' ? 600_000 : 50;
  await new Promise((r) => setTimeout(r, delay));
  return Response.json({ ok: true, analysis: SAMPLE_ANALYSIS });
};

createRoot(document.getElementById('root')!).render(<App />);

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

// React reads input values through the native setter.
function type(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = Object.getPrototypeOf(el) as object;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

async function drive() {
  await tick(30);
  type(document.querySelector<HTMLInputElement>('#secret')!, 'preview');
  document.querySelector<HTMLButtonElement>('.unlock button[type=submit]')!.click();
  await tick(60);
  if (state === 'idle') return;
  type(document.querySelector<HTMLTextAreaElement>('#query')!, SAMPLE_QUERY);
  await tick(30);
  [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Analyze')!.click();
}

void drive();
