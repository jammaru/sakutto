import { describe, expect, it } from 'vitest';
import { isAllowedRequest } from '../e2e/extension';

describe('extension network allowlist', () => {
  it('allows the Hugging Face redirect used by the pinned model', () => {
    expect(
      isAllowedRequest(
        'https://huggingface.co/pfnet/plamo-3-translate-0.8b-GGUF/resolve/dbeb0856cb0b004b484f190bb71dd65876297013/plamo-3-translate-0.8b-Q4_K_M.gguf',
      ),
    ).toBe(true);
    expect(isAllowedRequest('https://us.aws.cdn.hf.co/xet-bridge-us/file')).toBe(true);
    expect(isAllowedRequest('https://cdn-lfs-us-1.hf.co/repos/file')).toBe(true);
    expect(isAllowedRequest('https://cdn-lfs.huggingface.co/repos/file')).toBe(true);
    expect(isAllowedRequest('https://example.com/model.gguf')).toBe(false);
  });
});
