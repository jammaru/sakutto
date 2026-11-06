import { isAbortError, isEngineError, EngineError, toEngineError } from '../errors';
import {
  buildTranslationPrompt,
  cleanModelOutput,
  sanitizeGlossary,
  type PromptInput,
} from '../prompt/pfml3';
import { ChunkStream } from '../queue/chunk-stream';
import { JobScheduler, type ScheduledHandle } from '../queue/scheduler';
import { DEFAULT_PLAN_CONFIG, planWork, type PlanConfig, type WorkItem } from '../text/plan';
import { joinTranslatedSentences, sentenceSeparator, splitForTranslation } from '../text/sentences';
import { completionTokenBudget, estimateTokens } from '../text/tokens';
import type {
  IdentifiedEngine,
  TranslateOptions,
  TranslateSegment,
  TranslationChunk,
} from '../types';
import { canonicalLanguage } from '@/shared/languages';
import { CONTEXT_TOKENS } from './backend';
import type { LlamaRuntime } from './runtime';

export interface InBrowserEngineOptions {
  config?: Partial<PlanConfig>;
  contextTokens?: number;
  scheduler?: JobScheduler;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new EngineError('aborted', 'The request was aborted.');
}

export class InBrowserEngine implements IdentifiedEngine {
  readonly kind = 'plamo' as const;

  private readonly runtime: LlamaRuntime;
  private readonly config: PlanConfig;
  private readonly contextTokens: number;
  private readonly scheduler: JobScheduler;

  constructor(runtime: LlamaRuntime, options: InBrowserEngineOptions = {}) {
    this.runtime = runtime;
    this.config = { ...DEFAULT_PLAN_CONFIG, ...options.config };
    this.contextTokens = options.contextTokens ?? CONTEXT_TOKENS;
    this.scheduler = options.scheduler ?? new JobScheduler(runtime.parallel);
  }

  async *translate(
    segments: readonly TranslateSegment[],
    options: TranslateOptions,
  ): AsyncIterable<TranslationChunk> {
    if (options.signal.aborted) return;

    const work = planWork(segments, this.config, options.eager === true);
    if (work.length === 0) return;

    const stream = new ChunkStream<TranslationChunk>();
    const controller = new AbortController();
    const forwardAbort = (): void => controller.abort();
    options.signal.addEventListener('abort', forwardAbort, { once: true });

    let remaining = work.length;
    let failed: unknown = null;
    const handles: ScheduledHandle[] = [];
    const finishOne = (): void => {
      remaining -= 1;
      if (remaining > 0) return;
      if (failed) stream.fail(failed);
      else stream.end();
    };

    for (const item of work) {
      handles.push(
        this.scheduler.schedule({
          priority: options.priority,
          run: async () => {
            try {
              await this.runWorkItem(item, options, controller.signal, stream);
            } catch (error) {
              if (!isAbortError(error) && !controller.signal.aborted && !failed) {
                failed = toEngineError(error);
              }
            } finally {
              finishOne();
            }
          },
          cancel: () => controller.abort(),
        }),
      );
    }

    try {
      for await (const chunk of stream) yield chunk;
    } finally {
      options.signal.removeEventListener('abort', forwardAbort);
      controller.abort();
      for (const handle of handles) handle.cancel();
      stream.end();
    }
  }

  private async runWorkItem(
    item: WorkItem,
    options: TranslateOptions,
    signal: AbortSignal,
    stream: ChunkStream<TranslationChunk>,
  ): Promise<void> {
    throwIfAborted(signal);

    if (item.kind === 'batch') {
      await this.runBatch(item.segments, item.text, options, signal, stream);
      return;
    }

    const segment = item.segment;
    if (segment.text.trim().length === 0) {
      stream.push({ id: segment.id, final: segment.text, engine: this.kind });
      return;
    }

    const pieces = splitForTranslation(segment.text, this.config);
    if (pieces.length <= 1) {
      const output = await this.completeRecover(
        pieces[0] ?? segment.text.trim(),
        options,
        signal,
        (delta) => stream.push({ id: segment.id, textDelta: delta, engine: this.kind }),
      );
      stream.push({ id: segment.id, final: cleanModelOutput(output), engine: this.kind });
      return;
    }

    await this.runPieces(segment, pieces, options, signal, stream);
  }

  /**
   * Sentence pieces of one paragraph share a completion when they fit. Each piece used
   * to prefill the prompt on its own, so a long paragraph paid that cost once per sentence.
   */
  private async runPieces(
    segment: TranslateSegment,
    pieces: readonly string[],
    options: TranslateOptions,
    signal: AbortSignal,
    stream: ChunkStream<TranslationChunk>,
  ): Promise<void> {
    const synthetic = pieces.map((text, index) => ({
      id: `${segment.id}#${String(index)}`,
      text,
    }));
    const translated = pieces.map(() => '');
    let started = false;
    const emitSeparator = (): void => {
      if (!started) return;
      const separator = sentenceSeparator(options.tgt);
      if (separator.length > 0) {
        stream.push({ id: segment.id, textDelta: separator, engine: this.kind });
      }
    };

    for (const item of planWork(synthetic, this.config, options.eager === true)) {
      throwIfAborted(signal);
      if (item.kind === 'single') {
        const index = pieceIndex(item.segment.id);
        emitSeparator();
        started = true;
        const output = await this.completeRecover(item.segment.text, options, signal, (delta) =>
          stream.push({ id: segment.id, textDelta: delta, engine: this.kind }),
        );
        translated[index] = cleanModelOutput(output);
        continue;
      }

      emitSeparator();
      started = true;
      await this.collectBatch(
        item.segments,
        item.text,
        segment.id,
        translated,
        options,
        signal,
        stream,
      );
    }

    stream.push({
      id: segment.id,
      final: joinTranslatedSentences(
        translated.map((part, index) => (part.trim().length > 0 ? part : (pieces[index] ?? ''))),
        options.tgt,
      ),
      engine: this.kind,
    });
  }

  private async collectBatch(
    segments: readonly TranslateSegment[],
    text: string,
    parentId: string,
    translated: string[],
    options: TranslateOptions,
    signal: AbortSignal,
    stream: ChunkStream<TranslationChunk>,
  ): Promise<void> {
    const side = new ChunkStream<TranslationChunk>();
    let opened = -1;
    const reading = (async (): Promise<void> => {
      for await (const chunk of side) {
        const index = pieceIndex(chunk.id);
        if (chunk.textDelta) {
          if (index !== opened) {
            if (opened >= 0) {
              const separator = sentenceSeparator(options.tgt);
              if (separator.length > 0) {
                stream.push({ id: parentId, textDelta: separator, engine: this.kind });
              }
            }
            opened = index;
          }
          stream.push({ id: parentId, textDelta: chunk.textDelta, engine: this.kind });
        }
        if (chunk.final !== undefined) translated[index] = chunk.final;
      }
    })();

    try {
      await this.runBatch(segments, text, options, signal, side);
    } finally {
      side.end();
      await reading;
    }
  }

  private async runBatch(
    segments: readonly TranslateSegment[],
    text: string,
    options: TranslateOptions,
    signal: AbortSignal,
    stream: ChunkStream<TranslationChunk>,
  ): Promise<void> {
    let shown = 0;
    let pending = '';
    let opened = false;

    const takeLine = (): void => {
      const line = cleanModelOutput(pending);
      pending = '';
      opened = false;
      if (line.length === 0 || shown >= segments.length) return;
      shown += 1;
    };

    let output: string;
    try {
      output = await this.complete(text, options, signal, (delta) => {
        let rest = delta;
        while (rest.length > 0) {
          const newlineAt = rest.indexOf('\n');
          const chunk = newlineAt === -1 ? rest : rest.slice(0, newlineAt);
          if (chunk.length > 0 && shown < segments.length) {
            pending += chunk;
            opened = true;
            const segment = segments[shown];
            if (segment) stream.push({ id: segment.id, textDelta: chunk, engine: this.kind });
          }
          if (newlineAt === -1) break;
          takeLine();
          rest = rest.slice(newlineAt + 1);
        }
      });
    } catch (error) {
      if (signal.aborted || isAbortError(error) || !isOversized(error)) throw error;
      await this.completeIndividually(segments, options, signal, stream, shown + (opened ? 1 : 0));
      return;
    }

    const cleaned = cleanModelOutput(output);
    const lines =
      cleaned.length === 0 ? [] : cleaned.split('\n').map((line) => cleanModelOutput(line));

    if (lines.length !== segments.length || lines.some((line) => line.length === 0)) {
      // Keep the lines the model did finish. Re-translating a line that is already
      // correct and already on screen wasted one completion per line whenever a batch
      // lost its tail, which is the common failure for a packed paragraph.
      const usable = lines.slice(0, segments.length).map((line) => line.trim());
      const settled = usable.findIndex((line) => line.length === 0);
      const keep = settled === -1 ? usable.length : settled;
      if (keep > 0) {
        for (let index = 0; index < keep; index += 1) {
          const segment = segments[index];
          if (segment)
            stream.push({ id: segment.id, final: usable[index] ?? '', engine: this.kind });
        }
      }
      await this.completeIndividually(
        segments.slice(keep),
        options,
        signal,
        stream,
        Math.max(0, shown + (opened ? 1 : 0) - keep),
      );
      return;
    }

    segments.forEach((segment, index) => {
      stream.push({ id: segment.id, final: lines[index] ?? '', engine: this.kind });
    });
  }

  private async completeIndividually(
    segments: readonly TranslateSegment[],
    options: TranslateOptions,
    signal: AbortSignal,
    stream: ChunkStream<TranslationChunk>,
    alreadyShown = 0,
  ): Promise<void> {
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index];
      if (!segment) continue;
      throwIfAborted(signal);

      if (segment.text.trim().length === 0) {
        stream.push({ id: segment.id, final: segment.text, engine: this.kind });
        continue;
      }

      const output = await this.completeRecover(
        segment.text.trim(),
        options,
        signal,
        index < alreadyShown
          ? () => undefined
          : (delta) => stream.push({ id: segment.id, textDelta: delta, engine: this.kind }),
      );
      stream.push({ id: segment.id, final: cleanModelOutput(output), engine: this.kind });
    }
  }

  /**
   * A piece that does not fit is split and translated in smaller calls. Text that still
   * cannot fit is kept, so one oversized sentence does not drop the rest of the page.
   */
  private async completeRecover(
    text: string,
    options: TranslateOptions,
    signal: AbortSignal,
    onDelta: (delta: string) => void,
  ): Promise<string> {
    try {
      return await this.complete(text, options, signal, onDelta);
    } catch (error) {
      if (signal.aborted || isAbortError(error) || !isOversized(error)) throw error;
      const smaller = splitForTranslation(text, {
        sentenceThreshold: Math.min(80, this.config.sentenceThreshold),
        maxChunkChars: Math.min(160, this.config.maxChunkChars),
      }).filter((piece) => piece.trim().length > 0);
      const unchanged = smaller.length <= 1 && (smaller[0] ?? '') === text.trim();
      if (unchanged) return text;

      const parts: string[] = [];
      for (const piece of smaller) {
        throwIfAborted(signal);
        if (parts.length > 0) {
          const separator = sentenceSeparator(options.tgt);
          if (separator.length > 0) onDelta(separator);
        }
        try {
          const output = await this.complete(piece, options, signal, onDelta);
          const cleaned = cleanModelOutput(output);
          parts.push(cleaned.length > 0 ? cleaned : piece);
        } catch (inner) {
          if (signal.aborted || isAbortError(inner) || !isOversized(inner)) throw inner;
          parts.push(piece);
          onDelta(piece);
        }
      }
      return parts.join(sentenceSeparator(options.tgt));
    }
  }

  private async complete(
    text: string,
    options: TranslateOptions,
    signal: AbortSignal,
    onDelta: (delta: string) => void = () => undefined,
  ): Promise<string> {
    const tgt = canonicalLanguage(options.tgt);
    if (!tgt) {
      throw new EngineError(
        'unsupported-language',
        'The translation model does not support the target language.',
      );
    }

    const src = options.src === undefined ? null : canonicalLanguage(options.src);
    if (options.src !== undefined && !src) {
      throw new EngineError(
        'unsupported-language',
        'The translation model does not support the source language.',
      );
    }

    const glossary = sanitizeGlossary(options.glossary ?? []).filter((entry) =>
      text.includes(entry.source),
    );
    const promptInput: PromptInput = {
      text,
      tgt,
      ...(src !== null ? { src } : {}),
      ...(tgt === 'ja' ? { form: options.form } : {}),
      ...(glossary.length > 0 ? { glossary } : {}),
      ...(options.context ? { context: options.context } : {}),
    };
    const prompt = buildTranslationPrompt(promptInput);
    const available = this.contextTokens - estimateTokens(prompt) - 8;

    if (available < 16) {
      throw new EngineError('invalid-input', 'The segment does not fit in the context window.');
    }

    let output = '';
    await this.runtime.complete({
      prompt,
      maxTokens: Math.min(completionTokenBudget(text), available),
      signal,
      onToken: (delta) => {
        output += delta;
        onDelta(delta);
      },
    });

    return output;
  }
}

function isOversized(error: unknown): boolean {
  return isEngineError(error) && error.code === 'invalid-input';
}

function pieceIndex(id: string): number {
  const marker = id.lastIndexOf('#');
  if (marker === -1) return 0;
  const index = Number(id.slice(marker + 1));
  return Number.isInteger(index) ? index : 0;
}
