import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
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

  it('keeps every checked-in run tied to a real commit', () => {
    const text = existsSync(historyFile) ? readFileSync(historyFile, 'utf8') : '';
    const { records } = parseHistory(text);
    // A mock run measures the scheduler, so it carries no model rate. A live run is a
    // measurement from `pnpm bench:live`, so it names a commit and records the rate it
    // measured.
    //
    // The commit must exist in this repository, but not necessarily in `main`: a squash
    // merge leaves a PR's own commits reachable only from the branch that made them, and
    // the branch is deleted after the merge. Requiring ancestry would fail the run that
    // merged the branch and pass again once the row was rewritten, which says nothing
    // about the numbers. Ask git whether the object is here at all, and say what to do
    // when it is not, since a shallow clone answers "no" for every row.
    const shallow = (() => {
      try {
        return execFileSync('git', ['rev-parse', '--is-shallow-repository'], {
          encoding: 'utf8',
        }).trim();
      } catch {
        return 'false';
      }
    })();

    for (const record of records) {
      const where = `${record.run}/${record.page}`;
      expect(record.dirty, where).toBe(false);
      let kind: string;
      try {
        kind = execFileSync('git', ['cat-file', '-t', record.commit], { encoding: 'utf8' }).trim();
      } catch {
        kind = '';
      }
      expect(
        kind,
        `${where} names commit ${record.commit.slice(0, 7)}, which this clone does not have` +
          (shallow === 'true'
            ? '. The clone is shallow; fetch the full history (fetch-depth: 0) and rerun.'
            : '. Re-record the run on a commit that is in the repository, or restore the branch it came from.'),
      ).toBe('commit');
      if (record.mode === 'mock') {
        expect(record.metrics.estimatedOutputTokensPerSecond, where).toBeNull();
      } else if (record.metrics.timedOut) {
        // A page that hit the timeout never settles, so it has no rate to record.
        expect(record.metrics.fullPageMs, where).toBeNull();
      } else {
        expect(record.metrics.estimatedOutputTokensPerSecond, where).not.toBeNull();
      }
    }
  });

  it('keeps the README fixture count in step with the registry', () => {
    const count = BENCH_PAGES.length;
    const words = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
    const claims: Array<[string, string]> = [
      ['README.md', `${words[count] ?? String(count)} fixtures`],
      ['README.ja.md', `${String(count)} つのページ`],
    ];
    for (const [file, claim] of claims) {
      const text = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
      expect(text, `${file} should say "${claim}"`).toContain(claim);
    }
  });
});
