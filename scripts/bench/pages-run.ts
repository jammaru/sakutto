import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { ROOT, arg, has, log, type BenchTier } from './host.ts';
import { runPageBench, type BenchMode } from './pages-runner.ts';

function mode(): BenchMode {
  const value = arg('--mode') ?? 'mock';
  if (value !== 'mock' && value !== 'live') {
    throw new Error(`--mode must be "mock" or "live", not "${value}".`);
  }
  return value;
}

function tier(): BenchTier {
  const value = arg('--tier') ?? 'auto';
  if (value !== 'auto' && value !== 'g' && value !== 'c8' && value !== 'c4') {
    throw new Error(`--tier must be auto, g, c8 or c4, not "${value}".`);
  }
  return value;
}

async function main(): Promise<void> {
  const runMode = mode();
  const samplesArg = Number(arg('--samples') ?? '1');

  const extension = resolve(arg('--extension') ?? resolve(ROOT, '.output/chrome-mv3'));
  if (!existsSync(resolve(extension, 'manifest.json'))) {
    throw new Error(
      `No built extension at ${extension}. Run "pnpm bench:build:mock" (or "pnpm bench:build:live") first.`,
    );
  }

  const result = await runPageBench({
    mode: runMode,
    extension,
    samples: Number.isInteger(samplesArg) && samplesArg > 0 ? samplesArg : 1,
    ...(arg('--only') !== undefined ? { only: arg('--only') } : {}),
    ...(arg('--run') !== undefined ? { run: arg('--run') } : {}),
    ...(arg('--compare') !== undefined ? { compare: arg('--compare') } : {}),
    ...(arg('--model') !== undefined ? { modelPath: arg('--model') } : {}),
    tier: tier(),
    ...(arg('--history') !== undefined ? { historyPath: resolve(arg('--history') ?? '') } : {}),
    writeHistory: !has('--no-history'),
    writeSummary: !has('--no-summary'),
  });

  console.log(result.table);
  console.log('');
  for (const comparison of result.comparisons) {
    console.log(`${comparison.metric}: ${comparison.text}`);
  }
  if (result.summaryPath) log('page-bench', `summary ${result.summaryPath}`);
  log(
    'page-bench',
    result.historyPath === null
      ? 'history not written (--no-history)'
      : `history ${result.historyPath}`,
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
