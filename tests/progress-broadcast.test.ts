import { describe, expect, it } from 'vitest';
import {
  broadcastModelProgress,
  shouldWarmDownloadedModel,
  type ProgressSink,
  type ProgressTab,
} from '@/background/progress-broadcast';
import type { ModelStatus } from '@/shared/engine-status';
import type { ModelProgressMessage } from '@/shared/messages';

function status(
  state: ModelStatus['state'],
  id: ModelStatus['id'] = 'plamo-3-translate-0.8b-q4_k_m',
): ModelStatus {
  return { id, state, received: 10, total: 10, progress: 1 };
}

function message(state: ModelStatus['state']): ModelProgressMessage {
  return { type: 'model:progress', status: status(state) };
}

function sink(tabs: readonly ProgressTab[]): ProgressSink & {
  extension: ModelProgressMessage[];
  pages: Array<{ tabId: number; message: ModelProgressMessage }>;
} {
  const extension: ModelProgressMessage[] = [];
  const pages: Array<{ tabId: number; message: ModelProgressMessage }> = [];
  return {
    extension,
    pages,
    sendExtension: async (item) => {
      extension.push(item);
    },
    listTabs: async () => tabs,
    sendTab: async (tabId, item) => {
      pages.push({ tabId, message: item });
    },
  };
}

describe('broadcastModelProgress', () => {
  it('tells open pages when the model is loaded', async () => {
    const target = sink([
      { id: 1, url: 'https://example.com/a' },
      { id: 2, url: 'http://127.0.0.1/article.html' },
      { id: 3, url: 'chrome://extensions' },
      { url: 'https://example.com/missing' },
    ]);

    await broadcastModelProgress(message('loaded'), target);

    expect(target.extension).toHaveLength(1);
    expect(target.pages.map((page) => page.tabId)).toEqual([1, 2]);
  });

  it('keeps download progress on the extension pages', async () => {
    const target = sink([{ id: 1, url: 'https://example.com/a' }]);
    await broadcastModelProgress(message('downloading'), target);
    expect(target.extension).toHaveLength(1);
    expect(target.pages).toEqual([]);
  });

  it('still reaches pages when no extension page is open', async () => {
    const target = sink([{ id: 4, url: 'https://example.com/a' }]);
    target.sendExtension = () => Promise.reject(new Error('closed'));
    await broadcastModelProgress(message('loaded'), target);
    expect(target.pages).toHaveLength(1);
  });
});

describe('shouldWarmDownloadedModel', () => {
  it('warms the model that just became ready', () => {
    expect(shouldWarmDownloadedModel(status('ready'), status('ready'))).toBe(true);
    expect(shouldWarmDownloadedModel(status('ready'), status('loaded'))).toBe(false);
    expect(
      shouldWarmDownloadedModel(status('ready', 'plamo-3-translate-2b-q4_k_m'), status('ready')),
    ).toBe(false);
    expect(shouldWarmDownloadedModel(status('ready'), null)).toBe(false);
  });
});
