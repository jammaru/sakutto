import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChromeTranslatorEngine } from '@/engine/chrome/translator';
import { prepareTranslatorPack } from '@/shared/translator-pack';

interface PackOptions {
  sourceLanguage: string;
  targetLanguage: string;
  monitor?: (monitor: EventTarget) => void;
}

function installTranslator(packs: Set<string>) {
  const created: PackOptions[] = [];
  const destroy = vi.fn();
  const key = (options: { sourceLanguage: string; targetLanguage: string }): string =>
    `${options.sourceLanguage}|${options.targetLanguage}`;

  vi.stubGlobal('Translator', {
    availability: async (options: { sourceLanguage: string; targetLanguage: string }) =>
      packs.has(key(options)) ? 'available' : 'downloadable',
    create: async (options: PackOptions) => {
      created.push(options);
      packs.add(key(options));
      return { destroy };
    },
  });

  return { created, destroy };
}

describe('translator language packs', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('creates the pair from a gesture and makes it available to the engine', async () => {
    const packs = new Set<string>();
    const { created, destroy } = installTranslator(packs);
    const monitor = vi.fn();

    const status = await prepareTranslatorPack('en-US', 'ja-JP', { monitor });

    expect(status).toBe('available');
    expect(created).toEqual([{ sourceLanguage: 'en', targetLanguage: 'ja', monitor }]);
    expect(destroy).toHaveBeenCalledOnce();

    const engine = new ChromeTranslatorEngine();
    await expect(engine.availability('en-US', 'ja-JP')).resolves.toBe('available');
  });

  it('stays available when the pack is already installed', async () => {
    const packs = new Set(['en|ja']);
    const { created } = installTranslator(packs);

    await expect(prepareTranslatorPack('en', 'ja')).resolves.toBe('available');
    expect(created).toEqual([{ sourceLanguage: 'en', targetLanguage: 'ja' }]);
  });

  it('calls create before availability resolves', async () => {
    let installed = false;
    let createdDuringAvailability = false;
    vi.stubGlobal('Translator', {
      availability: () =>
        new Promise((resolve) => {
          setTimeout(() => resolve(installed ? 'available' : 'downloadable'), 0);
        }),
      create: () => {
        createdDuringAvailability = true;
        installed = true;
        return Promise.resolve({ destroy: () => undefined });
      },
    });

    const pending = prepareTranslatorPack('en', 'ja');
    expect(createdDuringAvailability).toBe(true);
    await expect(pending).resolves.toBe('available');
  });

  it('does not create the same installed pair again', async () => {
    const packs = new Set<string>();
    const { created } = installTranslator(packs);

    await expect(prepareTranslatorPack('en', 'ja')).resolves.toBe('available');
    await expect(prepareTranslatorPack('en', 'ja')).resolves.toBe('available');

    expect(created).toHaveLength(1);
  });

  it('shares one create call between concurrent onboarding clicks', async () => {
    const packs = new Set<string>();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const create = vi.fn(async (options: PackOptions) => {
      await gate;
      packs.add(`${options.sourceLanguage}|${options.targetLanguage}`);
      return { destroy: () => undefined };
    });
    vi.stubGlobal('Translator', {
      availability: async (options: PackOptions) =>
        packs.has(`${options.sourceLanguage}|${options.targetLanguage}`)
          ? 'available'
          : 'downloadable',
      create,
    });

    const first = prepareTranslatorPack('en', 'ja');
    const second = prepareTranslatorPack('en', 'ja');
    release?.();

    await expect(Promise.all([first, second])).resolves.toEqual(['available', 'available']);
    expect(create).toHaveBeenCalledOnce();
  });

  it('handles a synchronous service-limit error without throwing out of onboarding', async () => {
    vi.stubGlobal('Translator', {
      availability: async () => 'downloadable',
      create: () => {
        throw new Error('The translation service count exceeded the limitation.');
      },
    });

    await expect(prepareTranslatorPack('en', 'ja')).resolves.toBe('unavailable');
  });

  it('turns an asynchronous create rejection into a handled unavailable result', async () => {
    vi.stubGlobal('Translator', {
      availability: async () => 'downloadable',
      create: async () => {
        throw new Error('The translation service count exceeded the limitation.');
      },
    });

    await expect(prepareTranslatorPack('en', 'ja')).resolves.toBe('unavailable');
  });

  it('reports unavailable without the built-in translator', async () => {
    vi.stubGlobal('Translator', undefined);
    await expect(prepareTranslatorPack('en', 'ja')).resolves.toBe('unavailable');
  });
});
