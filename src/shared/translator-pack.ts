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

const PREPARED_PAIRS = new WeakMap<TranslatorConstructor, Set<string>>();
const PENDING_PACKS = new WeakMap<
  TranslatorConstructor,
  Map<string, Promise<TranslatorAvailability>>
>();

function preparedPairs(translator: TranslatorConstructor): Set<string> {
  let pairs = PREPARED_PAIRS.get(translator);
  if (!pairs) {
    pairs = new Set();
    PREPARED_PAIRS.set(translator, pairs);
  }
  return pairs;
}

function pendingPacks(
  translator: TranslatorConstructor,
): Map<string, Promise<TranslatorAvailability>> {
  let pending = PENDING_PACKS.get(translator);
  if (!pending) {
    pending = new Map();
    PENDING_PACKS.set(translator, pending);
  }
  return pending;
}

async function installPack(
  translator: TranslatorConstructor,
  pair: LanguagePair,
  key: string,
  options: { monitor?: (monitor: EventTarget) => void },
): Promise<TranslatorAvailability> {
  const prepared = preparedPairs(translator);

  // A pair this module already installed is queried without creating another service. That
  // repeated `Translator.create()` is what can exceed Chrome's translation-service limit.
  if (prepared.has(key)) {
    const current = await translator.availability(pair).catch(() => 'unavailable' as const);
    if (current === 'available' || current === 'unavailable') return current;
  }

  // create() has to be invoked in this turn. Awaiting availability() first drops the click
  // gesture Chrome requires when the language pack still needs to be downloaded. The
  // surrounding try also turns a synchronous service-limit throw into a handled result.
  let createTask: Promise<boolean>;
  try {
    createTask = Promise.resolve(
      translator.create({
        ...pair,
        ...(options.monitor ? { monitor: options.monitor } : {}),
      }),
    )
      .then((instance) => {
        instance.destroy?.();
        prepared.add(key);
        return true;
      })
      .catch(() => false);
  } catch {
    createTask = Promise.resolve(false);
  }

  let current: TranslatorAvailability;
  try {
    current = await translator.availability(pair);
  } catch {
    await createTask;
    prepared.delete(key);
    return 'unavailable';
  }

  if (current === 'available') {
    await createTask;
    return current;
  }

  if (current === 'unavailable') {
    await createTask;
    prepared.delete(key);
    return current;
  }

  const created = await createTask;
  if (!created) {
    prepared.delete(key);
    return 'unavailable';
  }
  return translator.availability(pair).catch(() => 'available' as const);
}

/**
 * Installs the built-in translator language pack for a pair. Chrome requires a user gesture
 * for `create`, so this must run from a click handler in an extension page.
 *
 * Calls for the same pair share one operation and a successfully installed pair is not
 * created again. Onboarding can be clicked more than once; without this, each click would
 * add another Chrome translation service and eventually report "The translation service
 * count exceeded the limitation."
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

  const key = `${pair.sourceLanguage}\u0000${pair.targetLanguage}`;
  const pending = pendingPacks(translator);
  const existing = pending.get(key);
  if (existing) return existing;

  // Keep the promise handled even if an unusual availability/create implementation rejects
  // outside the branches installPack already guards. Onboarding must never see this escape.
  const task = installPack(translator, pair, key, options).catch(() => 'unavailable' as const);
  pending.set(key, task);
  try {
    return await task;
  } finally {
    if (pending.get(key) === task) pending.delete(key);
  }
}
