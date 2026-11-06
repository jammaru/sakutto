import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { checkModelPin, checkModelPins, type ModelPinTarget } from '../scripts/check-model-pins';

const TARGET: ModelPinTarget = {
  id: 'plamo-3-translate-0.8b-q4_k_m',
  url: 'https://huggingface.co/example/model.gguf',
  size: 12,
};

function response(status: number, headers: Record<string, string> = {}): Response {
  return new Response(new Uint8Array([0]), { status, headers });
}

describe('pinned model URL check', () => {
  it('accepts a range response whose total matches the pin', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      response(206, { 'content-range': 'bytes 0-0/12' }),
    );

    await expect(checkModelPin(TARGET, fetchImpl)).resolves.toBeUndefined();
    const init = fetchImpl.mock.calls[0]?.[1];
    expect(init?.headers).toEqual({ Range: 'bytes=0-0' });
    expect(init?.redirect).toBe('follow');
  });

  it('accepts a full response only when its length matches the pin', async () => {
    await expect(
      checkModelPin(TARGET, async () => response(200, { 'content-length': '12' })),
    ).resolves.toBeUndefined();
    await expect(
      checkModelPin(TARGET, async () => response(200, { 'content-length': '11' })),
    ).rejects.toThrow(/pinned size is 12/);
  });

  it('names an HTTP 403 and keeps checking the other pin', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith('/missing.gguf')) return response(403);
      return response(206, { 'content-range': 'bytes 0-0/12' });
    });
    const second: ModelPinTarget = { ...TARGET, id: 'second', url: 'https://example.test/ok.gguf' };

    await expect(
      checkModelPins([{ ...TARGET, url: 'https://example.test/missing.gguf' }, second], fetchImpl),
    ).rejects.toThrow(/HTTP 403/);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('rejects a range whose total does not match the pin', async () => {
    await expect(
      checkModelPin(TARGET, async () => response(206, { 'content-range': 'bytes 0-0/99' })),
    ).rejects.toThrow(/is 99 bytes/);
  });

  it('runs from the pull request and the daily schedule', () => {
    const workflow = readFileSync(
      new URL('../.github/workflows/model-pins.yml', import.meta.url),
      'utf8',
    );
    expect(workflow).toContain('pull_request:');
    expect(workflow).toContain('schedule:');
    expect(workflow).toContain('node scripts/check-model-pins.ts');
    expect(workflow).not.toContain('pnpm bench');
  });
});
