export const QUALITY_PARAGRAPH =
  'The morning train leaves the quiet station while the baker opens a small shop on the corner of the square where children walk to school with bright bags and the river carries fallen leaves toward the wide sea beyond the old stone bridge near the market that opens early for neighbors who buy bread fruit and flowers before work begins across the town today after the rain has washed the dusty road clean again for everyone here.';

export const SHORT_TEXT = 'Sign in to continue';

export const BATCH_SENTENCES = [
  'The library opens at nine.',
  'Please take a numbered ticket.',
  'The east gate is closed today.',
  'Maps are sold at the desk.',
];

export function enginePage(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Engine bench</title>
  </head>
  <body>
    <script type="module">
      import { Wllama } from '/vendor/wllama.js';

      const TAG = '<|plamo:tag|>';
      const MSG = '<|plamo:msg|>';
      const KEY = '<|plamo:key|>';
      const VAL = '<|plamo:val|>';
      const STOP = [TAG, '<|plamo:bos|>'];

      function prompt(text, src, tgt) {
        const source = src || 'en';
        const target = tgt || 'ja';
        let body =
          TAG + 'dataset' + MSG + 'translation' +
          TAG + 'input' + KEY + 'lang' + VAL + source + MSG + text +
          TAG + 'output' + KEY + 'lang' + VAL + target;
        if (target === 'ja') body += KEY + 'form' + VAL + 'polite';
        return body + MSG;
      }

      function estimateTokens(text) {
        let cjk = 0;
        let other = 0;
        for (const character of text) {
          if (/[\\u3040-\\u30ff\\u3400-\\u9fff\\uac00-\\ud7af]/u.test(character)) cjk += 1;
          else if (!/\\s/u.test(character)) other += 1;
        }
        return Math.max(1, Math.ceil(cjk / 2 + other / 4));
      }

      function budget(text) {
        return Math.max(32, estimateTokens(text) * 2 + 16);
      }

      function textOf(result) {
        if (!result || typeof result !== 'object') return '';
        if (typeof result.content === 'string') return result.content.trim();
        const choice = Array.isArray(result.choices) ? result.choices[0] : null;
        if (!choice) return '';
        if (typeof choice.text === 'string') return choice.text.trim();
        if (choice.message && typeof choice.message.content === 'string') return choice.message.content.trim();
        return '';
      }

      function timingsOf(result) {
        const timings = result && result.timings;
        if (!timings || typeof timings !== 'object') return null;
        return {
          promptN: timings.prompt_n ?? null,
          promptMs: timings.prompt_ms ?? null,
          promptPerSecond: timings.prompt_per_second ?? null,
          predictedN: timings.predicted_n ?? null,
          predictedMs: timings.predicted_ms ?? null,
          predictedPerSecond: timings.predicted_per_second ?? null,
        };
      }

      let runtime = null;

      async function loadModel(params) {
        if (runtime) {
          await runtime.exit();
          runtime = null;
        }
        const response = await fetch('/model.gguf');
        if (!response.ok) throw new Error('model fetch failed: ' + response.status);
        const blob = await response.blob();
        const wllama = new Wllama(
          {
            default: new URL('/vendor/wllama.wasm', location.origin).href,
            'wllama.worker.js': new URL('/vendor/wllama-worker.js', location.origin).href,
            'wllama.module.js': new URL('/vendor/wllama-module.js', location.origin).href,
            'wllama.pthread.js': new URL('/vendor/wllama-pthread.js', location.origin).href,
            'wllama.compat.js': new URL('/vendor/wllama-compat-module.js', location.origin).href,
            'wllama.compat.pthread.js': new URL('/vendor/wllama-compat-pthread.js', location.origin).href,
            'wllama.compat.wasm': new URL('/vendor/wllama-compat.wasm', location.origin).href,
          },
          { suppressNativeLog: true },
        );
        const started = performance.now();
        await wllama.loadModel([blob], {
          n_ctx: params.nCtx,
          n_threads: params.nThreads,
          n_gpu_layers: params.nGpuLayers,
          n_parallel: params.nParallel,
          ...(params.nBatch ? { n_batch: params.nBatch } : {}),
          ...(params.nUbatch ? { n_ubatch: params.nUbatch } : {}),
          ...(params.flashAttn ? { flash_attn: true } : {}),
          ...(params.contBatching ? { cont_batching: true } : {}),
          ...(params.cacheType
            ? { cache_type_k: params.cacheType, cache_type_v: params.cacheType }
            : {}),
        });
        runtime = wllama;
        let gpu = false;
        if (navigator.gpu) {
          try {
            gpu = (await navigator.gpu.requestAdapter()) !== null;
          } catch {
            gpu = false;
          }
        }
        return {
          loadMs: Math.round(performance.now() - started),
          threads: wllama.getNumThreads(),
          multithread: wllama.isMultithread(),
          webgpuAdapter: gpu,
          cores: navigator.hardwareConcurrency,
          isolated: crossOriginIsolated,
          bytes: blob.size,
        };
      }

      async function complete(text, cachePrompt, src, tgt) {
        if (!runtime) throw new Error('model is not loaded');
        const started = performance.now();
        let first = null;
        let last = null;
        const pieces = [];
        const returned = await runtime.createCompletion({
          prompt: prompt(text, src, tgt),
          max_tokens: budget(text),
          temperature: 0,
          stop: STOP,
          cache_prompt: cachePrompt,
          stream: true,
          onData: (chunk) => {
            last = chunk;
            const delta = chunk && chunk.choices && chunk.choices[0] && chunk.choices[0].text;
            if (!delta) return;
            if (first === null) first = performance.now() - started;
            pieces.push(delta);
          },
        });
        return {
          ms: Math.round(performance.now() - started),
          ttftMs: first === null ? null : Math.round(first),
          text: pieces.join('').trim(),
          timings: timingsOf(returned) || timingsOf(last),
        };
      }

      async function completeQuiet(text, cachePrompt) {
        if (!runtime) throw new Error('model is not loaded');
        const started = performance.now();
        const result = await runtime.createCompletion({
          prompt: prompt(text),
          max_tokens: budget(text),
          temperature: 0,
          stop: STOP,
          cache_prompt: cachePrompt,
          stream: false,
        });
        return {
          ms: Math.round(performance.now() - started),
          text: textOf(result),
          timings: timingsOf(result),
          usage: result && result.usage ? result.usage : null,
        };
      }

      async function runCase(spec) {
        if (spec.mode === 'lines') {
          const joined = spec.texts.join('\\n');
          const result = await complete(joined, spec.cachePrompt, spec.src, spec.tgt);
          const lines = result.text.split('\\n').map((line) => line.trim()).filter((line) => line.length > 0);
          return { ...result, lineCount: lines.length, expectedLines: spec.texts.length };
        }
        if (spec.mode === 'parallel') {
          const started = performance.now();
          const results = await Promise.all(
            spec.texts.map((text) => complete(text, spec.cachePrompt, spec.src, spec.tgt)),
          );
          return {
            ms: Math.round(performance.now() - started),
            ttftMs: results[0] ? results[0].ttftMs : null,
            text: results.map((result) => result.text).join('\\n'),
            timings: results[0] ? results[0].timings : null,
            lineCount: results.length,
            expectedLines: spec.texts.length,
          };
        }
        if (spec.mode === 'sequence') {
          const parts = [];
          let ms = 0;
          let ttftMs = null;
          for (const text of spec.texts) {
            const result = await complete(text, spec.cachePrompt, spec.src, spec.tgt);
            ms += result.ms;
            if (ttftMs === null) ttftMs = result.ttftMs;
            parts.push(result.text);
          }
          return {
            ms,
            ttftMs,
            text: parts.join('\\n'),
            timings: null,
            lineCount: parts.length,
            expectedLines: spec.texts.length,
          };
        }
        return complete(spec.texts[0], spec.cachePrompt, spec.src, spec.tgt);
      }

      globalThis.sakuttoBench = {
        ready: true,
        loadModel,
        runCase,
        completeQuiet,
      };
    </script>
  </body>
</html>`;
}
