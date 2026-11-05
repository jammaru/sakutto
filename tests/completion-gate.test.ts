import { describe, expect, it } from 'vitest';
import { CompletionGate, forwardCompletionToken } from '@/engine/in-browser/runtime';

describe('completion gate', () => {
  it('waits for the current completion before starting the next one', async () => {
    const gate = new CompletionGate();
    let release!: () => void;
    let started = false;
    const first = gate.exclusive(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const second = gate.exclusive(async () => {
      started = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(started).toBe(false);
    release();
    await first;
    await second;
    expect(started).toBe(true);
  });

  it('runs as many completions as the slot count', async () => {
    const gate = new CompletionGate(2);
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    let started = 0;
    const first = gate.exclusive(
      () =>
        new Promise<void>((resolve) => {
          started += 1;
          releaseFirst = resolve;
        }),
    );
    const second = gate.exclusive(
      () =>
        new Promise<void>((resolve) => {
          started += 1;
          releaseSecond = resolve;
        }),
    );
    const third = gate.exclusive(async () => {
      started += 1;
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(started).toBe(2);
    releaseFirst();
    releaseSecond();
    await first;
    await second;
    await third;
    expect(started).toBe(3);
  });

  it('opens the gate when the current completion fails', async () => {
    const gate = new CompletionGate();
    const order: string[] = [];
    const first = gate.exclusive(async () => {
      order.push('first');
      throw new Error('fail');
    });
    const second = gate.exclusive(async () => {
      order.push('second');
    });

    await expect(first).rejects.toThrow('fail');
    await second;
    expect(order).toEqual(['first', 'second']);
  });

  it('drops tokens that arrive after abort', () => {
    const seen: string[] = [];
    const accept = (text: string): void => {
      seen.push(text);
    };
    forwardCompletionToken(AbortSignal.abort(), 'late', accept);
    forwardCompletionToken(new AbortController().signal, '', accept);
    forwardCompletionToken(new AbortController().signal, 'ok', accept);
    expect(seen).toEqual(['ok']);
  });
});
