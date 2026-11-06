import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { vi } from 'vitest';
import { PageSession, type SessionPreferences } from '@/dom/session';
import { InBrowserEngine } from '@/engine/in-browser/engine';
import { SimRuntime, type SimCosts } from './sim-runtime';

export const flowLabels = {
  original: '原文',
  chromeNote: 'Chrome の内蔵翻訳',
  machine: 'PLaMo による機械翻訳です。',
  selectionPending: '翻訳しています…',
  selectionFailed: 'この選択範囲を翻訳できませんでした。',
  selectionTitle: '選択したテキスト',
  selectionIcon: '選択したテキストを翻訳します',
  close: '閉じる',
  bilingualOn: 'このサイトの表示を対訳にしました。',
  replaceOn: 'このサイトの表示を置換にしました。',
  barLabel: '翻訳の進み具合',
  barProgress: (done: number, total: number) => `翻訳中 ${String(done)} / ${String(total)}`,
  barRate: (tokens: string, segments: string) => `${tokens} tok/s · ${segments} 区間/s`,
  barDone: '翻訳しました。',
  barPartial: (blocks: number) => `翻訳できない箇所が ${String(blocks)} 件残っています。`,
  barOriginal: '原文に戻す',
  barAlways: 'このサイトを常に翻訳します',
  barAlwaysOn: 'このサイトは常に翻訳します。',
};

/** The `<body>` of a bench page, so a unit test and the browser bench read the same markup. */
export function benchBody(file: string): string {
  const html = readFileSync(join(process.cwd(), 'bench', 'pages', file), 'utf8');
  return /<body>([\s\S]*)<\/body>/u.exec(html)?.[1] ?? '';
}

const ROW_PX = 22;

/**
 * happy-dom has no layout, so every box is 0×0 and lands in the `far` band. This lays the
 * document out as one column in tree order, which is enough for "the first screen" to mean
 * the first blocks of the page.
 */
export function stackLayout(doc: Document): () => void {
  const order = new Map<Element, number>();
  let index = 0;
  for (const element of doc.body.querySelectorAll('*')) order.set(element, index++);
  const original = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const at = order.get(this);
    if (at === undefined) return original.call(this);
    return new DOMRect(0, at * ROW_PX, 640, ROW_PX);
  };
  return () => {
    Element.prototype.getBoundingClientRect = original;
  };
}

export interface FlowResult {
  /** Virtual milliseconds from Start to the first translated character on screen. */
  firstPaintMs: number;
  /** Virtual milliseconds until every block of the first screen is final. */
  firstScreenMs: number;
  totalMs: number;
  /** Longest stretch with no change on the page, between the first paint and the end. */
  longestStillMs: number;
  /** Longest stretch, while a request was in flight, in which the bar showed no tok/s. */
  longestRatelessMs: number;
  prompts: string[];
  /** Bar texts seen while work was pending, for a failure message. */
  bars: string[];
}

const STEP_MS = 50;

/**
 * Translates the current document with the real session and engine on a simulated device,
 * advancing a fake clock and noting every visible change.
 */
export async function runFlow(input: {
  costs: SimCosts;
  tier: 'g' | 'c8' | 'c4';
  firstScreen: readonly string[];
  limitMs?: number;
  translate?: (source: string) => string;
}): Promise<FlowResult> {
  const runtime = new SimRuntime(input.costs, input.translate);
  const engine = new InBrowserEngine(runtime, {
    contextTokens: 2048,
  });
  const preferences: SessionPreferences = {
    targetLanguage: 'ja',
    targetExplicit: true,
    form: 'polite',
    display: 'replace',
    auto: 'ask',
    host: 'example.com',
    context: false,
    tier: input.tier,
    pace: 'quality',
  };
  const session = new PageSession(document, {
    engine,
    labels: flowLabels,
    preferences,
    scheduleFrame: (callback) => callback(),
    debounceMs: 20,
  });

  const started = performance.now();
  void session.translate();

  let last = document.body.textContent ?? '';
  let lastChange = started;
  let firstPaint: number | null = null;
  let firstScreen: number | null = null;
  let longestStill = 0;
  let ratelessSince: number | null = null;
  let longestRateless = 0;
  let measured = false;
  const bars: string[] = [];
  const limit = input.limitMs ?? 600_000;

  for (;;) {
    await vi.advanceTimersByTimeAsync(STEP_MS);
    const now = performance.now();
    const text = document.body.textContent ?? '';
    if (text !== last) {
      if (firstPaint !== null) longestStill = Math.max(longestStill, now - lastChange);
      if (firstPaint === null && text.includes('訳')) firstPaint = now;
      last = text;
      lastChange = now;
    }

    if (firstScreen === null) {
      const ready = input.firstScreen.every((id) => {
        const block = document.querySelector(`[data-bench-id="${id}"]`);
        return (
          block !== null &&
          block.hasAttribute('data-sakutto-id') &&
          !block.hasAttribute('data-sakutto-pending') &&
          (block.textContent ?? '').includes('訳')
        );
      });
      if (ready) firstScreen = now;
    }

    const view = session.state();
    if (view.tokensPerSecond !== null) measured = true;
    if (view.pending > 0) {
      const bar = document.querySelector('sakutto-bar');
      bars.push(bar?.shadowRoot?.textContent ?? bar?.textContent ?? '');
      if (measured && view.tokensPerSecond === null) {
        ratelessSince ??= now;
        longestRateless = Math.max(longestRateless, now - ratelessSince);
      } else {
        ratelessSince = null;
      }
    }

    if (view.pending === 0 && view.total > 0 && now - started > STEP_MS * 2) break;
    if (now - started > limit) throw new Error(`the page did not finish in ${String(limit)} ms`);
  }

  const end = performance.now();
  session.dispose();
  return {
    firstPaintMs: (firstPaint ?? end) - started,
    firstScreenMs: (firstScreen ?? end) - started,
    totalMs: end - started,
    longestStillMs: longestStill,
    longestRatelessMs: longestRateless,
    prompts: runtime.prompts,
    bars,
  };
}
