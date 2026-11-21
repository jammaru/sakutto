import { describe, expect, it, vi } from 'vitest';
import { OcrRecognitionRequests } from '@/background/ocr-requests';

describe('OcrRecognitionRequests', () => {
  it('does not preempt another caller on the same tier', () => {
    const requests = new OcrRecognitionRequests();
    const first = requests.start('reader-a', 'standard');
    const second = requests.start('reader-b', 'standard');
    if (!first || !second) throw new Error('controllers were not created');
    const firstAbort = vi.fn();
    first.signal.addEventListener('abort', firstAbort);

    requests.cancel('standard', 'reader-b');

    expect(firstAbort).not.toHaveBeenCalled();
    expect(first.signal.aborted).toBe(false);
    expect(second.signal.aborted).toBe(true);
  });

  it('does not let stale cleanup unregister a newer request', () => {
    const requests = new OcrRecognitionRequests();
    const old = requests.start('request', 'standard');
    if (!old) throw new Error('old controller was not created');
    requests.cancel('standard', 'request');
    const current = requests.start('request', 'standard');
    if (!current) throw new Error('new controller was not created');

    requests.finish('request', old);
    requests.cancel('standard', 'request');

    expect(current.signal.aborted).toBe(true);
  });

  it('rejects duplicate identities instead of aborting the incumbent', () => {
    const requests = new OcrRecognitionRequests();
    const first = requests.start('same-id', 'high');
    expect(requests.start('same-id', 'high')).toBeNull();
    expect(first?.signal.aborted).toBe(false);
  });
});
