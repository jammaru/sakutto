import { isAbortError, EngineError, toEngineError } from '../errors';
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
    const handles: ScheduledHandle[] = [];
    const finishOne = (): void => {
      remaining -= 1;
      if (remaining === 0) stream.end();
    };

    for (const item of work) {
      handles.push(
        this.scheduler.schedule({
          priority: options.priority,
          run: async () => {
            try {
              await this.runWorkItem(item, options, controller.signal, stream);
            } catch (error) {
              if (!isAbortError(error) && !controller.signal.aborted) {
                stream.fail(toEngineError(error));
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
      const output = await this.complete(
        pieces[0] ?? segment.text.trim(),
        options,
        signal,
        (delta) => stream.push({ id: segment.id, textDelta: delta, engine: this.kind }),
      );
      stream.push({ id: segment.id, final: cleanModelOutput(output), engine: this.kind });
      return;
    }

    const translated: string[] = [];
    for (const piece of pieces) {
      throwIfAborted(signal);
      if (translated.length > 0) {
        const separator = sentenceSeparator(options.tgt);
        if (separator.length > 0) {
          stream.push({ id: segment.id, textDelta: separator, engine: this.kind });
        }
      }
      const output = await this.complete(piece, options, signal, (delta) =>
        stream.push({ id: segment.id, textDelta: delta, engine: this.kind }),
      );
      translated.push(cleanModelOutput(output));
    }

    stream.push({
      id: segment.id,
      final: joinTranslatedSentences(translated, options.tgt),
      engine: this.kind,
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
    const output = await this.complete(text, options, signal, (delta) => {
      pending += delta;
      let newline = pending.indexOf('\n');
      while (newline !== -1) {
        const line = cleanModelOutput(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
        newline = pending.indexOf('\n');
        if (line.length === 0 || shown >= segments.length) continue;
        const segment = segments[shown];
        shown += 1;
        if (segment) stream.push({ id: segment.id, textDelta: line, engine: this.kind });
      }
    });
    const cleaned = cleanModelOutput(output);
    const lines =
      cleaned.length === 0 ? [] : cleaned.split('\n').map((line) => cleanModelOutput(line));

    if (lines.length !== segments.length || lines.some((line) => line.length === 0)) {
      await this.completeIndividually(segments, options, signal, stream, shown);
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

      const output = await this.complete(
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
