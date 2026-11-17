// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PICKER_CANCEL_FALLBACK_MS,
  pickDirectoryFiles,
  supportsDirectoryPickerCancel,
} from '@/ui/folder-input';

function installFiles(input: HTMLInputElement, paths: string[]): void {
  const files = paths.map((relativePath) => {
    const name = relativePath.split('/').pop() ?? relativePath;
    const file = new File([new Uint8Array([1])], name);
    Object.defineProperty(file, 'webkitRelativePath', { value: relativePath });
    return file;
  });
  Object.defineProperty(input, 'files', {
    configurable: true,
    get: () => ({
      length: files.length,
      item: (index: number) => files[index] ?? null,
      [Symbol.iterator]: function* () {
        yield* files;
      },
    }),
  });
}

describe('pickDirectoryFiles', () => {
  let input: HTMLInputElement;

  beforeEach(() => {
    vi.useFakeTimers();
    input = document.createElement('input');
    input.type = 'file';
    Object.defineProperty(input, 'click', { value: () => undefined });
    Object.defineProperty(input, 'value', { writable: true, value: '' });
    Object.defineProperty(HTMLInputElement.prototype, 'oncancel', {
      configurable: true,
      value: null,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('waits for change when the picker supports cancel and files arrive late', async () => {
    expect(supportsDirectoryPickerCancel()).toBe(true);
    const onAwaitingFiles = vi.fn();
    const promise = pickDirectoryFiles(input, window, { onAwaitingFiles });
    window.dispatchEvent(new Event('focus'));
    expect(onAwaitingFiles).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(5000);
    installFiles(input, ['sakutto/sakutto-models/plamo-test.gguf']);
    input.dispatchEvent(new Event('change'));

    const files = await promise;
    expect(files).toHaveLength(1);
    expect(files?.[0]?.name).toBe('plamo-test.gguf');
  });

  it('resolves null when the picker cancel event fires', async () => {
    const promise = pickDirectoryFiles(input, window);
    input.dispatchEvent(new Event('cancel'));
    await expect(promise).resolves.toBeNull();
  });

  it('does not resolve on focus alone when cancel is supported', async () => {
    const promise = pickDirectoryFiles(input, window);
    window.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(60_000);
    let settled = false;
    void promise.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    installFiles(input, ['sakutto/model.gguf']);
    input.dispatchEvent(new Event('change'));
    await promise;
  });

  it('uses a long fallback when cancel is not supported', async () => {
    const promise = pickDirectoryFiles(input, window, { supportsCancel: false });
    window.dispatchEvent(new Event('focus'));
    installFiles(input, ['sakutto/sakutto-models/plamo-test.gguf']);
    await vi.advanceTimersByTimeAsync(PICKER_CANCEL_FALLBACK_MS);

    const files = await promise;
    expect(files).toHaveLength(1);
  });
});
