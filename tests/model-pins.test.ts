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
    expect(init?.redirect).toBe('manual');
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

  it('retries a 500 and then accepts the pin', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(500))
      .mockResolvedValueOnce(response(206, { 'content-range': 'bytes 0-0/12' }));

    await expect(
      checkModelPin(TARGET, fetchImpl, { retries: 2, sleep: async () => undefined }),
    ).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('does not retry HTTP 403', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => response(403));
    await expect(
      checkModelPin(TARGET, fetchImpl, { retries: 2, sleep: async () => undefined }),
    ).rejects.toThrow(/HTTP 403/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
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
    expect(workflow).toContain('types: [opened, synchronize, reopened, ready_for_review]');
    expect(workflow).toContain('schedule:');
    expect(workflow).toContain('node scripts/check-model-pins.ts');
    expect(workflow).not.toContain('pnpm bench');
    expect(workflow).not.toContain('github.event.pull_request.draft == false');
  });
});

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

describe('upstream revision check', () => {
  it('reads the sha256 from the huggingface.co redirect, not the CDN ETag', async () => {
    const target: ModelPinTarget = {
      ...TARGET,
      revisions: [{ size: 12, sha256: SHA_A }],
    };
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      response(302, {
        location: 'https://cdn.example.test/blob',
        'x-linked-size': '12',
        'x-linked-etag': `"${SHA_A}"`,
        etag: '"cdn-only-xet-hash"',
      }),
    );

    await expect(checkModelPin(target, fetchImpl)).resolves.toBeUndefined();
  });

  it('accepts a quoted X-Linked-ETag and X-Linked-Size of a known revision', async () => {
    const target: ModelPinTarget = {
      ...TARGET,
      revisions: [{ size: 12, sha256: SHA_A }],
    };
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      response(206, {
        'x-linked-size': '12',
        'x-linked-etag': `"${SHA_A}"`,
        'content-range': 'bytes 0-0/99',
      }),
    );

    await expect(checkModelPin(target, fetchImpl)).resolves.toBeUndefined();
  });

  it('fails when the upstream hash is missing from the catalog', async () => {
    const target: ModelPinTarget = {
      ...TARGET,
      revisions: [{ size: 12, sha256: SHA_A }],
    };
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      response(206, { 'x-linked-size': '12', 'x-linked-etag': `"${SHA_B}"` }),
    );

    await expect(checkModelPin(target, fetchImpl)).rejects.toThrow(/not in the catalog/);
  });

  it('fails when the upstream size matches no known revision', async () => {
    const target: ModelPinTarget = {
      ...TARGET,
      revisions: [{ size: 12, sha256: SHA_A }],
    };
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      response(206, { 'x-linked-size': '14', 'x-linked-etag': `"${SHA_A}"` }),
    );

    await expect(checkModelPin(target, fetchImpl)).rejects.toThrow(/pinned size is 12/);
  });

  it('points every catalog target at resolve/main and checks all known revisions', async () => {
    const { pinnedModelTargets } = await import('../scripts/check-model-pins');
    const targets = pinnedModelTargets();
    expect(targets).toHaveLength(2);
    for (const target of targets) {
      expect(target.url).toContain('/resolve/main/');
      expect(target.revisions?.length).toBeGreaterThanOrEqual(2);
    }

    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const target = targets.find((item) => item.url === String(input));
      const revision = target?.revisions?.[0];
      if (!revision) throw new Error(`unexpected URL ${String(input)}`);
      return response(206, {
        'x-linked-size': String(revision.size),
        'x-linked-etag': `"${revision.sha256}"`,
      });
    });

    await expect(checkModelPins(targets, fetchImpl)).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(targets.length);
  });
});
