import { readFileSync, existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { BENCH_PAGES } from '../scripts/bench/pages.ts';
import { parseHistory } from '../scripts/bench/history.ts';

const pagesDir = new URL('../bench/pages/', import.meta.url);
const historyFile = new URL('../bench/history/pages.jsonl', import.meta.url);

describe('bench fixtures', () => {
  it('registers a page file for every bench page', () => {
    for (const page of BENCH_PAGES) {
      expect(existsSync(new URL(page.file, pagesDir)), `${page.file} is missing`).toBe(true);
    }
  });

  it('names each fixture once and says what it stresses', () => {
    const names = BENCH_PAGES.map((page) => page.name);
    expect(new Set(names).size).toBe(names.length);
    for (const page of BENCH_PAGES) {
      expect(page.stresses.length).toBeGreaterThan(20);
    }
  });

  it('marks blocks with an id, a kind, and a size worth translating', () => {
    for (const page of BENCH_PAGES) {
      const html = readFileSync(new URL(page.file, pagesDir), 'utf8');

      // Every fixture is a standalone document with no network dependency, so it can be
      // opened from disk or served by any static server.
      expect(html).toContain('<!doctype html>');
      expect(html).toContain('<html lang="en"');
      expect(html).not.toMatch(/<script[^>]+src=/u);
      expect(html).not.toMatch(/<link[^>]+href="http/u);

      const ids = [...html.matchAll(/data-bench-id="([^"]+)"/gu)].map((match) => match[1]);
      expect(ids.length, `${page.name} has no marked blocks`).toBeGreaterThan(0);
      expect(new Set(ids).size, `${page.name} repeats a bench id`).toBe(ids.length);

      const kinds = [...html.matchAll(/data-bench="([^"]+)"/gu)].map((match) => match[1]);
      for (const kind of kinds) {
        expect(['prose', 'heading', 'ui', 'code']).toContain(kind);
      }
      expect(kinds).toContain('prose');
      expect(
        kinds.filter((kind) => kind === 'prose').length,
        `${page.name} needs realistic prose`,
      ).toBeGreaterThan(0);
    }
  });

  it('keeps enough prose to stress page translation', () => {
    const article = readFileSync(new URL('long-article.html', pagesDir), 'utf8');
    const text = article
      .replace(/<style[\s\S]*?<\/style>/gu, '')
      .replace(/<[^>]+>/gu, ' ')
      .replace(/\s+/gu, ' ');
    expect(text.length).toBeGreaterThan(4000);

    const paragraph = readFileSync(new URL('single-long-paragraph.html', pagesDir), 'utf8');
    const long = /data-bench-id="p-long"[^>]*>([\s\S]*?)<\/p>/u.exec(paragraph)?.[1] ?? '';
    // Long enough to split into several chunks at the 250-character sentence threshold.
    expect(long.replace(/\s+/gu, ' ').trim().length).toBeGreaterThan(2500);
  });

  it('gives the lead-then-tail page a short lead and a long rest', () => {
    const html = readFileSync(new URL('first-paragraph-then-long-tail.html', pagesDir), 'utf8');
    const lead = /data-bench-id="lead"[^>]*>([\s\S]*?)<\/p>/u.exec(html)?.[1] ?? '';
    const leadLength = lead.replace(/\s+/gu, ' ').trim().length;
    const body = html
      .replace(/<style[\s\S]*?<\/style>/gu, '')
      .replace(/<[^>]+>/gu, ' ')
      .replace(/\s+/gu, ' ');

    // A short lead is what makes the "first paragraph is ready, the page is not" split
    // observable; a long lead would blur the two measurements together.
    expect(leadLength).toBeGreaterThan(40);
    expect(leadLength).toBeLessThan(200);
    expect(body.length).toBeGreaterThan(leadLength * 10);
  });

  it('parses the checked-in history, which may be empty', () => {
    const text = existsSync(historyFile) ? readFileSync(historyFile, 'utf8') : '';
    const { problems } = parseHistory(text);
    expect(problems).toEqual([]);
  });
});
