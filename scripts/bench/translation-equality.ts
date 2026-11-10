#!/usr/bin/env node
/**
 * Compare translations from an OpenAI-compatible local server against a saved baseline,
 * using the same PFML3 prompt Sakutto sends to wllama.
 *
 * This does not measure speed. Run it on an Apple Silicon Mac against mlx_lm.server (or
 * LM Studio) and against a dump taken from the built-in engine. Differences across
 * GGUF Q4_K_M and MLX-4bit are expected; a different *prompt* is not.
 *
 *   node scripts/bench/translation-equality.ts --url http://127.0.0.1:8080/v1 --model pfnet/plamo-3-translate-0.8b-MLX-4bit --out mlx.json
 *   node scripts/bench/translation-equality.ts --url http://127.0.0.1:8080/v1 --compare mlx.json
 *
 * Linux CI cannot run MLX. The unit suite (`tests/local-server.test.ts`) checks prompt
 * equality against a mock server instead.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { arg } from './host.ts';
import {
  buildTranslationPrompt,
  TRANSLATION_STOP_TOKENS,
  type PromptInput,
} from '../../src/engine/prompt/pfml3.ts';

interface SentenceFile {
  src: string;
  tgt: string;
  form?: 'polite' | 'plain';
  sentences: string[];
}

interface EqualityRow {
  source: string;
  prompt: string;
  output: string;
}

interface EqualityDump {
  at: string;
  url: string;
  model: string;
  src: string;
  tgt: string;
  form: 'polite' | 'plain' | null;
  rows: EqualityRow[];
}

function usage(): never {
  console.error(`Usage:
  node scripts/bench/translation-equality.ts --url <http://127.0.0.1:8080/v1> [--model <id>] [--out <file>] [--compare <file>] [--sentences <json>]
`);
  process.exit(2);
}

function requireUrl(): string {
  const value = arg('--url');
  if (!value) usage();
  return value.replace(/\/+$/u, '');
}

async function loadSentences(path: string): Promise<SentenceFile> {
  const parsed = JSON.parse(await readFile(path, 'utf8')) as SentenceFile;
  if (!Array.isArray(parsed.sentences) || parsed.sentences.length === 0) {
    throw new Error(`${path} must contain a non-empty sentences array.`);
  }
  return parsed;
}

async function complete(
  url: string,
  model: string,
  prompt: string,
  apiKey: string,
): Promise<string> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
  if (apiKey.length > 0) headers.Authorization = `Bearer ${apiKey}`;

  const response = await fetch(`${url}/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      ...(model.length > 0 ? { model } : {}),
      prompt,
      max_tokens: 128,
      temperature: 0,
      stop: [...TRANSLATION_STOP_TOKENS],
      stream: false,
    }),
  });
  const payload = (await response.json()) as {
    choices?: Array<{ text?: string; message?: { content?: string } }>;
    error?: { message?: string } | string;
  };
  if (!response.ok) {
    const detail =
      typeof payload.error === 'string'
        ? payload.error
        : (payload.error?.message ?? `HTTP ${String(response.status)}`);
    throw new Error(`completions failed: ${detail}`);
  }
  const text = payload.choices?.[0]?.text ?? payload.choices?.[0]?.message?.content ?? '';
  return text.trim();
}

async function main(): Promise<void> {
  const url = requireUrl();
  const model = arg('--model') ?? '';
  const apiKey = arg('--api-key') ?? '';
  const sentencesPath = resolve(
    arg('--sentences') ?? fileURLToPath(new URL('./equality-sentences.json', import.meta.url)),
  );
  const outPath = arg('--out');
  const comparePath = arg('--compare');
  const file = await loadSentences(sentencesPath);
  const form = file.form;

  const rows: EqualityRow[] = [];
  for (const source of file.sentences) {
    const input: PromptInput = {
      text: source,
      src: file.src,
      tgt: file.tgt,
      ...(form !== undefined ? { form } : {}),
    };
    const prompt = buildTranslationPrompt(input);
    const output = await complete(url, model, prompt, apiKey);
    rows.push({ source, prompt, output });
    console.log(`${source} → ${output}`);
  }

  const dump: EqualityDump = {
    at: new Date().toISOString(),
    url,
    model,
    src: file.src,
    tgt: file.tgt,
    form: form ?? null,
    rows,
  };

  if (outPath) {
    await writeFile(resolve(outPath), `${JSON.stringify(dump, null, 2)}\n`);
    console.error(`wrote ${outPath}`);
  }

  if (comparePath) {
    const other = JSON.parse(await readFile(resolve(comparePath), 'utf8')) as EqualityDump;
    let mismatches = 0;
    for (const row of rows) {
      const baseline = other.rows.find((entry) => entry.source === row.source);
      if (!baseline) {
        console.error(`missing baseline for: ${row.source}`);
        mismatches += 1;
        continue;
      }
      if (baseline.prompt !== row.prompt) {
        console.error(`PROMPT DIFF for: ${row.source}`);
        mismatches += 1;
      }
      if (baseline.output !== row.output) {
        console.error(`OUTPUT DIFF for: ${row.source}`);
        console.error(`  a: ${baseline.output}`);
        console.error(`  b: ${row.output}`);
        mismatches += 1;
      }
    }
    if (mismatches > 0) {
      console.error(
        `${String(mismatches)} difference(s). Prompt diffs are a client bug; output diffs across GGUF vs MLX-4bit are expected.`,
      );
      process.exitCode = 1;
      return;
    }
    console.error('No differences.');
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
