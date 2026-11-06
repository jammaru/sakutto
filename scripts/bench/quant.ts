import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type BrowserContext, type Page } from '@playwright/test';

import { DEFAULT_MODEL_ID, getModel } from '../../src/engine/model/catalog.ts';
import { QUALITY_PARAGRAPH, enginePage } from './engine-page.ts';
import { startBenchServer } from './server.ts';

const PINNED_MODEL = getModel(DEFAULT_MODEL_ID);

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

interface Sample {
  id: string;
  src: string;
  tgt: string;
  text: string;
}

interface SampleResult {
  id: string;
  src: string;
  tgt: string;
  source: string;
  text: string;
  ms: number;
  ttftMs: number | null;
  predictedPerSecond: number | null;
  predictedN: number | null;
}

const SAMPLES: readonly Sample[] = [
  { id: 'ui', src: 'en', tgt: 'ja', text: 'Sign in to continue' },
  { id: 'name-year', src: 'en', tgt: 'ja', text: 'Ada Lovelace was born in 1815.' },
  { id: 'url', src: 'en', tgt: 'ja', text: 'See https://example.com/docs/start for the guide.' },
  { id: 'code', src: 'en', tgt: 'ja', text: 'Run npm install, then open src/app.ts.' },
  {
    id: 'instruction',
    src: 'en',
    tgt: 'ja',
    text: 'Please take a numbered ticket and wait by the east gate.',
  },
  { id: 'paragraph', src: 'en', tgt: 'ja', text: QUALITY_PARAGRAPH },
  {
    id: 'ja-en',
    src: 'ja',
    tgt: 'en',
    text: '図書館は9時に開きます。東門は本日閉鎖です。',
  },
  {
    id: 'ambiguous',
    src: 'en',
    tgt: 'ja',
    text: 'The crane lifted the crane from the river.',
  },
];

const MODELS = [
  {
    id: 'Q4_K_M',
    file: PINNED_MODEL.file,
    bytes: PINNED_MODEL.size,
  },
  {
    id: 'Q3_K_M',
    file: 'plamo-3-translate-0.8b-Q3_K_M.gguf',
    bytes: 486_382_208,
  },
  {
    id: 'Q2_K',
    file: 'plamo-3-translate-0.8b-Q2_K.gguf',
    bytes: 410_135_168,
  },
] as const;

function log(message: string): void {
  console.log(`[quant] ${message}`);
}

async function translate(page: Page, sample: Sample): Promise<SampleResult> {
  const result = await page.evaluate(async (input) => {
    const bench = (
      globalThis as unknown as {
        sakuttoBench: {
          runCase(spec: unknown): Promise<{
            ms: number;
            ttftMs: number | null;
            text: string;
            timings: { predictedPerSecond: number | null; predictedN: number | null } | null;
          }>;
        };
      }
    ).sakuttoBench;
    return bench.runCase({
      mode: 'one',
      texts: [input.text],
      cachePrompt: false,
      src: input.src,
      tgt: input.tgt,
    });
  }, sample);
  return {
    id: sample.id,
    src: sample.src,
    tgt: sample.tgt,
    source: sample.text,
    text: result.text,
    ms: result.ms,
    ttftMs: result.ttftMs,
    predictedPerSecond: result.timings?.predictedPerSecond ?? null,
    predictedN: result.timings?.predictedN ?? null,
  };
}

async function runModel(model: (typeof MODELS)[number]): Promise<Record<string, unknown>> {
  const modelPath = resolve(ROOT, 'bench/.cache', model.file);
  const server = await startBenchServer({
    vendorDir: resolve(ROOT, 'public/vendor/wllama'),
    modelPath,
    engineHtml: enginePage(),
  });
  const context: BrowserContext = await chromium.launchPersistentContext(
    resolve(ROOT, 'bench/.quant-profile'),
    {
      headless: false,
      viewport: { width: 800, height: 600 },
      args: ['--headless=new', '--disable-features=Translate,TranslateUI'],
    },
  );
  context.setDefaultTimeout(180_000);
  try {
    const page = await context.newPage();
    await page.goto(`${server.origin}/engine.html`);
    await page.waitForFunction(
      () =>
        (globalThis as unknown as { sakuttoBench?: { ready?: boolean } }).sakuttoBench?.ready ===
        true,
    );
    const cores = await page.evaluate(() => navigator.hardwareConcurrency);
    const loaded = await page.evaluate(
      async (threads) => {
        const bench = (
          globalThis as unknown as {
            sakuttoBench: { loadModel(params: unknown): Promise<Record<string, unknown>> };
          }
        ).sakuttoBench;
        return bench.loadModel({
          nCtx: 2048,
          nThreads: threads,
          nGpuLayers: 0,
          nParallel: 1,
        });
      },
      Math.max(1, Math.min(4, cores)),
    );
    log(`${model.id} loaded in ${String(loaded.loadMs)}ms`);
    const samples: SampleResult[] = [];
    for (const sample of SAMPLES) {
      const result = await translate(page, sample);
      samples.push(result);
      log(`${model.id} ${sample.id} ${String(result.ms)}ms`);
    }
    const predicted = samples
      .map((sample) => sample.predictedPerSecond)
      .filter((value): value is number => value !== null && value > 0);
    const ms = samples.reduce((sum, sample) => sum + sample.ms, 0);
    return {
      id: model.id,
      bytes: model.bytes,
      loadMs: loaded.loadMs,
      threads: loaded.threads,
      webgpuAdapter: loaded.webgpuAdapter,
      totalMs: ms,
      meanPredictedPerSecond:
        predicted.length > 0
          ? Math.round((predicted.reduce((sum, value) => sum + value, 0) / predicted.length) * 10) /
            10
          : null,
      samples,
    };
  } finally {
    await context.close();
    await server.close();
  }
}

async function main(): Promise<void> {
  const models = [];
  for (const model of MODELS) models.push(await runModel(model));
  const result = {
    at: new Date().toISOString(),
    commit: PINNED_MODEL.commit,
    samples: SAMPLES.map((sample) => ({ id: sample.id, src: sample.src, tgt: sample.tgt })),
    models,
  };
  const out = resolve(ROOT, 'bench/results/quant-compare.json');
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(result, null, 2)}\n`);
  log(`wrote ${out}`);
}

await main();
