import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface RunOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  mode: 'capture' | 'inherit';
}

export function log(message: string): void {
  console.log(`[wllama] ${message}`);
}

export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export async function run(
  command: string,
  args: readonly string[],
  options: Partial<RunOptions> = {},
): Promise<string> {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const mode = options.mode ?? 'capture';

  return await new Promise<string>((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd,
      env,
      windowsHide: true,
      stdio: mode === 'inherit' ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', rejectRun);
    child.on('close', (code) => {
      if (code === 0) {
        resolveRun(stdout.trim());
        return;
      }
      const details = stderr.trim() || stdout.trim();
      rejectRun(
        new Error(
          `${command} ${args.join(' ')} exited with code ${code}${details ? `\n${details}` : ''}`,
        ),
      );
    });
  });
}

export async function readText(path: string): Promise<string> {
  return await readFile(path, 'utf8');
}

export async function writeText(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents, 'utf8');
}

export function sha256(contents: Buffer): string {
  return createHash('sha256').update(contents).digest('hex');
}
