import { describe, expect, it } from 'vitest';
import type { LayoutBlock, PageLayout } from '@/pdf/layout';
import { PdfSession, type PdfEngine } from '@/pdf/session';
import type { TranslationChunk } from '@/engine/types';

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

function sessionOf(engine: PdfEngine): PdfSession {
  return new PdfSession({
    engine,
    targetLanguage: 'ja',
    form: 'polite',
    onChange: () => undefined,
    measure: (text, size) => text.length * size * 0.5,
    concurrency: 1,
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
  translate: (segments: { id: string; text: string }[]) => AsyncIterable<TranslationChunk>,
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
});
