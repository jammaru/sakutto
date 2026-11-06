import { spawn } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { findZip, StoreError } from './chrome-web-store.ts';

export const CWS_CLI_BIN = 'chrome-webstore-upload';
export const CWS_CLI_SPEC = 'chrome-webstore-upload-cli@4.0.2';
export const DEFAULT_EXTENSION_ID = 'mhlbjjijfkoghmcjndgdimhdlfkhadfl';
export const DEFAULT_PUBLISHER_ID = 'a842b3f6-c065-46c2-b77a-0448bd11f52a';
export const REQUIRED_SECRET_NAMES = ['CLIENT_ID', 'CLIENT_SECRET', 'REFRESH_TOKEN'] as const;

const PATH_ID = /^[A-Za-z0-9_-]+$/;

export class CwsCliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CwsCliError';
  }
}

export type CwsSpawn = (
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
) => Promise<number>;

export interface StoreIds {
  extensionId: string;
  publisherId: string;
}

export function missingSecretNames(env: NodeJS.ProcessEnv): string[] {
  return REQUIRED_SECRET_NAMES.filter((name) => !nonempty(env[name]));
}

export function resolveStoreIds(env: NodeJS.ProcessEnv): StoreIds {
  const extensionRaw = env.EXTENSION_ID;
  const publisherRaw = env.PUBLISHER_ID;
  const extensionId = nonempty(extensionRaw) ? extensionRaw.trim() : DEFAULT_EXTENSION_ID;
  const publisherId = nonempty(publisherRaw) ? publisherRaw.trim() : DEFAULT_PUBLISHER_ID;
  if (!PATH_ID.test(extensionId)) {
    throw new CwsCliError('EXTENSION_ID is missing or is not a single path segment.');
  }
  if (!PATH_ID.test(publisherId)) {
    throw new CwsCliError('PUBLISHER_ID is missing or is not a single path segment.');
  }
  return { extensionId, publisherId };
}

export function shouldSubmit(env: NodeJS.ProcessEnv): boolean {
  return env.CWS_SUBMIT === 'true';
}

export async function runCwsUpload(options: {
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  spawnImpl?: CwsSpawn;
}): Promise<'checked' | 'uploaded' | 'submitted'> {
  const missing = missingSecretNames(options.env);
  if (missing.length > 0) {
    throw new CwsCliError(
      `Missing Chrome Web Store credentials: ${missing.join(', ')}. Add them as GitHub Actions repository secrets. Values are not printed.`,
    );
  }
  const ids = resolveStoreIds(options.env);
  const parsed = parseArgs(options.args);
  if (parsed.check) return 'checked';

  const zip = resolveZip(parsed.source);
  const spawnImpl = options.spawnImpl ?? spawnCli;
  const child = cliEnv(options.env, ids);
  await runCli(spawnImpl, ['upload', '--source', zip], child);
  if (!shouldSubmit(options.env)) return 'uploaded';
  await runCli(spawnImpl, ['publish'], child);
  return 'submitted';
}

function parseArgs(args: readonly string[]): { check: true } | { check: false; source: string } {
  if (args.length === 1 && args[0] === '--check') return { check: true };
  if (args.length === 1 && args[0] !== undefined && args[0] !== '') {
    return { check: false, source: args[0] };
  }
  throw new CwsCliError('Usage: node scripts/cws-upload.ts --check | <zip-or-directory>');
}

function resolveZip(source: string): string {
  let info;
  try {
    info = statSync(source);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new CwsCliError(`zip path ${source} is missing`);
    }
    throw new CwsCliError('zip path could not be read');
  }
  if (info.isDirectory()) {
    try {
      return findZip(source);
    } catch (error) {
      if (error instanceof StoreError) throw error;
      throw new CwsCliError('zip directory could not be read');
    }
  }
  if (info.isFile() && source.endsWith('.zip')) return source;
  throw new CwsCliError('zip path is not a directory or a .zip file');
}

function cliEnv(env: NodeJS.ProcessEnv, ids: StoreIds): NodeJS.ProcessEnv {
  const clientId = env.CLIENT_ID;
  const clientSecret = env.CLIENT_SECRET;
  const refreshToken = env.REFRESH_TOKEN;
  if (clientId === undefined || clientSecret === undefined || refreshToken === undefined) {
    throw new CwsCliError('Missing Chrome Web Store credentials. Values are not printed.');
  }
  const next: NodeJS.ProcessEnv = {
    PATH: env.PATH ?? '',
    CLIENT_ID: clientId,
    CLIENT_SECRET: clientSecret,
    REFRESH_TOKEN: refreshToken,
    EXTENSION_ID: ids.extensionId,
    PUBLISHER_ID: ids.publisherId,
  };
  if (env.HOME !== undefined && env.HOME !== '') next.HOME = env.HOME;
  if (env.TMPDIR !== undefined && env.TMPDIR !== '') next.TMPDIR = env.TMPDIR;
  if (env.LANG !== undefined && env.LANG !== '') next.LANG = env.LANG;
  return next;
}

async function runCli(
  spawnImpl: CwsSpawn,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const commandName = args[0];
  if (commandName !== 'upload' && commandName !== 'publish') {
    throw new CwsCliError('Refusing to run chrome-webstore-upload without upload or publish.');
  }
  let code: number;
  try {
    code = await spawnImpl(CWS_CLI_BIN, args, env);
  } catch (error) {
    if (error instanceof CwsCliError) throw error;
    throw new CwsCliError(`chrome-webstore-upload is not on PATH. Install ${CWS_CLI_SPEC}.`);
  }
  if (code !== 0) {
    throw new CwsCliError(`chrome-webstore-upload ${commandName} failed (${String(code)}).`);
  }
}

function spawnCli(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<number> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn(command, args, { env, stdio: 'inherit', shell: false });
    child.on('error', () => {
      if (settled) return;
      settled = true;
      reject(new CwsCliError(`chrome-webstore-upload is not on PATH. Install ${CWS_CLI_SPEC}.`));
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      resolve(code ?? 1);
    });
  });
}

function nonempty(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== '';
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

function main(): void {
  void runCwsUpload({ args: process.argv.slice(2), env: process.env })
    .then((result) => {
      if (result === 'checked') console.log('Chrome Web Store credentials are present.');
      if (result === 'uploaded') {
        console.log('Uploaded to the Chrome Web Store without submitting for review.');
      }
      if (result === 'submitted') {
        console.log('Uploaded the package and submitted it for review.');
      }
    })
    .catch((error: unknown) => {
      if (error instanceof CwsCliError || error instanceof StoreError) console.error(error.message);
      else console.error('Chrome Web Store upload failed.');
      process.exitCode = 1;
    });
}

if (isDirectRun()) main();
