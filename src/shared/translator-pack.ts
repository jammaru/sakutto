import { canonicalChromeLanguage, toChromeLanguage } from './languages';

export type TranslatorAvailability = 'unavailable' | 'downloadable' | 'downloading' | 'available';

export interface LanguagePair {
  sourceLanguage: string;
  targetLanguage: string;
}

export interface TranslatorPackInstance {
  destroy?(): void;
}

export interface TranslatorConstructor<
  Instance extends TranslatorPackInstance = TranslatorPackInstance,
> {
  availability(pair: LanguagePair): Promise<TranslatorAvailability>;
  create(options: LanguagePair & { monitor?: (monitor: EventTarget) => void }): Promise<Instance>;
}

interface TranslatorScope {
  Translator?: TranslatorConstructor;
}

export function getTranslatorConstructor(): TranslatorConstructor | null {
  const scope = globalThis as TranslatorScope;
  return scope.Translator ?? null;
}

/**
 * Installs the built-in translator language pack for a pair. Chrome requires a user gesture
 * for `create`, so this must run from a click handler in an extension page.
 */
export async function prepareTranslatorPack(
  src: string,
  tgt: string,
  options: { monitor?: (monitor: EventTarget) => void } = {},
): Promise<TranslatorAvailability> {
  const translator = getTranslatorConstructor();
  if (!translator) return 'unavailable';

  const source = canonicalChromeLanguage(src);
  const target = canonicalChromeLanguage(tgt);
  if (!source || !target) return 'unavailable';

  const pair = {
    sourceLanguage: toChromeLanguage(source),
    targetLanguage: toChromeLanguage(target),
  };
  if (pair.sourceLanguage === pair.targetLanguage) return 'available';

  // create() has to be invoked in this turn. Awaiting availability() first drops the click
  // gesture Chrome requires when the language pack still needs to be downloaded.
  const createTask = translator
    .create({
      ...pair,
      ...(options.monitor ? { monitor: options.monitor } : {}),
    })
    .then((instance) => {
      instance.destroy?.();
      return true;
    })
    .catch(() => false);

  let current: TranslatorAvailability;
  try {
    current = await translator.availability(pair);
  } catch {
    return 'unavailable';
  }

  if (current === 'available' || current === 'unavailable') {
    await createTask;
    return current;
  }

  const created = await createTask;
  if (!created) return 'unavailable';
  return translator.availability(pair).catch(() => 'available' as const);
}
