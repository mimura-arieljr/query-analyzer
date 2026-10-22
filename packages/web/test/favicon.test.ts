// @vitest-environment node
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');
const html = readFileSync(resolve(root, 'index.html'), 'utf8');

function publicFile(href: string): string {
  return resolve(root, 'public', href.replace(/^\//, ''));
}

function pngSize(file: string): { width: number; height: number; signature: string } {
  const bytes = readFileSync(file);
  return {
    signature: bytes.subarray(1, 4).toString('latin1'),
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
  };
}

describe('browser tab icon', () => {
  it('declares an SVG icon for modern browsers', () => {
    expect(html).toMatch(/<link[^>]+rel="icon"[^>]+type="image\/svg\+xml"[^>]+href="\/favicon\.svg"/);
  });

  it('declares a 32px PNG fallback for browsers without SVG icons', () => {
    expect(html).toMatch(/<link[^>]+rel="icon"[^>]+type="image\/png"[^>]+sizes="32x32"[^>]+href="\/favicon-32\.png"/);
  });

  it('declares an Apple touch icon', () => {
    expect(html).toMatch(/<link[^>]+rel="apple-touch-icon"[^>]+href="\/apple-touch-icon\.png"/);
  });

  it('sets the browser theme colour to the dark page background', () => {
    expect(html).toMatch(/<meta[^>]+name="theme-color"[^>]+content="#0b0f14"/i);
  });

  it('points every icon link at a file that exists in public/', () => {
    const hrefs = [...html.matchAll(/<link[^>]+rel="(?:icon|apple-touch-icon)"[^>]+href="([^"]+)"/g)].map((m) => m[1]);
    expect(hrefs.length).toBe(3);
    for (const href of hrefs) {
      expect(href.startsWith('/')).toBe(true);
      expect(existsSync(publicFile(href)), href).toBe(true);
    }
  });

  it('keeps the SVG small, self-contained and in the brand colour', () => {
    const file = publicFile('/favicon.svg');
    const svg = readFileSync(file, 'utf8');
    expect(statSync(file).size).toBeLessThan(2048);
    expect(svg).toContain('viewBox="0 0 64 64"');
    expect(svg.toLowerCase()).toContain('#00ffff');
    expect(svg).not.toMatch(/<script|href=|xlink|<image|<style|url\(/i);
  });

  it('ships PNGs at the sizes the links promise', () => {
    expect(pngSize(publicFile('/favicon-32.png'))).toEqual({ signature: 'PNG', width: 32, height: 32 });
    expect(pngSize(publicFile('/apple-touch-icon.png'))).toEqual({ signature: 'PNG', width: 180, height: 180 });
  });
});
