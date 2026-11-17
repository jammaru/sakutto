// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pickDirectoryFiles } from '@/ui/folder-input';

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
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not treat Firefox upload confirmation as a cancel when change follows focus', async () => {
    const promise = pickDirectoryFiles(input, window);
    window.dispatchEvent(new Event('focus'));
    installFiles(input, ['sakutto/sakutto-models/plamo-test.gguf']);
    input.dispatchEvent(new Event('change'));

    const files = await promise;
    expect(files).toHaveLength(1);
    expect(files?.[0]?.name).toBe('plamo-test.gguf');
  });

  it('resolves with files when only focus fires after the upload dialog', async () => {
    const promise = pickDirectoryFiles(input, window);
    window.dispatchEvent(new Event('focus'));
    installFiles(input, ['sakutto/sakutto-models/plamo-test.gguf']);
    await vi.advanceTimersByTimeAsync(800);

    const files = await promise;
    expect(files).toHaveLength(1);
    expect((files?.[0] as File & { webkitRelativePath?: string }).webkitRelativePath).toBe(
      'sakutto/sakutto-models/plamo-test.gguf',
    );
  });

  it('resolves null when focus returns with no files selected', async () => {
    Object.defineProperty(input, 'files', { configurable: true, value: null });
    const promise = pickDirectoryFiles(input, window);
    window.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(800);

    await expect(promise).resolves.toBeNull();
  });
});