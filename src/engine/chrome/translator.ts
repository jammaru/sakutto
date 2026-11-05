import { EngineError, isAbortError } from '../errors';
import type {
  IdentifiedEngine,
  TranslateOptions,
  TranslateSegment,
  TranslationChunk,
} from '../types';
import {
  canonicalChromeLanguage,
  fromChromeLanguage,
  toChromeLanguage,
} from '../../shared/languages';
import {
  getTranslatorConstructor,
  type TranslatorAvailability,
  type TranslatorConstructor,
  type TranslatorPackInstance,
} from '../../shared/translator-pack';

export type { TranslatorAvailability, TranslatorConstructor } from '../../shared/translator-pack';

export interface TranslatorInstance extends TranslatorPackInstance {
  translate(text: string): Promise<string>;
  translateStreaming?(text: string): ReadableStream<unknown>;
}

export interface DetectedLanguage {
  detectedLanguage: string;
  confidence?: number;
}

export interface LanguageDetectorInstance {
  detect(text: string): Promise<readonly DetectedLanguage[]>;
  destroy?(): void;
}

export interface LanguageDetectorConstructor {
  availability(): Promise<string>;
  create(options?: { monitor?: (monitor: EventTarget) => void }): Promise<LanguageDetectorInstance>;
}

export interface ChromeTranslatorDependencies {
  translator?: TranslatorConstructor<TranslatorInstance> | null;
  languageDetector?: LanguageDetectorConstructor | null;
}

interface LanguageDetectorScope {
  LanguageDetector?: LanguageDetectorConstructor;
}

function getLanguageDetectorConstructor(): LanguageDetectorConstructor | null {
  const scope = globalThis as unknown as LanguageDetectorScope;
  return scope.LanguageDetector ?? null;
}

function instanceKey(sourceLanguage: string, targetLanguage: string): string {
  return `${sourceLanguage}\u0000${targetLanguage}`;
}

function decodeChunk(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Uint8Array) return new TextDecoder().decode(value);
  return '';
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new EngineError('aborted', 'The request was aborted.');
}

export class ChromeTranslatorEngine implements IdentifiedEngine {
  readonly kind = 'chrome' as const;

  private readonly translator: TranslatorConstructor<TranslatorInstance> | null;
  private readonly detectorConstructor: LanguageDetectorConstructor | null;
  private readonly instances = new Map<string, Promise<TranslatorInstance>>();
  private detector: Promise<LanguageDetectorInstance | null> | null = null;
  private locked = false;
  private lockWaiters: Array<() => void> = [];

  constructor(dependencies: ChromeTranslatorDependencies = {}) {
    this.translator =
      dependencies.translator ??
      (getTranslatorConstructor() as TranslatorConstructor<TranslatorInstance> | null);
    this.detectorConstructor = dependencies.languageDetector ?? getLanguageDetectorConstructor();
  }

  get available(): boolean {
    return this.translator !== null;
  }

  async availability(src: string, tgt: string): Promise<TranslatorAvailability> {
    const source = canonicalChromeLanguage(src);
    const target = canonicalChromeLanguage(tgt);
    if (!this.translator || !source || !target) return 'unavailable';
    return this.availabilityForPair(toChromeLanguage(source), toChromeLanguage(target));
  }

  async detect(text: string): Promise<string | null> {
    const detector = await this.getDetector();
    if (!detector) return null;

    try {
      const results = await detector.detect(text);
      let best: DetectedLanguage | null = null;
      for (const result of results) {
        if (!best || (result.confidence ?? 0) > (best.confidence ?? 0)) best = result;
      }
      return best ? fromChromeLanguage(best.detectedLanguage) : null;
    } catch {
      return null;
    }
  }

  async *translate(
    segments: readonly TranslateSegment[],
    options: TranslateOptions,
  ): AsyncGenerator<TranslationChunk> {
    if (!this.translator) {
      throw new EngineError('chrome-unavailable', 'The built-in translator is not available.');
    }

    const target = canonicalChromeLanguage(options.tgt);
    if (!target) {
      throw new EngineError(
        'unsupported-language',
        'The built-in translator does not support the target language.',
      );
    }

    const targetLanguage = toChromeLanguage(target);
    const suppliedSource = options.src ? canonicalChromeLanguage(options.src) : null;
    let sourceLanguage = suppliedSource ? toChromeLanguage(suppliedSource) : null;

    if (!sourceLanguage) {
      const sample = segments
        .map((segment) => segment.text)
        .join('\n')
        .slice(0, 1000);
      const detected = await this.detect(sample);
      const canonicalDetected = detected ? canonicalChromeLanguage(detected) : null;
      if (!canonicalDetected) {
        throw new EngineError(
          'unsupported-language',
          'The built-in translator cannot determine the source language.',
        );
      }
      sourceLanguage = toChromeLanguage(canonicalDetected);
    }

    if (sourceLanguage === targetLanguage) {
      for (const segment of segments) {
        yield { id: segment.id, final: segment.text, engine: this.kind };
      }
      return;
    }

    const translator = await this.ensureTranslator(sourceLanguage, targetLanguage);

    for (const segment of segments) {
      if (options.signal.aborted) return;

      if (segment.text.trim().length === 0) {
        yield { id: segment.id, final: segment.text, engine: this.kind };
        continue;
      }

      try {
        yield* this.translateSegment(segment, translator, options.signal);
      } catch (error) {
        if (isAbortError(error) || options.signal.aborted) return;
        if (error instanceof EngineError) throw error;
        throw new EngineError('chrome-not-ready', 'The built-in translator failed.', {
          cause: error,
        });
      }
    }
  }

  async dispose(): Promise<void> {
    const pending = [...this.instances.values()];
    this.instances.clear();

    for (const instance of pending) {
      try {
        (await instance).destroy?.();
      } catch {
        // Instances that fail to close are already unusable.
      }
    }

    try {
      (await this.detector)?.destroy?.();
    } catch {
      // Same as above.
    }
    this.detector = null;
  }

  private async *translateSegment(
    segment: TranslateSegment,
    translator: TranslatorInstance,
    signal: AbortSignal,
  ): AsyncGenerator<TranslationChunk> {
    await this.acquire();

    try {
      if (translator.translateStreaming) {
        const reader = translator.translateStreaming(segment.text).getReader();
        let full = '';

        try {
          while (true) {
            throwIfAborted(signal);
            const { done, value } = await reader.read();
            if (done) break;
            const delta = decodeChunk(value);
            if (delta.length === 0) continue;
            full += delta;
            yield { id: segment.id, textDelta: delta, engine: this.kind };
          }
        } finally {
          await reader.cancel().catch(() => undefined);
          reader.releaseLock();
        }

        if (signal.aborted) return;
        yield { id: segment.id, final: full.trim(), engine: this.kind };
        return;
      }

      const translated = await translator.translate(segment.text);
      if (signal.aborted) return;
      yield { id: segment.id, final: translated.trim(), engine: this.kind };
    } finally {
      this.release();
    }
  }

  private ensureTranslator(
    sourceLanguage: string,
    targetLanguage: string,
  ): Promise<TranslatorInstance> {
    const key = instanceKey(sourceLanguage, targetLanguage);
    const existing = this.instances.get(key);
    if (existing) return existing;

    const created = (async () => {
      const translator = this.translator;
      if (!translator) {
        throw new EngineError('chrome-unavailable', 'The built-in translator is not available.');
      }

      const availability = await this.availabilityForPair(sourceLanguage, targetLanguage);
      if (availability === 'unavailable') {
        throw new EngineError(
          'chrome-unavailable',
          'The built-in translator does not support this language pair.',
        );
      }
      if (availability !== 'available') {
        throw new EngineError(
          'chrome-not-ready',
          'The built-in language pack is not installed yet.',
        );
      }

      return translator.create({ sourceLanguage, targetLanguage });
    })();

    this.instances.set(key, created);
    created.catch(() => {
      this.instances.delete(key);
    });
    return created;
  }

  private async availabilityForPair(
    sourceLanguage: string,
    targetLanguage: string,
  ): Promise<TranslatorAvailability> {
    const translator = this.translator;
    if (!translator) return 'unavailable';
    if (sourceLanguage === targetLanguage) return 'available';

    try {
      return await translator.availability({ sourceLanguage, targetLanguage });
    } catch {
      return 'unavailable';
    }
  }

  private getDetector(): Promise<LanguageDetectorInstance | null> {
    if (!this.detectorConstructor) return Promise.resolve(null);

    this.detector ??= (async () => {
      const constructor = this.detectorConstructor;
      if (!constructor) return null;

      try {
        const availability = await constructor.availability();
        if (availability === 'unavailable' || availability === 'no') return null;
        return await constructor.create();
      } catch {
        return null;
      }
    })();

    return this.detector;
  }

  private acquire(): Promise<void> {
    if (!this.locked) {
      this.locked = true;
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      this.lockWaiters.push(resolve);
    });
  }

  private release(): void {
    const next = this.lockWaiters.shift();
    if (next) {
      next();
      return;
    }
    this.locked = false;
  }
}
