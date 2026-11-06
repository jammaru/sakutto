import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CWS_CLI_BIN,
  CWS_CLI_SPEC,
  DEFAULT_EXTENSION_ID,
  DEFAULT_PUBLISHER_ID,
  REQUIRED_SECRET_NAMES,
  missingSecretNames,
  resolveStoreIds,
  runCwsUpload,
  shouldSubmit,
  type CwsSpawn,
} from '../scripts/cws-upload.ts';

const clientSecret = 'client-secret-value';
const refreshToken = 'refresh-token-value';

function env(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    PATH: '/usr/bin',
    HOME: '/tmp/sakutto-home',
    CLIENT_ID: 'client-id-value',
    CLIENT_SECRET: clientSecret,
    REFRESH_TOKEN: refreshToken,
    GITHUB_TOKEN: 'ghs_should_not_be_forwarded',
    ...overrides,
  };
}

interface RecordedCall {
  command: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
}

function recorder(codeFor: (args: readonly string[]) => number = () => 0): {
  calls: RecordedCall[];
  spawnImpl: CwsSpawn;
} {
  const calls: RecordedCall[] = [];
  const spawnImpl: CwsSpawn = (command, args, childEnv) => {
    calls.push({ command, args, env: childEnv });
    return Promise.resolve(codeFor(args));
  };
  return { calls, spawnImpl };
}

describe('Chrome Web Store CLI credentials', () => {
  it('names only the missing secrets and does not publish unless asked', () => {
    expect(missingSecretNames({})).toEqual([...REQUIRED_SECRET_NAMES]);
    expect(missingSecretNames(env({ CLIENT_SECRET: '   ' }))).toEqual(['CLIENT_SECRET']);
    expect(missingSecretNames(env())).toEqual([]);
    expect(shouldSubmit(env({ CWS_SUBMIT: 'true' }))).toBe(true);
    for (const value of ['false', 'TRUE', ' true', 'true ', '']) {
      expect(shouldSubmit(env({ CWS_SUBMIT: value }))).toBe(false);
    }
    expect(resolveStoreIds(env())).toEqual({
      extensionId: DEFAULT_EXTENSION_ID,
      publisherId: DEFAULT_PUBLISHER_ID,
    });
    expect(resolveStoreIds(env({ EXTENSION_ID: '  abcdef  ', PUBLISHER_ID: '' }))).toEqual({
      extensionId: 'abcdef',
      publisherId: DEFAULT_PUBLISHER_ID,
    });
    expect(() => resolveStoreIds(env({ EXTENSION_ID: 'bad/id' }))).toThrow(/EXTENSION_ID/);
  });

  it('checks credentials without calling the CLI', async () => {
    const { calls, spawnImpl } = recorder();
    const result = await runCwsUpload({ args: ['--check'], env: env(), spawnImpl });
    expect(result).toBe('checked');
    expect(calls).toEqual([]);
  });

  it('fails before the CLI when a secret is missing and does not print it', async () => {
    const { calls, spawnImpl } = recorder();
    const present = 'present-client-id';
    await expect(
      runCwsUpload({
        args: ['--check'],
        env: env({ CLIENT_ID: present, REFRESH_TOKEN: '  ' }),
        spawnImpl,
      }),
    ).rejects.toThrow(/REFRESH_TOKEN/);
    expect(calls).toEqual([]);
    try {
      await runCwsUpload({
        args: ['--check'],
        env: env({ CLIENT_ID: present, REFRESH_TOKEN: '' }),
        spawnImpl,
      });
      expect.unreachable();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain('Values are not printed.');
      expect(message).not.toContain(present);
      expect(message).not.toContain(clientSecret);
    }
  });
});

describe('Chrome Web Store CLI upload', () => {
  it('uploads one zip and does not publish unless CWS_SUBMIT is exactly true', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'sakutto-cws-cli-'));
    try {
      const zip = join(directory, 'sakutto-0.1.1-chrome.zip');
      writeFileSync(zip, 'zip-bytes');
      const uploadOnly = recorder();
      const uploaded = await runCwsUpload({
        args: [directory],
        env: env({ CWS_SUBMIT: 'false', EXTENSION_ID: 'customextensionid' }),
        spawnImpl: uploadOnly.spawnImpl,
      });
      expect(uploaded).toBe('uploaded');
      expect(uploadOnly.calls).toHaveLength(1);
      expect(uploadOnly.calls[0]).toMatchObject({
        command: CWS_CLI_BIN,
        args: ['upload', '--source', zip],
      });
      expect(uploadOnly.calls[0]?.env.EXTENSION_ID).toBe('customextensionid');
      expect(uploadOnly.calls[0]?.env.PUBLISHER_ID).toBe(DEFAULT_PUBLISHER_ID);
      expect(uploadOnly.calls[0]?.env.CLIENT_SECRET).toBe(clientSecret);
      expect(uploadOnly.calls[0]?.env.GITHUB_TOKEN).toBeUndefined();
      expect(uploadOnly.calls[0]?.args.join(' ')).not.toContain(clientSecret);
      expect(Object.keys(uploadOnly.calls[0]?.env ?? {}).sort()).toEqual([
        'CLIENT_ID',
        'CLIENT_SECRET',
        'EXTENSION_ID',
        'HOME',
        'PATH',
        'PUBLISHER_ID',
        'REFRESH_TOKEN',
      ]);

      const submit = recorder();
      const submitted = await runCwsUpload({
        args: [zip],
        env: env({ CWS_SUBMIT: 'true' }),
        spawnImpl: submit.spawnImpl,
      });
      expect(submitted).toBe('submitted');
      expect(submit.calls.map((call) => call.args)).toEqual([
        ['upload', '--source', zip],
        ['publish'],
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('does not publish when upload fails or the submit flag is not exact', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'sakutto-cws-cli-'));
    try {
      const zip = join(directory, 'extension.zip');
      writeFileSync(zip, 'zip-bytes');
      const failed = recorder((args) => (args[0] === 'upload' ? 1 : 0));
      await expect(
        runCwsUpload({
          args: [zip],
          env: env({ CWS_SUBMIT: 'true' }),
          spawnImpl: failed.spawnImpl,
        }),
      ).rejects.toThrow(/upload failed \(1\)/);
      expect(failed.calls.map((call) => call.args[0])).toEqual(['upload']);

      for (const flag of ['TRUE', 'false', undefined]) {
        const { calls, spawnImpl } = recorder();
        const result = await runCwsUpload({
          args: [zip],
          env: env(flag === undefined ? {} : { CWS_SUBMIT: flag }),
          spawnImpl,
        });
        expect(result).toBe('uploaded');
        expect(calls.map((call) => call.args[0])).toEqual(['upload']);
      }

      writeFileSync(join(directory, 'other.zip'), 'other');
      const extra = recorder();
      await expect(
        runCwsUpload({ args: [directory], env: env(), spawnImpl: extra.spawnImpl }),
      ).rejects.toThrow(/found 2/);
      expect(extra.calls).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('does not call the CLI for a bad id or a missing zip, and hides the secret', async () => {
    const { calls, spawnImpl } = recorder();
    const secretId = 'secret-extension-id/segment';
    await expect(
      runCwsUpload({
        args: ['missing.zip'],
        env: env({ EXTENSION_ID: secretId }),
        spawnImpl,
      }),
    ).rejects.toThrow(/EXTENSION_ID/);
    expect(calls).toEqual([]);
    try {
      await runCwsUpload({
        args: ['missing.zip'],
        env: env({ EXTENSION_ID: secretId }),
        spawnImpl,
      });
      expect.unreachable();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain(secretId);
      expect(message).not.toContain(clientSecret);
      expect(message).not.toContain(refreshToken);
    }

    await expect(runCwsUpload({ args: ['missing.zip'], env: env(), spawnImpl })).rejects.toThrow(
      /missing\.zip is missing/,
    );
    expect(calls).toEqual([]);
  });

  it('reports a missing CLI without printing credentials', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'sakutto-cws-cli-'));
    try {
      const zip = join(directory, 'extension.zip');
      writeFileSync(zip, 'zip-bytes');
      await expect(
        runCwsUpload({
          args: [zip],
          env: env({ PATH: '/usr/bin' }),
        }),
      ).rejects.toThrow(new RegExp(CWS_CLI_SPEC.replace('.', '\\.')));
      try {
        await runCwsUpload({ args: [zip], env: env({ PATH: '/usr/bin' }) });
        expect.unreachable();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        expect(message).not.toContain(clientSecret);
        expect(message).not.toContain(refreshToken);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('Chrome Web Store workflow', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));

  it('packages with the existing action and publishes only from the dispatch input', () => {
    const workflow = readFileSync(
      new URL('../.github/workflows/chrome-web-store.yml', import.meta.url),
      'utf8',
    );
    const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
    const trigger = workflow.slice(workflow.indexOf('on:'), workflow.indexOf('concurrency:'));
    expect(trigger).toContain('workflow_dispatch:');
    expect(trigger).toContain('publish:');
    expect(trigger).toContain('default: false');
    expect(trigger).not.toContain('push:');
    expect(trigger).not.toContain('pull_request:');
    expect(trigger).not.toContain('tags:');
    expect(workflow).toContain('uses: ./.github/actions/package-extension');
    expect(workflow).toContain('needs: credentials');
    expect(workflow).toContain('needs: package');
    expect(workflow).toContain('name: chrome-mv3-zip');
    expect(workflow).toContain('node scripts/cws-upload.ts --check');
    expect(workflow).toContain('node scripts/cws-upload.ts store-zip');
    expect(workflow).toContain(CWS_CLI_SPEC);
    expect(workflow).toContain(DEFAULT_EXTENSION_ID);
    expect(workflow).toContain(DEFAULT_PUBLISHER_ID);
    expect(workflow).toContain('secrets.EXTENSION_ID || vars.EXTENSION_ID ||');
    expect(workflow).toContain('secrets.PUBLISHER_ID || vars.PUBLISHER_ID ||');
    expect(workflow).toContain(
      "CWS_SUBMIT: ${{ github.event_name == 'workflow_dispatch' && inputs.publish == true && 'true' || 'false' }}",
    );
    for (const name of REQUIRED_SECRET_NAMES) {
      expect(workflow).toContain(`secrets.${name}`);
    }
    expect(workflow).not.toContain('pnpm zip');
    expect(workflow).not.toContain('pnpm build:wllama');
    expect(workflow).not.toMatch(/GOCSPX|ya29\.|refresh_token=/);
    expect(workflow).not.toMatch(/run:.*\$\{\{\s*secrets\./);
    expect(workflow).not.toContain('chrome-webstore-upload publish');
    expect(workflow).not.toContain('chrome-webstore-upload upload');
    expect(ci).not.toContain('cws-upload');
    expect(ci).not.toContain('chrome-web-store.yml');
    const script = readFileSync(new URL('../scripts/cws-upload.ts', import.meta.url), 'utf8');
    expect(script).toContain("['upload', '--source', zip]");
    expect(script).toContain("['publish']");
    expect(script).toContain('shell: false');
    expect(script).not.toContain('set -x');
    expect(script).not.toMatch(
      /console\.(log|error)\([^)]*(CLIENT_SECRET|REFRESH_TOKEN|clientSecret)/,
    );

    const checked = spawnSync(process.execPath, ['scripts/cws-upload.ts', '--check'], {
      cwd: root,
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        CLIENT_ID: 'super-secret-client',
        CLIENT_SECRET: '   ',
        REFRESH_TOKEN: '',
      },
    });
    expect(checked.status).toBe(1);
    expect(checked.stderr).toContain('CLIENT_SECRET');
    expect(checked.stderr).toContain('REFRESH_TOKEN');
    expect(checked.stderr).not.toContain('super-secret-client');
    expect(checked.stdout).not.toContain('super-secret-client');
  });

  it('documents the OAuth setup, the secrets, the version bump, and the CLI', () => {
    const japanese = readFileSync(new URL('../docs/CWS_UPLOAD.md', import.meta.url), 'utf8');
    const english = readFileSync(new URL('../docs/CWS_UPLOAD.en.md', import.meta.url), 'utf8');
    for (const doc of [japanese, english]) {
      expect(doc).toContain('https://developer.chrome.com/docs/webstore/using-api');
      expect(doc).toContain('https://www.googleapis.com/auth/chromewebstore');
      expect(doc).toContain('https://developers.google.com/oauthplayground');
      expect(doc).toContain('CLIENT_ID');
      expect(doc).toContain('CLIENT_SECRET');
      expect(doc).toContain('REFRESH_TOKEN');
      expect(doc).toContain(DEFAULT_EXTENSION_ID);
      expect(doc).toContain(DEFAULT_PUBLISHER_ID);
      expect(doc).toContain('chrome-webstore-upload upload --source');
      expect(doc).toContain('chrome-webstore-upload publish');
      expect(doc).toContain('pnpm release patch');
      expect(doc).toContain('workflow_dispatch');
      expect(doc).not.toMatch(/GOCSPX|ya29\.|refresh_token=/);
      expect(doc).not.toContain('your-client-secret-value');
    }
    expect(japanese).toContain('2 段階認証');
    expect(japanese).toContain('審査');
    expect(japanese).toContain('です。');
    expect(japanese).toContain('main');
    expect(english).toContain('2-step verification');
    expect(english).toContain('does not run');
    expect(english).toContain('review');
    const releasing = readFileSync(new URL('../docs/RELEASING.md', import.meta.url), 'utf8');
    expect(releasing).toContain('CWS_UPLOAD.md');
    expect(releasing).toContain('CLIENT_SECRET');
  });
});
