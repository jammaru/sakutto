import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProgressTimeout } from '@/shared/progress-timeout';

afterEach(() => {
  vi.useRealTimers();
});

describe('progress timeout', () => {
  it('resets the stall deadline while the loader keeps reporting progress', async () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn(() => new Error('timeout'));
    const timeout = createProgressTimeout({ stallMs: 1000, maxMs: 10_000, onTimeout });

    await vi.advanceTimersByTimeAsync(900);
    timeout.progress();
    await vi.advanceTimersByTimeAsync(900);
    expect(onTimeout).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(200);
    await expect(timeout.expired).rejects.toThrow('timeout');
    expect(onTimeout).toHaveBeenCalledWith('stall');
    timeout.stop();
  });

  it('still enforces an absolute cap when progress never stops', async () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn(() => new Error('max'));
    const timeout = createProgressTimeout({ stallMs: 1000, maxMs: 3000, onTimeout });

    for (let elapsed = 0; elapsed < 2500; elapsed += 500) {
      timeout.progress();
      await vi.advanceTimersByTimeAsync(500);
    }
    expect(onTimeout).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(500);
    await expect(timeout.expired).rejects.toThrow('max');
    expect(onTimeout).toHaveBeenCalledWith('max');
    timeout.stop();
  });

  it('does not fire after the load wins', async () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn(() => new Error('timeout'));
    const timeout = createProgressTimeout({ stallMs: 1000, maxMs: 2000, onTimeout });

    timeout.stop();
    await vi.advanceTimersByTimeAsync(3000);

    expect(onTimeout).not.toHaveBeenCalled();
  });
});
