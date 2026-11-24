import { spawn } from 'node:child_process';

const real = process.env.SAKUTTO_E2E_REAL === '1';
const env = { ...process.env };
if (!real) env.SAKUTTO_FAKE_ENGINE = '1';

const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const playwrightArgs = process.argv.slice(2);
if (playwrightArgs[0] === '--') playwrightArgs.shift();

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
      env,
      // Node on Windows rejects `.cmd` shims (pnpm.cmd) unless spawn uses a shell.
      shell: process.platform === 'win32',
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(' ')} exited with ${code ?? 'signal'}`));
    });
  });
}

if (real) {
  await run(pnpm, ['build']);
} else {
  await run('node', ['scripts/sync-licenses.mjs']);
  // The fake-engine build still renders PDFs with pdf.js and loads the ORT WASM assets, so
  // those generated public assets must be present in a clean CI checkout too.
  await run('node', ['scripts/sync-pdfjs.mjs']);
  await run('node', ['scripts/sync-export-font.mjs']);
  await run('node', ['scripts/sync-ocr-runtime.mjs']);
  await run(pnpm, ['exec', 'wxt', 'build']);
}

if (process.env.PLAYWRIGHT_SKIP_INSTALL !== '1') {
  await run(pnpm, ['exec', 'playwright', 'install', 'chromium']);
}
await run(pnpm, ['exec', 'playwright', 'test', ...playwrightArgs]);
