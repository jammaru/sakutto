// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

const session = vi.hoisted(() => ({ writes: 0, urls: [] as string[] }));

vi.mock('wxt/browser', () => ({
  browser: {
    runtime: {
      getURL: (path: string) => {
        session.urls.push(path);
        return 'about:blank';
      },
    },
    storage: {
      session: {
        set: async () => {
          session.writes += 1;
        },
      },
    },
  },
}));

const { createFirefoxEngineFrameApi } = await import('@/background/firefox-engine-frame');
const { createEngineHostController } = await import('@/background/engine-host-document');
const { isFirefoxBuild } = await import('@/shared/browser');

let api: ReturnType<typeof createFirefoxEngineFrameApi> | null = null;

afterEach(async () => {
  await api?.closeDocument();
  api = null;
  document.documentElement.replaceChildren();
  session.writes = 0;
  session.urls.length = 0;
});

describe('Firefox engine frame', () => {
  it('mounts offscreen.html as an iframe and treats load as the document', async () => {
    api = createFirefoxEngineFrameApi();
    expect(await api.hasDocument()).toBe(false);

    const pending = api.createDocument();
    await Promise.resolve();
    const frame = document.getElementById('sakutto-engine-frame') as HTMLIFrameElement | null;
    expect(frame).not.toBeNull();
    expect(session.urls.some((path) => path.includes('offscreen.html'))).toBe(true);
    frame?.dispatchEvent(new Event('load'));
    await pending;
    expect(await api.hasDocument()).toBe(true);
    expect(session.writes).toBeGreaterThan(0);

    await api.closeDocument();
    expect(document.getElementById('sakutto-engine-frame')).toBeNull();
    expect(await api.hasDocument()).toBe(false);
  });

  it('keeps Chrome as the default engine-host controller in unit tests', () => {
    expect(isFirefoxBuild()).toBe(false);
    expect(createEngineHostController()).toBeDefined();
  });
});
