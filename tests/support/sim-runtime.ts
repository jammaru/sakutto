import type { BackendKind } from '@/engine/in-browser/backend';
import type { CompletionRequest, LlamaRuntime } from '@/engine/in-browser/runtime';
import { abortError } from '@/engine/errors';
import { PFML3 } from '@/engine/prompt/pfml3';
import { estimateTokens } from '@/engine/text/tokens';

/**
 * Per-token costs for a simulated llama.cpp. These are not measurements of any GPU: the CPU
 * pair is the order of the repo's own CPU bench (`bench/results/after.json`, prompt ~34 tok/s,
 * decode ~21 tok/s), and the GPU pair only says "prefill is far cheaper than decode", which is
 * what the scheduler has to get right on either device.
 */
export interface SimCosts {
  prefillMsPerToken: number;
  decodeMsPerToken: number;
  parallel: number;
  backend: BackendKind;
}

export const CPU_COSTS: SimCosts = {
  prefillMsPerToken: 30,
  decodeMsPerToken: 47,
  parallel: 1,
  backend: 'cpu-wasm',
};

export const GPU_COSTS: SimCosts = {
  prefillMsPerToken: 1,
  decodeMsPerToken: 12,
  // The WebGPU tier loads two sequences with a KV cache per sequence, so the simulator has
  // to model two as well or it would test a shape the extension no longer uses.
  parallel: 2,
  backend: 'webgpu',
};

interface Job {
  request: CompletionRequest;
  promptTokens: number;
  output: string[];
  prefilled: boolean;
  resolve: () => void;
  reject: (error: unknown) => void;
}

/** The text between the input tag and the output tag of a PFML3 prompt. */
export function promptSource(prompt: string): string {
  const input = prompt.lastIndexOf(`${PFML3.tag}input`);
  const start = prompt.indexOf(PFML3.msg, input) + PFML3.msg.length;
  const end = prompt.indexOf(`${PFML3.tag}output`, start);
  return prompt.slice(start, end);
}

/** Two characters per token, the rough shape of Japanese output. */
function tokensOf(text: string): string[] {
  const tokens: string[] = [];
  for (let index = 0; index < text.length; index += 2) tokens.push(text.slice(index, index + 2));
  return tokens;
}

/**
 * One device shared by every slot. A step either prefills one waiting prompt in full or
 * decodes one token for every slot that is already decoding, which is how a new prompt's
 * prefill holds up the slot next to it under continuous batching.
 */
export class SimRuntime implements LlamaRuntime {
  readonly backend: BackendKind;
  readonly threads = 8;
  readonly parallel: number;
  readonly prompts: string[] = [];
  private readonly active: Job[] = [];
  private readonly waiting: Job[] = [];
  private running = false;

  constructor(
    private readonly costs: SimCosts,
    private readonly translate: (source: string) => string = (source) =>
      source
        .split('\n')
        .map((line) => `訳${line}`)
        .join('\n'),
  ) {
    this.backend = costs.backend;
    this.parallel = costs.parallel;
  }

  complete(request: CompletionRequest): Promise<void> {
    this.prompts.push(request.prompt);
    return new Promise((resolve, reject) => {
      const output = tokensOf(this.translate(promptSource(request.prompt))).slice(
        0,
        request.maxTokens,
      );
      this.waiting.push({
        request,
        promptTokens: this.uncachedTokens(request.prompt),
        output,
        prefilled: false,
        resolve,
        reject,
      });
      void this.loop();
    });
  }

  async dispose(): Promise<void> {}

  /**
   * `cache_prompt` keeps the prefix a slot already holds, so only the rest is prefilled.
   * PFML tags are single tokens, not the dozen characters they are spelled with.
   */
  private uncachedTokens(prompt: string): number {
    const previous = this.lastPrompt;
    this.lastPrompt = prompt;
    let shared = 0;
    while (shared < prompt.length && prompt[shared] === previous[shared]) shared += 1;
    const rest = prompt.slice(shared).replace(/<\|plamo:[a-z]+\|>/gu, '§');
    return rest.length === 0 ? 1 : estimateTokens(rest);
  }

  private lastPrompt = '';

  private async loop(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (;;) {
        while (this.active.length < this.parallel && this.waiting.length > 0) {
          const next = this.waiting.shift();
          if (next) this.active.push(next);
        }
        if (this.active.length === 0) return;

        const prefill = this.active.find((job) => !job.prefilled);
        if (prefill) {
          await sleep(prefill.promptTokens * this.costs.prefillMsPerToken);
          prefill.prefilled = true;
          continue;
        }

        await sleep(this.costs.decodeMsPerToken);
        for (const job of [...this.active]) {
          const token = job.output.shift();
          if (token !== undefined && !job.request.signal.aborted) job.request.onToken(token);
          if (job.output.length > 0) continue;
          this.active.splice(this.active.indexOf(job), 1);
          if (job.request.signal.aborted) job.reject(abortError());
          else job.resolve();
        }
      }
    } finally {
      this.running = false;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}
