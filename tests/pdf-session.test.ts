import { describe, expect, it } from 'vitest';
import type { LayoutBlock, PageLayout } from '@/pdf/layout';
import {
  isPdfBlockSettled,
  PDF_PRIORITY_ROLES,
  pdfRequestPriority,
  PdfSession,
  type PdfEngine,
} from '@/pdf/session';
import { abortError } from '@/engine/errors';
import {
  MAX_PRIORITY,
  isEngineHostRequest,
  serializeTranslateOptions,
} from '@/engine/offscreen/protocol';
import type { TranslateOptions, TranslationChunk } from '@/engine/types';

function block(text: string): LayoutBlock {
  return {
    box: { x: 40, y: 80, width: 220, height: 24 },
    room: { x: 40, y: 80, width: 220, height: 24 },
    lines: [],
    text,
    role: 'prose',
    fontSize: 10,
    lineHeight: 1.2,
    align: 'left',
    bold: false,
    italic: false,
    column: 0,
    advance: 220,
    writing: 0,
  };
}

function layoutOf(text: string): PageLayout {
  return {
    blocks: [block(text)],
    skipped: [],
    bodySize: 10,
    lineHeight: 12,
    pageHeight: 800,
    pageWidth: 600,
    pageIndex: 0,
    obstacles: [],
  };
}

function sessionOf(
  engine: PdfEngine,
  extras: { target?: string; concurrency?: number } = {},
): PdfSession {
  return new PdfSession({
    engine,
    targetLanguage: extras.target ?? 'ja',
    form: 'polite',
    onChange: () => undefined,
    measure: (text, size) => text.length * size * 0.5,
    concurrency: extras.concurrency ?? 1,
  });
}

async function waitFor(check: () => boolean, timeoutMs = 1000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function engineOf(
  translate: (
    segments: { id: string; text: string }[],
    options: TranslateOptions,
  ) => AsyncIterable<TranslationChunk>,
): PdfEngine {
  return { translate };
}

describe('PdfSession stream handling', () => {
  it('treats an error chunk as a failed block, not as a translation', async () => {
    const engine = engineOf(async function* (segments) {
      const id = segments[0]?.id ?? 'b1';
      yield { id, textDelta: '途中' };
      yield { id, final: segments[0]?.text ?? 'source', error: true };
    });
    const session = sessionOf(engine);
    session.addPage(0, layoutOf('A short paragraph of source text.'));
    await waitFor(() => session.pageBlocks(0)[0]?.state === 'failed');
    const state = session.pageBlocks(0)[0];
    expect(state?.translation).toBe('');
    expect(state?.paint).toBe(false);
    expect(state?.overflow).toBe(false);
    expect(session.progress().failed).toBe(1);
    expect(session.progress().overflowed).toBe(0);
  });

  it('restarts a piece when the engine says the stream so far was wrong', async () => {
    const engine = engineOf(async function* (segments) {
      const id = segments[0]?.id ?? 'b1';
      yield { id, textDelta: 'WRONG' };
      yield { id, textDelta: '正しい訳', restart: true };
      yield { id, final: '正しい訳' };
    });
    const session = sessionOf(engine);
    session.addPage(0, layoutOf('A short paragraph of source text.'));
    await waitFor(() => session.pageBlocks(0)[0]?.state === 'done');
    expect(session.pageBlocks(0)[0]?.translation).toBe('正しい訳');
    expect(session.pageBlocks(0)[0]?.translation.includes('WRONG')).toBe(false);
  });

  it('marks a truncated stream as failed rather than done', async () => {
    const engine = engineOf(async function* (segments) {
      const id = segments[0]?.id ?? 'b1';
      yield { id, textDelta: '途中まで' };
    });
    const session = sessionOf(engine);
    session.addPage(0, layoutOf('A short paragraph of source text.'));
    await waitFor(() => session.pageBlocks(0)[0]?.state === 'failed');
    expect(session.pageBlocks(0)[0]?.translation).toBe('');
    expect(session.pageBlocks(0)[0]?.overflow).toBe(false);
    expect(session.progress().failed).toBe(1);
  });

  it('does not retranslate when the glossary contents have not changed', async () => {
    let calls = 0;
    const engine = engineOf(async function* (segments) {
      calls += 1;
      const id = segments[0]?.id ?? 'b1';
      yield { id, final: '訳' };
    });
    const session = sessionOf(engine);
    session.addPage(0, layoutOf('A short paragraph of source text.'));
    await waitFor(() => session.pageBlocks(0)[0]?.state === 'done');
    const before = calls;
    session.setGlossary([]);
    session.setGlossary([]);
    expect(calls).toBe(before);
    session.setGlossary([{ source: 'term', target: '用語' }]);
    await waitFor(() => calls > before);
    expect(calls).toBeGreaterThan(before);
  });

  it('does not let an aborted run mark the next round idle', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const engine = engineOf(async function* (segments) {
      calls += 1;
      const round = calls;
      if (round === 1) await gate;
      const id = segments[0]?.id ?? 'b1';
      yield { id, final: round === 1 ? 'OLD' : 'NEW' };
    });
    const session = sessionOf(engine);
    session.addPage(0, layoutOf('A short paragraph of source text.'));
    await waitFor(() => calls === 1);
    session.setGlossary([{ source: 'a', target: 'b' }]);
    release();
    await waitFor(() => session.pageBlocks(0)[0]?.translation === 'NEW');
    expect(session.pageBlocks(0)[0]?.state).toBe('done');
    expect(session.pageBlocks(0)[0]?.translation).toBe('NEW');
  });

  it('re-queues a failed block from retryFailed', async () => {
    let calls = 0;
    const engine = engineOf(async function* (segments) {
      calls += 1;
      const id = segments[0]?.id ?? 'b1';
      if (calls === 1) {
        yield { id, final: segments[0]?.text ?? '', error: true };
        return;
      }
      yield { id, final: '訳' };
    });
    const session = sessionOf(engine);
    session.addPage(0, layoutOf('A short paragraph of source text.'));
    await waitFor(() => session.pageBlocks(0)[0]?.state === 'failed');
    session.retryFailed();
    await waitFor(() => session.pageBlocks(0)[0]?.state === 'done');
    expect(session.pageBlocks(0)[0]?.translation).toBe('訳');
  });

  it('does not count a failed block as overflow', async () => {
    const engine = engineOf(async function* (segments) {
      const id = segments[0]?.id ?? 'b1';
      yield { id, final: segments[0]?.text ?? '', error: true };
    });
    const session = sessionOf(engine);
    session.addPage(0, layoutOf('A short paragraph of source text.'));
    await waitFor(() => session.pageBlocks(0)[0]?.state === 'failed');
    expect(session.pageBlocks(0)[0]?.overflow).toBe(false);
    expect(session.progress().failed).toBe(1);
    expect(session.progress().overflowed).toBe(0);
  });

  it('fails a block with no translation pieces instead of marking it done', async () => {
    let calls = 0;
    const engine = engineOf(async function* (segments) {
      calls += 1;
      const id = segments[0]?.id ?? 'b1';
      yield { id, final: 'should not run' };
    });
    const session = sessionOf(engine);
    session.addPage(0, layoutOf('   '));
    await waitFor(() => session.pageBlocks(0)[0]?.state === 'failed');
    expect(calls).toBe(0);
    expect(session.pageBlocks(0)[0]?.overflow).toBe(false);
    expect(session.progress().failed).toBe(1);
    expect(session.progress().overflowed).toBe(0);
  });

  it('does not rewrite a block that is already in the target language', async () => {
    let calls = 0;
    const engine = engineOf(async function* (segments) {
      calls += 1;
      const id = segments[0]?.id ?? 'b1';
      yield { id, final: 'paraphrase' };
    });
    const session = sessionOf(engine, { target: 'en' });
    session.addPage(
      0,
      layoutOf('The collector walks the document rather than selecting tags on this page.'),
    );
    await waitFor(() => session.pageBlocks(0)[0]?.state === 'done');
    expect(calls).toBe(0);
    expect(session.pageBlocks(0)[0]?.translation).toBe('');
    expect(session.pageBlocks(0)[0]?.paint).toBe(false);
  });

  it('keeps the previous cover until the new translation arrives', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const engine = engineOf(async function* (segments) {
      calls += 1;
      const id = segments[0]?.id ?? 'b1';
      if (calls === 1) {
        yield { id, final: '訳' };
        return;
      }
      await gate;
      yield { id, final: '译文' };
    });
    const session = sessionOf(engine);
    session.addPage(0, layoutOf('A short paragraph of source text for the cover to keep.'));
    await waitFor(() => session.pageBlocks(0)[0]?.translation === '訳');
    session.setTargetLanguage('zh-hans', 'polite');
    expect(session.pageBlocks(0)[0]?.translation).toBe('訳');
    expect(session.pageBlocks(0)[0]?.paint).toBe(true);
    release();
    await waitFor(() => session.pageBlocks(0)[0]?.translation === '译文');
  });

  it('re-queues a block when the engine preempts instead of failing it', async () => {
    let calls = 0;
    const engine = engineOf(async function* (segments) {
      calls += 1;
      if (calls === 1) throw abortError();
      const id = segments[0]?.id ?? 'b1';
      yield { id, final: '訳' };
    });
    const session = sessionOf(engine);
    session.addPage(0, layoutOf('A short paragraph of source text on the visible page.'));
    await waitFor(() => session.pageBlocks(0)[0]?.state === 'done');
    expect(calls).toBe(2);
    expect(session.pageBlocks(0)[0]?.translation).toBe('訳');
    expect(session.progress().failed).toBe(0);
  });

  it('keeps remaining visible-page work ahead after later pages join the queue', async () => {
    const started: string[] = [];
    const engine = engineOf(async function* (segments) {
      const text = segments[0]?.text ?? '';
      started.push(text);
      const id = segments[0]?.id ?? 'b1';
      yield { id, final: '訳' };
    });
    const session = sessionOf(engine, { concurrency: 1 });
    session.addPage(0, {
      ...layoutOf('First paragraph on the page the reader can see.'),
      blocks: [
        block('First paragraph on the page the reader can see.'),
        block('Second paragraph on the same visible page.'),
      ],
    });
    session.addPage(4, layoutOf('A paragraph many pages away from the reader.'));
    await waitFor(() => started.length >= 3);
    expect(started[0]).toContain('First paragraph');
    expect(started[1]).toContain('Second paragraph');
    expect(started[2]).toContain('many pages away');
  });

  it('schedules a visible-page label ahead of later-page prose', async () => {
    const seen: { text: string; priority: number; eager: boolean; preempt: boolean }[] = [];
    const engine = engineOf(async function* (segments, options) {
      seen.push({
        text: segments[0]?.text ?? '',
        priority: options.priority,
        eager: options.eager === true,
        preempt: options.preempt === true,
      });
      const id = segments[0]?.id ?? 'b1';
      yield { id, final: '訳' };
    });
    const session = sessionOf(engine, { concurrency: 8 });
    const later = layoutOf('A later page paragraph of source text for the scheduler.');
    const labelLayout = layoutOf('Abstract');
    const label = labelLayout.blocks[0];
    if (!label) throw new Error('expected a label block');
    labelLayout.blocks[0] = { ...label, role: 'label', text: 'Abstract' };
    session.addPage(2, later);
    session.addPage(0, labelLayout);
    await waitFor(() => seen.length >= 2);
    const focus = seen.find((entry) => entry.text === 'Abstract');
    const other = seen.find((entry) => entry.text.startsWith('A later page'));
    expect(focus).toBeDefined();
    expect(other).toBeDefined();
    expect(focus?.priority ?? 0).toBeLessThan(other?.priority ?? 0);
    expect(focus?.eager).toBe(true);
    expect(focus?.preempt).toBe(true);
    expect(other?.eager).toBe(false);
    expect(focus?.priority ?? 0).toBeGreaterThanOrEqual(0);
    expect(focus?.priority ?? 0).toBeLessThanOrEqual(MAX_PRIORITY);
    expect(other?.priority ?? 0).toBeGreaterThanOrEqual(0);
    expect(other?.priority ?? 0).toBeLessThanOrEqual(MAX_PRIORITY);
  });
});

describe('PDF request priority', () => {
  it('covers every block role', () => {
    expect(PDF_PRIORITY_ROLES).toEqual([
      'heading',
      'prose',
      'caption',
      'cell',
      'label',
      'equation',
      'figure-label',
      'code',
      'furniture',
      'identity',
    ]);
  });

  it('stays inside 0..MAX_PRIORITY for every distance and role', () => {
    const options = serializeTranslateOptions({
      tgt: 'ja',
      form: 'polite',
      priority: 0,
      signal: new AbortController().signal,
    });
    for (let distance = 0; distance <= 50; distance += 1) {
      for (const role of PDF_PRIORITY_ROLES) {
        const priority = pdfRequestPriority(distance, role);
        expect(priority, `${role} d=${String(distance)}`).toBeGreaterThanOrEqual(0);
        expect(priority, `${role} d=${String(distance)}`).toBeLessThanOrEqual(MAX_PRIORITY);
        expect(
          isEngineHostRequest({
            type: 'translate',
            requestId: 'r1',
            segments: [{ id: 'a', text: 'Hello.' }],
            options: { ...options, priority },
          }),
          `${role} d=${String(distance)} p=${String(priority)}`,
        ).toBe(true);
      }
    }
  });

  it('keeps a nearer page ahead of a farther one', () => {
    expect(pdfRequestPriority(0, 'label')).toBeLessThan(pdfRequestPriority(1, 'prose'));
    expect(pdfRequestPriority(1, 'heading')).toBeLessThan(pdfRequestPriority(2, 'caption'));
    expect(pdfRequestPriority(0, 'prose')).toBeLessThan(pdfRequestPriority(9, 'heading'));
    expect(pdfRequestPriority(0, 'prose')).toBeLessThan(pdfRequestPriority(50, 'prose'));
  });

  it('treats a non-finite distance as the focused page', () => {
    const options = serializeTranslateOptions({
      tgt: 'ja',
      form: 'polite',
      priority: 0,
      signal: new AbortController().signal,
    });
    for (const distance of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const priority = pdfRequestPriority(distance, 'prose');
      expect(priority).toBe(pdfRequestPriority(0, 'prose'));
      expect(priority).toBeGreaterThanOrEqual(0);
      expect(priority).toBeLessThanOrEqual(MAX_PRIORITY);
      expect(
        isEngineHostRequest({
          type: 'translate',
          requestId: 'r1',
          segments: [{ id: 'a', text: 'Hello.' }],
          options: { ...options, priority },
        }),
      ).toBe(true);
    }
  });
});

describe('isPdfBlockSettled', () => {
  it('treats done with empty text and failed as finished, not a running stream', () => {
    expect(isPdfBlockSettled({ state: 'done' })).toBe(true);
    expect(isPdfBlockSettled({ state: 'failed' })).toBe(true);
    expect(isPdfBlockSettled({ state: 'running' })).toBe(false);
    expect(isPdfBlockSettled({ state: 'queued' })).toBe(false);
    expect(isPdfBlockSettled({ state: 'idle' })).toBe(false);
  });
});
