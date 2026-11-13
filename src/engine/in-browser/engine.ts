import {
  abortError,
  isAbortError,
  isEngineError,
  isLengthTruncation,
  EngineError,
  toEngineError,
} from '../errors';
import {
  buildTranslationPrompt,
  cleanModelOutput,
  sanitizeGlossary,
  type PromptInput,
} from '../prompt/pfml3';
import { ChunkStream } from '../queue/chunk-stream';
import { JobScheduler, type ScheduledHandle } from '../queue/scheduler';
import { DEFAULT_PLAN_CONFIG, planWork, type PlanConfig, type WorkItem } from '../text/plan';
import {
  chunkForTranslation,
  joinTranslatedSentences,
  sentenceSeparator,
  splitForTranslation,
} from '../text/sentences';
import { DEGENERATE_SESSION_BLOCKS, isBrokenTranslation } from '../text/degenerate';
import {
  hasTranslatableText,
  isInvisibleRunawayOutput,
  sanitizeTranslationInput,
} from '../text/sanitize';
import { budgetTokens, completionTokenBudget, estimateTokens } from '../text/tokens';
import type {
  IdentifiedEngine,
  TranslateOptions,
  TranslateSegment,
  TranslationChunk,
} from '../types';
import { canonicalLanguage, JA_EASY_TARGET, plamoPromptTargetLanguage } from '@/shared/languages';
import { CONTEXT_TOKENS } from './backend';
import type { LlamaRuntime } from './runtime';

export interface InBrowserEngineOptions {
  config?: Partial<PlanConfig>;
  contextTokens?: number;
  scheduler?: JobScheduler;
  /** CPU runtime used to retry one broken WebGPU piece without leaving the GPU session. */
  loadRetryRuntime?: (signal: AbortSignal) => Promise<LlamaRuntime | null>;
  /** Fired once per piece that looked like a collapsed kernel. */
  onDegenerateBlock?: () => void;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new EngineError('aborted', 'The request was aborted.');
}

interface PieceOutput {
  text: string;
  error?: boolean;
}

type DeltaSink = (delta: string, restart?: boolean) => void;

/** Sanitized text for planning/prompts, plus the page bytes to restore on failure. */
interface EngineSegment extends TranslateSegment {
  original: string;
}

function pageOriginal(segment: TranslateSegment): string {
  return segment.original ?? segment.text;
}

/**
 * Streams pieces translated at the same time in reading order. The earliest unfinished
 * piece streams live; a later piece is held until every piece before it is done.
 */
class PieceAssembler {
  private readonly raw: string[];
  private readonly done: Array<string | null>;
  private current = 0;

  constructor(
    count: number,
    private readonly separator: string,
    private readonly onDelta: DeltaSink,
    private readonly onFinal: (parts: string[]) => void,
  ) {
    this.raw = new Array<string>(count).fill('');
    this.done = new Array<string | null>(count).fill(null);
  }

  delta(index: number, delta: string, restart = false): void {
    this.raw[index] = restart ? delta : this.raw[index] + delta;
    if (index !== this.current) return;
    if (!restart) {
      this.onDelta(delta);
      return;
    }
    // A later piece's retry must not blank the pieces already painted.
    this.onDelta(this.committedPrefix() + delta, true);
  }

  private committedPrefix(): string {
    if (this.current === 0) return '';
    const parts: string[] = [];
    for (let index = 0; index < this.current; index += 1) {
      parts.push(this.done[index] ?? '');
    }
    return parts.join(this.separator) + this.separator;
  }

  finish(index: number, text: string): void {
    this.done[index] = text;
    while (this.current < this.done.length && this.done[this.current] !== null) {
      this.current += 1;
      if (this.current === this.done.length) {
        this.onFinal(this.done as string[]);
        return;
      }
      if (this.separator.length > 0) this.onDelta(this.separator);
      const buffered = this.raw[this.current] ?? '';
      if (buffered.length > 0) this.onDelta(buffered);
    }
  }
}

export class InBrowserEngine implements IdentifiedEngine {
  readonly kind = 'plamo' as const;

  private readonly runtime: LlamaRuntime;
  private readonly config: PlanConfig;
  private readonly contextTokens: number;
  private readonly scheduler: JobScheduler;
  private readonly loadRetryRuntime: InBrowserEngineOptions['loadRetryRuntime'];
  private readonly onDegenerateBlock: InBrowserEngineOptions['onDegenerateBlock'];
  private degenerateHits = 0;

  constructor(runtime: LlamaRuntime, options: InBrowserEngineOptions = {}) {
    this.runtime = runtime;
    this.config = { ...DEFAULT_PLAN_CONFIG, ...options.config };
    this.contextTokens = options.contextTokens ?? CONTEXT_TOKENS;
    this.loadRetryRuntime = options.loadRetryRuntime;
    this.onDegenerateBlock = options.onDegenerateBlock;
    this.scheduler =
      options.scheduler ??
      new JobScheduler(
        runtime.parallel,
        runtime.backend !== 'local-server' && runtime.parallel > 1,
      );
  }

  async *translate(
    segments: readonly TranslateSegment[],
    options: TranslateOptions,
  ): AsyncIterable<TranslationChunk> {
    if (options.signal.aborted) return;

    const skipped: TranslateSegment[] = [];
    const ready: EngineSegment[] = [];
    for (const segment of segments) {
      if (!hasTranslatableText(segment.text)) skipped.push(segment);
      else {
        ready.push({
          ...segment,
          text: sanitizeTranslationInput(segment.text),
          original: segment.text,
        });
      }
    }

    const work = planWork(ready, this.config, options.eager === true);
    if (work.length === 0 && skipped.length === 0) return;

    const stream = new ChunkStream<TranslationChunk>();
    const controller = new AbortController();
    const forwardAbort = (): void => controller.abort();
    options.signal.addEventListener('abort', forwardAbort, { once: true });

    for (const segment of skipped) {
      stream.push({ id: segment.id, final: segment.text, engine: this.kind });
    }

    const jobs = work.flatMap((item) => this.jobsFor(item, options, controller.signal, stream));
    let remaining = jobs.length;
    let failed: unknown = null;
    const handles: ScheduledHandle[] = [];
    const finishOne = (): void => {
      remaining -= 1;
      if (remaining > 0) return;
      if (failed) {
        stream.fail(failed);
        return;
      }
      // Preemption aborts this engine controller without the caller's signal. End
      // that as an abort so the page session can retry instead of counting a failure.
      if (controller.signal.aborted && !options.signal.aborted) {
        stream.fail(abortError());
        return;
      }
      stream.end();
    };

    for (const job of jobs) {
      handles.push(
        this.scheduler.schedule({
          priority: options.priority,
          ...(options.preempt === true ? { preempt: true } : {}),
          run: async () => {
            try {
              await job();
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

    if (jobs.length === 0) stream.end();

    try {
      for await (const chunk of stream) yield chunk;
    } finally {
      options.signal.removeEventListener('abort', forwardAbort);
      controller.abort();
      for (const handle of handles) handle.cancel();
      stream.end();
    }
  }

  /**
   * With several slots, the pieces of a long text are separate jobs so one wave translates
   * them together; a text decoded piece by piece would hold the wave open on a single slot.
   */
  private jobsFor(
    item: WorkItem,
    options: TranslateOptions,
    signal: AbortSignal,
    stream: ChunkStream<TranslationChunk>,
  ): Array<() => Promise<void>> {
    const whole = (): Promise<void> => this.runWorkItem(item, options, signal, stream);
    if (this.runtime.parallel <= 1 || item.kind !== 'single') return [whole];
    const { segment } = item;
    if (segment.text.trim().length === 0) return [whole];
    const pieces = chunkForTranslation(pageOriginal(segment), this.config.pieceChars);
    if (pieces.length <= 1) return [whole];

    const failed = pieces.map(() => false);
    const assembler = new PieceAssembler(
      pieces.length,
      sentenceSeparator(options.tgt),
      (delta, restart) =>
        stream.push({
          id: segment.id,
          textDelta: delta,
          engine: this.kind,
          ...(restart ? { restart: true } : {}),
        }),
      (parts) => {
        const error = failed.some(Boolean);
        stream.push({
          id: segment.id,
          final: failed.every(Boolean)
            ? pageOriginal(segment)
            : joinTranslatedSentences(parts, options.tgt),
          engine: this.kind,
          ...(error ? { error: true } : {}),
        });
      },
    );
    return pieces.map((piece, index) => async () => {
      throwIfAborted(signal);
      const output = await this.completeRecover(piece, options, signal, (delta, restart) =>
        assembler.delta(index, delta, restart === true),
      );
      if (output.error) {
        failed[index] = true;
        assembler.finish(index, piece);
        return;
      }
      const cleaned = cleanModelOutput(output.text);
      assembler.finish(index, cleaned.length > 0 ? cleaned : piece);
    });
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

    const pieces = chunkForTranslation(pageOriginal(segment), this.config.pieceChars);
    if (pieces.length <= 1) {
      const fallback = pageOriginal(segment);
      const output = await this.completeRecover(fallback, options, signal, (delta, restart) =>
        stream.push({
          id: segment.id,
          textDelta: delta,
          engine: this.kind,
          ...(restart ? { restart: true } : {}),
        }),
      );
      const cleaned = output.error ? output.text : cleanModelOutput(output.text);
      stream.push({
        id: segment.id,
        final: cleaned.length > 0 ? cleaned : fallback,
        engine: this.kind,
        ...(output.error ? { error: true } : {}),
      });
      return;
    }

    await this.runPieces(segment, pieces, options, signal, stream);
  }

  /**
   * A text longer than a paragraph is translated as runs of whole sentences, one prompt per
   * run. The runs used to be one sentence per line of a single packed prompt, which cut each
   * sentence off from its neighbours and relied on the model returning the same line count.
   */
  private async runPieces(
    segment: TranslateSegment,
    pieces: readonly string[],
    options: TranslateOptions,
    signal: AbortSignal,
    stream: ChunkStream<TranslationChunk>,
  ): Promise<void> {
    const translated: string[] = [];
    const separator = sentenceSeparator(options.tgt);
    let failed = 0;
    let committed = '';

    for (const [index, piece] of pieces.entries()) {
      throwIfAborted(signal);
      if (index > 0 && separator.length > 0) {
        stream.push({ id: segment.id, textDelta: separator, engine: this.kind });
        committed += separator;
      }
      const prefix = committed;
      const output = await this.completeRecover(piece, options, signal, (delta, restart) =>
        stream.push({
          id: segment.id,
          textDelta: restart === true ? prefix + delta : delta,
          engine: this.kind,
          ...(restart ? { restart: true } : {}),
        }),
      );
      if (output.error) {
        failed += 1;
        translated.push(piece);
        committed += piece;
        continue;
      }
      const cleaned = cleanModelOutput(output.text);
      const text = cleaned.length > 0 ? cleaned : piece;
      translated.push(text);
      committed += text;
    }

    const error = failed > 0;
    stream.push({
      id: segment.id,
      final:
        failed === pieces.length
          ? pageOriginal(segment)
          : joinTranslatedSentences(translated, options.tgt),
      engine: this.kind,
      ...(error ? { error: true } : {}),
    });
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
    let restartNext = false;

    const takeLine = (): void => {
      const line = cleanModelOutput(pending);
      pending = '';
      opened = false;
      if (line.length === 0 || shown >= segments.length) return;
      shown += 1;
    };

    let output: PieceOutput;
    try {
      output = await this.complete(text, options, signal, (delta, restart) => {
        if (restart) {
          const already = opened ? shown + 1 : shown;
          for (let index = 0; index < already; index += 1) {
            const painted = segments[index];
            if (painted) {
              stream.push({
                id: painted.id,
                textDelta: '',
                engine: this.kind,
                restart: true,
              });
            }
          }
          shown = 0;
          pending = '';
          opened = false;
          restartNext = true;
        }
        let rest = delta;
        while (rest.length > 0) {
          const newlineAt = rest.indexOf('\n');
          const chunk = newlineAt === -1 ? rest : rest.slice(0, newlineAt);
          if (chunk.length > 0 && shown < segments.length) {
            pending += chunk;
            opened = true;
            const segment = segments[shown];
            if (segment) {
              stream.push({
                id: segment.id,
                textDelta: chunk,
                engine: this.kind,
                ...(restartNext ? { restart: true } : {}),
              });
              restartNext = false;
            }
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

    if (output.error) {
      await this.completeIndividually(segments, options, signal, stream, shown + (opened ? 1 : 0));
      return;
    }

    const cleaned = cleanModelOutput(output.text);
    const lines =
      cleaned.length === 0 ? [] : cleaned.split('\n').map((line) => cleanModelOutput(line));

    if (lines.length !== segments.length || lines.some((line) => line.length === 0)) {
      // A short count does not say which line went missing. When the model merges two
      // lines, every line after the merge belongs to the next block, so keeping the
      // "finished" prefix wrote one block's translation into another. Each line is
      // translated again on its own; they are short, because only short blocks are packed.
      await this.completeIndividually(segments, options, signal, stream, shown + (opened ? 1 : 0));
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

      // A line the packed attempt already painted starts over, so the retry replaces the
      // misaligned text instead of being appended to it.
      let restart = index < alreadyShown;
      const fallback = pageOriginal(segment);
      const output = await this.completeRecover(fallback, options, signal, (delta, next) => {
        stream.push({
          id: segment.id,
          textDelta: delta,
          engine: this.kind,
          ...(restart || next ? { restart: true } : {}),
        });
        restart = false;
      });
      const cleaned = output.error ? '' : cleanModelOutput(output.text);
      // An empty retry sends no delta to restart with, and an empty final paints nothing, so
      // a line that was shown would keep the misaligned text. The source replaces it instead.
      const final =
        output.error || (cleaned.length === 0 && index < alreadyShown) ? fallback : cleaned;
      stream.push({
        id: segment.id,
        final,
        engine: this.kind,
        ...(output.error ? { error: true } : {}),
      });
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
    onDelta: DeltaSink,
  ): Promise<PieceOutput> {
    try {
      return await this.complete(text, options, signal, onDelta);
    } catch (error) {
      if (signal.aborted || isAbortError(error) || !isOversized(error)) throw error;
      const smaller = splitForTranslation(text, {
        sentenceThreshold: Math.min(80, this.config.sentenceThreshold),
        maxChunkChars: Math.min(160, this.config.maxChunkChars),
      }).filter((piece) => piece.trim().length > 0);
      const unchanged = smaller.length <= 1 && (smaller[0] ?? '') === text.trim();
      if (unchanged) return { text };

      const parts: string[] = [];
      let failed = false;
      let committed = '';
      const separator = sentenceSeparator(options.tgt);
      for (const piece of smaller) {
        throwIfAborted(signal);
        if (parts.length > 0 && separator.length > 0) {
          onDelta(separator);
          committed += separator;
        }
        const prefix = committed;
        try {
          const output = await this.complete(piece, options, signal, (delta, restart) =>
            onDelta(restart === true ? prefix + delta : delta, restart),
          );
          if (output.error) {
            failed = true;
            parts.push(piece);
            committed += piece;
            onDelta(prefix + piece, true);
            continue;
          }
          const cleaned = cleanModelOutput(output.text);
          const text = cleaned.length > 0 ? cleaned : piece;
          parts.push(text);
          committed += text;
        } catch (inner) {
          if (signal.aborted || isAbortError(inner) || !isOversized(inner)) throw inner;
          failed = true;
          parts.push(piece);
          committed += piece;
          onDelta(prefix + piece, true);
        }
      }
      return {
        text: parts.join(sentenceSeparator(options.tgt)),
        ...(failed ? { error: true } : {}),
      };
    }
  }

  private async complete(
    text: string,
    options: TranslateOptions,
    signal: AbortSignal,
    onDelta: DeltaSink = () => undefined,
  ): Promise<PieceOutput> {
    const tgt = plamoPromptTargetLanguage(options.tgt);
    if (tgt.length === 0) {
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

    const source = sanitizeTranslationInput(text);
    if (!hasTranslatableText(source)) {
      return { text };
    }

    const glossary = sanitizeGlossary(options.glossary ?? []).filter((entry) =>
      source.includes(entry.source),
    );
    const promptInput: PromptInput = {
      text: source,
      tgt,
      ...(src !== null ? { src } : {}),
      ...(tgt === 'ja' || tgt === JA_EASY_TARGET ? { form: options.form } : {}),
      ...(glossary.length > 0 ? { glossary } : {}),
      ...(options.context ? { context: options.context } : {}),
    };
    const prompt = buildTranslationPrompt(promptInput);
    const available = this.contextTokens - (await this.tokenCount(prompt, 'prompt')) - 8;

    if (available < 16) {
      throw new EngineError('invalid-input', 'The segment does not fit in the context window.');
    }

    // Stream immediately so first-visible-text is not delayed. A collapsed
    // kernel is only certain at the end (it fills maxTokens), so a bad prefix
    // is retracted there rather than held here.
    let output = '';
    let streamed = false;
    const maxTokens = Math.min(
      completionTokenBudget(source, await this.tokenCount(source, 'source')),
      available,
    );
    const skipGpu =
      this.degenerateHits >= DEGENERATE_SESSION_BLOCKS && this.runtime.backend === 'webgpu';

    const generate = async (
      budget: number,
      restart: boolean,
    ): Promise<{ lengthError: unknown; hitMaxTokens: boolean }> => {
      output = '';
      let first = true;
      let lengthError: unknown = null;
      let hitMaxTokens: boolean;
      try {
        const result = await this.runtime.complete({
          prompt,
          maxTokens: budget,
          signal,
          onToken: (delta) => {
            output += delta;
            streamed = true;
            onDelta(delta, restart && first);
            first = false;
          },
        });
        hitMaxTokens = result?.hitMaxTokens === true;
      } catch (error) {
        if (signal.aborted || isAbortError(error)) throw error;
        if (!isLengthTruncation(error)) throw error;
        lengthError = error;
        hitMaxTokens = true;
      }
      return { lengthError, hitMaxTokens };
    };

    const failVisibleTruncation = (): PieceOutput => {
      if (streamed) onDelta(text, true);
      return { text, error: true };
    };

    if (!skipGpu) {
      let { lengthError, hitMaxTokens } = await generate(maxTokens, false);

      if (!this.isUnusable(source, output, hitMaxTokens)) {
        if (lengthError) throw lengthError;
        if (!hitMaxTokens) return { text: output };

        const larger = Math.min(available, Math.max(maxTokens * 4, 128));
        if (larger > maxTokens) {
          const retry = await generate(larger, true);
          lengthError = retry.lengthError;
          hitMaxTokens = retry.hitMaxTokens;
          if (!this.isUnusable(source, output, hitMaxTokens)) {
            if (lengthError) throw lengthError;
            if (!hitMaxTokens) return { text: output };
            return failVisibleTruncation();
          }
        } else {
          return failVisibleTruncation();
        }
      }

      const salvaged = this.salvageInvisible(source, output, hitMaxTokens);
      if (salvaged !== null) {
        if (streamed) onDelta(salvaged, true);
        return { text: salvaged };
      }
      if (this.isBroken(source, output, hitMaxTokens)) {
        return this.recoverBroken(text, prompt, maxTokens, signal, onDelta, streamed);
      }
      const retried = await this.retryInvisible(
        text,
        source,
        output,
        options,
        signal,
        onDelta,
        streamed,
      );
      if (retried && retried.error !== true) return retried;
      if (lengthError) throw lengthError;
      if (retried) return retried;
    }

    return this.recoverBroken(text, prompt, maxTokens, signal, onDelta, streamed);
  }

  private async tokenCount(text: string, purpose: 'prompt' | 'source'): Promise<number> {
    const tokenize = this.runtime.tokenize;
    if (tokenize) {
      try {
        const counted = await tokenize(text);
        if (Number.isFinite(counted) && counted >= 1) return Math.ceil(counted);
      } catch {
        // Heuristic below.
      }
    }
    return purpose === 'source' ? budgetTokens(text) : estimateTokens(text);
  }

  private isBroken(source: string, output: string, hitMaxTokens: boolean): boolean {
    return (
      isBrokenTranslation(source, output, hitMaxTokens) ||
      isBrokenTranslation(source, cleanModelOutput(output), hitMaxTokens)
    );
  }

  private isUnusable(source: string, output: string, hitMaxTokens: boolean): boolean {
    return (
      this.isBroken(source, output, hitMaxTokens) ||
      isInvisibleRunawayOutput(source, output, hitMaxTokens)
    );
  }

  /**
   * A joiner storm on top of a real translation is still a runaway, but the
   * cleaned visible text can be shown instead of failing the piece. Truncated
   * completions (`length` / hitMaxTokens) are not salvaged: they would look
   * finished and get cached.
   */
  private salvageInvisible(source: string, output: string, hitMaxTokens: boolean): string | null {
    if (hitMaxTokens) return null;
    if (this.isBroken(source, output, hitMaxTokens)) return null;
    if (!isInvisibleRunawayOutput(source, output, hitMaxTokens)) return null;
    const cleaned = cleanModelOutput(output);
    if (!hasTranslatableText(cleaned)) return null;
    if (isInvisibleRunawayOutput(source, cleaned, hitMaxTokens)) return null;
    return cleaned;
  }

  /**
   * A format-character collapse that is not a GPU kernel repeat retries once with a
   * stricter strip. The already-painted garbage is replaced with the source first.
   */
  private async retryInvisible(
    original: string,
    careful: string,
    output: string,
    options: TranslateOptions,
    signal: AbortSignal,
    onDelta: DeltaSink,
    streamed: boolean,
  ): Promise<PieceOutput | null> {
    if (!this.isUnusable(careful, output, true)) {
      return null;
    }

    const aggressive = sanitizeTranslationInput(original, 'aggressive');
    const canRetry = aggressive !== careful && hasTranslatableText(aggressive);
    if (streamed) onDelta(original, true);
    if (!canRetry) {
      return { text: original, error: true };
    }

    const tgt = plamoPromptTargetLanguage(options.tgt);
    if (tgt.length === 0) return { text: original, error: true };
    const src = options.src === undefined ? null : canonicalLanguage(options.src);
    const glossary = sanitizeGlossary(options.glossary ?? []).filter((entry) =>
      aggressive.includes(entry.source),
    );
    const prompt = buildTranslationPrompt({
      text: aggressive,
      tgt,
      ...(src !== null ? { src } : {}),
      ...(tgt === 'ja' || tgt === JA_EASY_TARGET ? { form: options.form } : {}),
      ...(glossary.length > 0 ? { glossary } : {}),
      ...(options.context ? { context: options.context } : {}),
    });
    const available = this.contextTokens - (await this.tokenCount(prompt, 'prompt')) - 8;
    if (available < 16) return { text: original, error: true };

    let recovered = '';
    try {
      const result = await this.runtime.complete({
        prompt,
        maxTokens: Math.min(
          completionTokenBudget(aggressive, await this.tokenCount(aggressive, 'source')),
          available,
        ),
        signal,
        onToken: (delta) => {
          recovered += delta;
        },
      });
      if (!this.isUnusable(aggressive, recovered, result?.hitMaxTokens === true)) {
        if (recovered.length > 0) onDelta(recovered, true);
        return { text: recovered };
      }
      const salvaged = this.salvageInvisible(aggressive, recovered, result?.hitMaxTokens === true);
      if (salvaged !== null) {
        onDelta(salvaged, true);
        return { text: salvaged };
      }
    } catch (error) {
      if (signal.aborted || isAbortError(error)) throw error;
      if (!isLengthTruncation(error)) throw error;
      if (!this.isUnusable(aggressive, recovered, true)) throw error;
      const salvaged = this.salvageInvisible(aggressive, recovered, true);
      if (salvaged !== null) {
        onDelta(salvaged, true);
        return { text: salvaged };
      }
    }

    onDelta(original, true);
    return { text: original, error: true };
  }

  /**
   * A collapsed GPU piece retries on CPU. The rest of the page stays on WebGPU.
   * Broken tokens that already painted are replaced with the source immediately,
   * so they never stay on screen while the retry loads. If that retry is also a
   * collapsed string, the source stays and the chunk is marked untranslated.
   */
  private async recoverBroken(
    text: string,
    prompt: string,
    maxTokens: number,
    signal: AbortSignal,
    onDelta: DeltaSink,
    streamed: boolean,
  ): Promise<PieceOutput> {
    if (streamed) onDelta(text, true);

    if (this.runtime.backend === 'webgpu') {
      this.degenerateHits += 1;
      this.onDegenerateBlock?.();
      let retry: LlamaRuntime | null = null;
      try {
        retry = await this.getRetryRuntime(signal);
      } catch (error) {
        if (signal.aborted || isAbortError(error)) throw error;
      }
      if (retry) {
        try {
          let recovered = '';
          const result = await retry.complete({
            prompt,
            maxTokens,
            signal,
            onToken: (delta) => {
              recovered += delta;
            },
          });
          if (
            !this.isUnusable(
              sanitizeTranslationInput(text),
              recovered,
              result?.hitMaxTokens === true,
            )
          ) {
            if (recovered.length > 0) onDelta(recovered, true);
            return { text: recovered };
          }
        } catch (error) {
          if (signal.aborted || isAbortError(error)) throw error;
        }
      }
    }

    if (!streamed && text.length > 0) onDelta(text, true);
    return { text, error: true };
  }

  private getRetryRuntime(signal: AbortSignal): Promise<LlamaRuntime | null> {
    if (this.runtime.backend !== 'webgpu') return Promise.resolve(this.runtime);
    if (!this.loadRetryRuntime) return Promise.resolve(null);
    return this.loadRetryRuntime(signal);
  }
}

function isOversized(error: unknown): boolean {
  return isEngineError(error) && error.code === 'invalid-input';
}
