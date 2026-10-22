import { fileURLToPath } from 'node:url';

// Path of the built web app, from the URL of bin/app.ts.
// - fileURLToPath decodes %20 and non-ASCII; URL.pathname would not.
export function webDistPathFrom(appUrl: string | URL): string {
  return fileURLToPath(new URL('../../web/dist', appUrl));
}

// A numeric context value; cdk.json gives JSON numbers, `-c` gives strings.
export function numberSetting(key: string, raw: unknown, fallback: number | undefined): number | undefined {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`Context "${key}" must be a number, got "${String(raw)}"`);
  return n;
}
