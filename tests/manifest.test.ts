/**
 * manifest.test.ts — the home-screen contract.
 *
 * These are the details that only fail on a real phone, long after CI is green,
 * and each line here stands for a way that has already gone wrong:
 *
 *  - iOS IGNORES the webmanifest's icons entirely. Without the apple-touch-icon
 *    link it renders a screenshot of the page as the home-screen icon.
 *  - Android crops maskable icons; shipping only "any" icons gets the artwork
 *    letterboxed inside a white circle.
 *  - The Cloudflare beacon is how the game is measured at all; an edit to <head>
 *    that drops it is silent and permanent.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Resolve off this file, not cwd — these assertions must hold wherever vitest
// is invoked from.
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(root, 'public/manifest.webmanifest'), 'utf8'));
const html = readFileSync(join(root, 'index.html'), 'utf8');

describe('manifest.webmanifest', () => {
  it('parses and identifies the game', () => {
    expect(manifest.name).toBe('Driftlock');
    expect(manifest.short_name).toBe('Driftlock');
    expect(manifest.description).toBeTruthy();
  });

  it('installs as a standalone app rather than a browser tab', () => {
    expect(manifest.display).toBe('standalone');
    expect(manifest.start_url).toBe('/');
    expect(manifest.scope).toBe('/');
  });

  it('carries the theme and background colours the splash screen uses', () => {
    expect(manifest.theme_color).toBe('#0b1220');
    expect(manifest.background_color).toBe('#0b1220');
  });

  it('ships 192, 512 and a MASKABLE 512 — Android crops the maskable one', () => {
    const icons = manifest.icons as { src: string; sizes: string; purpose: string }[];
    expect(icons).toHaveLength(3);

    const bySize = (sizes: string, purpose: string) =>
      icons.find((i) => i.sizes === sizes && i.purpose === purpose);

    expect(bySize('192x192', 'any')?.src).toBe('/icons/icon-192.png');
    expect(bySize('512x512', 'any')?.src).toBe('/icons/icon-512.png');
    expect(bySize('512x512', 'maskable')?.src).toBe('/icons/icon-512-maskable.png');
    expect(icons.every((i) => i.type === 'image/png')).toBe(true);
  });
});

describe('index.html — the iOS home-screen set', () => {
  it('links the manifest', () => {
    expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest" />');
  });

  it('links an apple-touch-icon — iOS ignores the manifest icons', () => {
    expect(html).toContain('<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />');
  });

  it('opts into the standalone shell on iOS', () => {
    expect(html).toContain('<meta name="apple-mobile-web-app-capable" content="yes" />');
  });

  it('names the home-screen shortcut', () => {
    expect(html).toContain('<meta name="apple-mobile-web-app-title" content="Driftlock" />');
  });
});

describe('index.html — analytics', () => {
  it('keeps the Cloudflare beacon token', () => {
    expect(html).toContain('static.cloudflareinsights.com/beacon.min.js');
    expect(html).toContain('ba2bab2193ba42c1bea3d6714fcd0e28');
  });
});
