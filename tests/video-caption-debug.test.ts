import { afterEach, describe, expect, it, vi } from 'vitest';
import { captionDebug } from '@/captions/debug';

describe('caption debug log', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('stays silent unless localStorage.sakuttoCaptionDebug is 1', () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    const store: Record<string, string> = {};
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, value: string) => {
        store[key] = value;
      },
    });
    captionDebug('x-load', { cueCount: 0 });
    expect(debug).not.toHaveBeenCalled();
    store.sakuttoCaptionDebug = '1';
    captionDebug('x-load', { cueCount: 0 });
    expect(debug).toHaveBeenCalledWith('[sakutto-captions]', 'x-load', { cueCount: 0 });
  });
});
