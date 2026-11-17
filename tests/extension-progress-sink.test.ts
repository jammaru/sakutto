import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  broadcastRuntimeMessage: vi.fn(async () => undefined),
  readRuntimeLastError: vi.fn(),
  query: vi.fn(),
  sendMessage: vi.fn(),
  getURL: vi.fn((path: string) => `https://fake.ext${path}`),
}));

vi.mock('wxt/browser', () => ({
  browser: {
    runtime: {
      getURL: (path: string) => mocks.getURL(path),
    },
    tabs: { query: mocks.query, sendMessage: mocks.sendMessage },
  },
}));

vi.mock('@/shared/runtime-last-error', () => ({
  broadcastRuntimeMessage: mocks.broadcastRuntimeMessage,
  readRuntimeLastError: mocks.readRuntimeLastError,
}));

import { sendExtensionModelProgress } from '@/background/extension-progress-sink';

describe('sendExtensionModelProgress', () => {
  it('reaches non-tab extension listeners via runtime.sendMessage', async () => {
    mocks.broadcastRuntimeMessage.mockClear();
    mocks.query.mockResolvedValue([]);
    const item = { type: 'model:progress' };
    await sendExtensionModelProgress(item);
    expect(mocks.broadcastRuntimeMessage).toHaveBeenCalledWith(item);
    expect(mocks.getURL).toHaveBeenCalledWith('/');
    expect(mocks.query).toHaveBeenCalledWith({ url: 'https://fake.ext/*' });
  });

  it('also delivers to extension UI tabs and clears lastError', async () => {
    mocks.broadcastRuntimeMessage.mockClear();
    mocks.readRuntimeLastError.mockClear();
    mocks.sendMessage.mockResolvedValue(undefined);
    mocks.query.mockResolvedValue([{ id: 9, url: 'https://fake.ext/onboarding.html' }]);
    await sendExtensionModelProgress({ type: 'model:progress' });
    expect(mocks.sendMessage).toHaveBeenCalledWith(9, { type: 'model:progress' });
    expect(mocks.readRuntimeLastError).toHaveBeenCalled();
  });
});

describe('background progress delivery source', () => {
  it('does not hardcode chrome-extension for extension page delivery', () => {
    const background = readFileSync('src/entrypoints/background.ts', 'utf8');
    expect(background).not.toMatch(/chrome-extension:\/\//);
    expect(background).toContain('sendExtensionModelProgress');
  });
});
