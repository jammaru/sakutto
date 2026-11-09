#!/usr/bin/env node
/**
 * Compare each writing style against Neutral on fixed ja↔en sentences.
 *
 * Prompt checks always run (no model). Real-model checks need a local llama-server
 * with PLaMo 3 Translate weights:
 *
 *   llama-server -m plamo-3-translate-0.8b-Q4_K_M.gguf -ngl 99 -c 4096 --port 11501
 *   pnpm style:eval
 *
 * Optional: SAKUTTO_PLAMO_URL (default http://127.0.0.1:11501)
 *
 * Heuristics flag likely meaning drift or omissions. They are not a substitute for
 * reading the translations. This script does not download weights.
 */
import {
  DEFAULT_TRANSLATION_STYLE,
  TRANSLATION_STYLES,
  resolvePromptContext,
  situationForStyle,
  type TranslationStyle,
} from '../../src/engine/prompt/style.ts';

const BASE = process.env.SAKUTTO_PLAMO_URL ?? 'http://127.0.0.1:11501';
const TAG = '<|plamo:tag|>';
const MSG = '<|plamo:msg|>';
const KEY = '<|plamo:key|>';
const VAL = '<|plamo:val|>';
const INDEX = '<|plamo:index|>';
const ITEM = '<|plamo:item|>';
const BOS = '<|plamo:bos|>';

/**
 * Same PFML3 layout as `src/engine/prompt/pfml3.ts`. Duplicated so this file can run under
 * plain Node without the engine's extensionless imports.
 */
function buildTranslationPrompt(input: {
  text: string;
  tgt: string;
  src?: string;
  form?: 'polite' | 'plain';
  glossary?: readonly { source: string; target: string }[];
  context?: string;
}): string {
  let prompt = `${TAG}dataset${MSG}translation`;
  if (input.context && input.context.trim().length > 0) {
    prompt += `${TAG}context${MSG}${input.context}`;
  }
  if (input.glossary && input.glossary.length > 0) {
    prompt += `${TAG}glossary`;
    for (const entry of input.glossary) {
      prompt += `${INDEX}${entry.source}${ITEM}${entry.target}`;
    }
  }
  prompt += `${TAG}input`;
  if (input.src && input.src.trim().length > 0) {
    prompt += `${KEY}lang${VAL}${input.src}`;
  }
  prompt += `${MSG}${input.text}`;
  prompt += `${TAG}output${KEY}lang${VAL}${input.tgt}`;
  if (input.form !== undefined) {
    prompt += `${KEY}form${VAL}${input.form}`;
  }
  return `${prompt}${MSG}`;
}

interface Sample {
  id: string;
  text: string;
  src: 'ja' | 'en';
  tgt: 'ja' | 'en';
  form?: 'polite' | 'plain';
  glossary?: readonly { source: string; target: string }[];
  numbers: readonly string[];
  entities: readonly string[];
  markup: readonly string[];
}

const SAMPLES: readonly Sample[] = [
  {
    id: 'en-ja-meeting',
    text: 'The meeting on 12 May 2025 at 15:00 was moved to Tokyo Station. Contact <b>Yuki Tanaka</b> at support@example.com. Keep {ticket_id} unchanged.',
    src: 'en',
    tgt: 'ja',
    form: 'polite',
    glossary: [{ source: 'Tokyo Station', target: '東京駅' }],
    numbers: ['12', '2025', '15:00'],
    entities: ['Yuki Tanaka', 'support@example.com'],
    markup: ['<b>', '</b>', '{ticket_id}'],
  },
  {
    id: 'en-ja-plain-count',
    text: 'There are 3 open bugs in Runner. Do not close BUG-2041.',
    src: 'en',
    tgt: 'ja',
    form: 'plain',
    glossary: [{ source: 'Runner', target: 'ランナー機能' }],
    numbers: ['3', '2041'],
    entities: ['BUG-2041'],
    markup: [],
  },
  {
    id: 'ja-en-invoice',
    text: '請求書 INV-8841 の税込金額は 12,800 円です。担当は山田太郎（yamada@example.com）です。プレースホルダ {order_id} はそのまま残してください。',
    src: 'ja',
    tgt: 'en',
    glossary: [{ source: '請求書', target: 'invoice' }],
    numbers: ['8841', '12,800'],
    entities: ['山田太郎', 'yamada@example.com'],
    markup: ['{order_id}'],
  },
  {
    id: 'ja-en-release',
    text: 'PLaMo 3 Translate のバージョン 0.8 を 2026-11-09 に公開しました。コード断片は `n_parallel=4` のままです。',
    src: 'ja',
    tgt: 'en',
    glossary: [{ source: 'PLaMo 3 Translate', target: 'PLaMo 3 Translate' }],
    numbers: ['0.8', '2026-11-09', '4'],
    entities: ['PLaMo 3 Translate'],
    markup: ['`n_parallel=4`'],
  },
];

function promptFor(sample: Sample, style: TranslationStyle): string {
  const context = resolvePromptContext({
    style,
    tgt: sample.tgt,
    src: sample.src,
    context: undefined,
  });
  return buildTranslationPrompt({
    text: sample.text,
    tgt: sample.tgt,
    src: sample.src,
    ...(sample.tgt === 'ja' && sample.form !== undefined ? { form: sample.form } : {}),
    ...(sample.glossary ? { glossary: sample.glossary } : {}),
    ...(context ? { context } : {}),
  });
}

function missing(haystack: string, needles: readonly string[]): string[] {
  return needles.filter((needle) => !haystack.includes(needle));
}

function charLength(value: string): number {
  return [...value].length;
}

interface Flag {
  sample: string;
  style: TranslationStyle;
  reason: string;
}

function evaluate(
  sample: Sample,
  style: TranslationStyle,
  baseline: string,
  output: string,
): Flag[] {
  const flags: Flag[] = [];
  const flag = (reason: string) => {
    flags.push({ sample: sample.id, style, reason });
  };

  if (output.trim().length === 0) {
    flag('empty translation');
    return flags;
  }

  const situation = situationForStyle(style, sample.tgt, sample.src);
  if (situation && output.includes(situation)) {
    flag(`situation sentence leaked into the translation: ${situation}`);
  }

  const ratio = charLength(output) / Math.max(1, charLength(baseline));
  if (ratio < 0.55 || ratio > 1.8) {
    flag(`length ratio vs Neutral is ${ratio.toFixed(2)} (expected 0.55–1.80)`);
  }

  for (const item of missing(output, sample.numbers)) {
    flag(`dropped number ${item}`);
  }
  for (const item of missing(output, sample.entities)) {
    flag(`dropped entity ${item}`);
  }
  for (const item of missing(output, sample.markup)) {
    flag(`dropped markup or placeholder ${item}`);
  }
  if (sample.glossary) {
    for (const entry of sample.glossary) {
      if (!output.includes(entry.target) && !baseline.includes(entry.target)) continue;
      if (!output.includes(entry.target)) flag(`dropped glossary term ${entry.target}`);
    }
  }

  return flags;
}

async function translate(prompt: string): Promise<string> {
  const response = await fetch(`${BASE}/completion`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      prompt,
      temperature: 0,
      top_k: 1,
      n_predict: 384,
      stream: false,
      cache_prompt: false,
      stop: [TAG, BOS],
    }),
  });
  if (!response.ok) {
    throw new Error(`llama-server HTTP ${String(response.status)}: ${await response.text()}`);
  }
  const json = (await response.json()) as { content?: string };
  return (json.content ?? '').trim();
}

async function serverUp(): Promise<boolean> {
  try {
    const response = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1500) });
    if (response.ok) return true;
  } catch {
    // llama-server may not expose /health; a failed completion is the real signal.
  }
  try {
    await translate(
      buildTranslationPrompt({ text: 'Hello.', tgt: 'ja', src: 'en', form: 'polite' }),
    );
    return true;
  } catch {
    return false;
  }
}

function printPromptReport(): void {
  console.log('Prompt construction (no model required)\n');
  for (const sample of SAMPLES) {
    const neutral = promptFor(sample, DEFAULT_TRANSLATION_STYLE);
    const omitted = promptFor(sample, DEFAULT_TRANSLATION_STYLE);
    if (neutral !== omitted) {
      throw new Error(`${sample.id}: Neutral prompt is not stable.`);
    }
    console.log(
      `# ${sample.id}  ${sample.src}→${sample.tgt}${sample.form ? ` form=${sample.form}` : ''}`,
    );
    for (const style of TRANSLATION_STYLES) {
      const built = promptFor(sample, style);
      const same = built === neutral;
      console.log(`  ${style.padEnd(10)} ${same ? 'identical to Neutral' : 'adds context'}`);
      if (!same) {
        const situation = situationForStyle(style, sample.tgt, sample.src);
        console.log(`             context: ${situation ?? '(none)'}`);
      }
    }
    console.log('');
  }
}

async function main(): Promise<void> {
  printPromptReport();

  const live = await serverUp();
  if (!live) {
    console.log(
      `No PLaMo server at ${BASE}. Prompt checks passed. Start llama-server with local ` +
        'PLaMo 3 Translate weights and re-run to compare translations against Neutral.',
    );
    return;
  }

  console.log(`Calling ${BASE}\n`);
  const flags: Flag[] = [];

  for (const sample of SAMPLES) {
    const baseline = await translate(promptFor(sample, DEFAULT_TRANSLATION_STYLE));
    console.log(`# ${sample.id}`);
    console.log(`  neutral   ${baseline.replaceAll('\n', ' / ')}`);
    for (const style of TRANSLATION_STYLES) {
      if (style === DEFAULT_TRANSLATION_STYLE) continue;
      const output = await translate(promptFor(sample, style));
      const found = evaluate(sample, style, baseline, output);
      flags.push(...found);
      const mark = found.length > 0 ? 'FLAG' : 'ok';
      console.log(`  ${style.padEnd(9)} ${mark.padEnd(4)} ${output.replaceAll('\n', ' / ')}`);
      for (const item of found) console.log(`             - ${item.reason}`);
    }
    console.log('');
  }

  if (flags.length > 0) {
    console.error(
      `${String(flags.length)} heuristic flag(s). Read the translations before shipping a style.`,
    );
    process.exitCode = 1;
    return;
  }
  console.log('No heuristic flags against Neutral on these samples.');
}

await main();
