import { spawn } from 'node:child_process';

const real = process.env.SAKUTTO_E2E_REAL === '1';
const env = { ...process.env };
if (!real) env.SAKUTTO_FAKE_ENGINE = '1';

const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', env });
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
  await run(pnpm, ['exec', 'wxt', 'build']);
}

if (process.env.PLAYWRIGHT_SKIP_INSTALL !== '1') {
  await run(pnpm, ['exec', 'playwright', 'install', 'chromium']);
}
await run(pnpm, ['exec', 'playwright', 'test']);
