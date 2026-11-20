#!/usr/bin/env node
/**
 * Offline synthetic caption trace replay. No video, YouTube request, or network API is used.
 *
 *   node scripts/caption-replay.ts
 *   node scripts/caption-replay.ts --trace traces/local.json --latencies 150,400,900
 *   node scripts/caption-replay.ts --metrics-only
 */
import { readFile, writeFile } from 'node:fs/promises';
import { register } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Vitest resolves these aliases for tests. Register the equivalent resolver for plain Node.
const sourceRoot = new URL('../src/', import.meta.url).href;
const loader = `
const SOURCE_ROOT = ${JSON.stringify(sourceRoot)};
export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('@/')) {
    return nextResolve(new URL(specifier.slice(2) + '.ts', SOURCE_ROOT).href, context);
  }
  if (specifier.startsWith('.') && !/\\.(?:js|ts|mjs|cjs|json)$/u.test(specifier)) {
    try { return await nextResolve(specifier + '.ts', context); } catch {}
  }
  return nextResolve(specifier, context);
}
`;
register(`data:text/javascript,${encodeURIComponent(loader)}`, pathToFileURL('./'));

interface CliOptions {
  traces: string[];
  latencies: Array<150 | 400 | 900>;
  out?: string;
  metricsOnly: boolean;
}

function usage(): never {
  console.error(`Usage:
  node scripts/caption-replay.ts [--trace <json>] [--latencies 150,400,900] [--out <json>] [--metrics-only]

With no --trace, both hand-written EN and JA fixtures are replayed. The JSON result contains
metrics, translation requests, and the complete sampled frame timeline (unless --metrics-only).
`);
  process.exit(2);
}

function args(argv: string[]): CliOptions {
  const traces: string[] = [];
  let latencies: Array<150 | 400 | 900> = [150, 400, 900];
  let out: string | undefined;
  let metricsOnly = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--trace') {
      const value = argv[index + 1];
      if (!value) usage();
      traces.push(value);
      index += 1;
    } else if (arg === '--latencies' || arg === '--latency') {
      const value = argv[index + 1];
      if (!value) usage();
      const parsed = value.split(',').map((entry) => Number(entry));
      if (parsed.some((entry) => entry !== 150 && entry !== 400 && entry !== 900)) usage();
      latencies = parsed as Array<150 | 400 | 900>;
      index += 1;
    } else if (arg === '--out') {
      const value = argv[index + 1];
      if (!value) usage();
      out = value;
      index += 1;
    } else if (arg === '--metrics-only') {
      metricsOnly = true;
    } else {
      usage();
    }
  }
  if (traces.length === 0) {
    for (const name of ['en-asr.json', 'ja-asr.json']) {
      traces.push(new URL(`../tests/fixtures/caption-traces/${name}`, import.meta.url).pathname);
    }
  }
  return { traces, latencies, ...(out ? { out } : {}), metricsOnly };
}

async function main(): Promise<void> {
  const cli = args(process.argv.slice(2));
  const { replayCaptionTrace, validateCaptionTrace } = await import('../src/captions/trace.ts');
  const results = [];
  for (const path of cli.traces) {
    const trace = validateCaptionTrace(JSON.parse(await readFile(resolve(path), 'utf8')));
    for (const latencyMs of cli.latencies) {
      const result = await replayCaptionTrace(trace, { latencyMs });
      results.push(cli.metricsOnly ? { ...result, frames: undefined } : result);
      const metrics = result.metrics;
      console.error(
        `${trace.name} latency=${String(latencyMs)}ms ` +
          `active=${String(metrics.activeFrameCount)} ` +
          `blank=${String(metrics.blankTranslationPercentage)}% ` +
          `blankAfterFirst=${String(metrics.blankTranslationFramesAfterFirst)} ` +
          `width/height=${String(metrics.widthChangeCount)}/${String(metrics.heightChangeCount)} ` +
          `dwell min/median=${String(metrics.minTranslationDwellMs)}/${String(metrics.medianTranslationDwellMs)}ms ` +
          `inputs=[${metrics.translationInputLengths.join(',')}] ` +
          `cancellations=${String(metrics.cancellationCount)}`,
      );
    }
  }
  const output = `${JSON.stringify({ results }, null, 2)}\n`;
  if (cli.out) await writeFile(resolve(cli.out), output, 'utf8');
  else process.stdout.write(output);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
