import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  STORE_SECRET_NAMES,
  credentialsFromEnv,
  findZip,
  runStore,
  skipMessage,
  uploadToStore,
  type StoreCredentials,
  type StoreFetch,
  type StoreRequest,
} from '../scripts/chrome-web-store.ts';

const credentials: StoreCredentials = {
  extensionId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  publisherId: 'publisher-1',
  clientId: 'client-id',
  clientSecret: 'client-secret',
  refreshToken: 'refresh-token',
};

function env(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    CWS_EXTENSION_ID: credentials.extensionId,
    CWS_PUBLISHER_ID: credentials.publisherId,
    CWS_CLIENT_ID: credentials.clientId,
    CWS_CLIENT_SECRET: credentials.clientSecret,
    CWS_REFRESH_TOKEN: credentials.refreshToken,
    ...overrides,
  };
}

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

function harness(responses: Array<{ status?: number; body: unknown }>): {
  calls: RecordedCall[];
  fetchImpl: StoreFetch;
} {
  const calls: RecordedCall[] = [];
  const fetchImpl: StoreFetch = (url, init) => {
    calls.push(record(url, init));
    const next = responses.shift();
    if (!next) throw new Error(`unexpected request ${url}`);
    const status = next.status ?? 200;
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      text: () => Promise.resolve(JSON.stringify(next.body)),
    });
  };
  return { calls, fetchImpl };
}

function record(url: string, init: StoreRequest | undefined): RecordedCall {
  const body =
    init?.body === undefined
      ? ''
      : typeof init.body === 'string'
        ? init.body
        : Buffer.from(init.body).toString('utf8');
  return {
    url,
    method: init?.method ?? 'GET',
    headers: init?.headers ?? {},
    body,
  };
}

describe('Chrome Web Store credentials', () => {
  it('skips unless every required secret is set', () => {
    expect(skipMessage()).toContain('Chrome Web Store upload skipped');
    for (const name of STORE_SECRET_NAMES) expect(skipMessage()).toContain(name);
    expect(credentialsFromEnv(env())).toEqual(credentials);
    expect(credentialsFromEnv(env({ CWS_PUBLISH: 'false' }))).toEqual(credentials);
    for (const name of STORE_SECRET_NAMES) {
      expect(credentialsFromEnv(env({ [name]: '' }))).toBeNull();
      expect(credentialsFromEnv(env({ [name]: '   ' }))).toBeNull();
    }
  });

  it('logs a skip line and does not call the API when a secret is missing', async () => {
    const logs: string[] = [];
    let called = false;
    const fetchImpl: StoreFetch = () => {
      called = true;
      throw new Error('fetch should not run');
    };
    const result = await runStore({
      directory: tmpdir(),
      env: env({ CWS_REFRESH_TOKEN: '' }),
      fetchImpl,
      log: (message) => logs.push(message),
    });
    expect(result).toBe('skipped');
    expect(called).toBe(false);
    expect(logs).toEqual([skipMessage()]);
    expect(logs.join('\n')).not.toContain('client-secret');
  });
});

describe('Chrome Web Store upload', () => {
  it('uploads the zip and does not publish unless asked', async () => {
    const { calls, fetchImpl } = harness([
      { body: { access_token: 'access-token' } },
      { body: { uploadState: 'SUCCEEDED', crxVersion: '0.1.1' } },
    ]);
    const result = await uploadToStore({
      credentials,
      zip: new Uint8Array(Buffer.from('zip-bytes')),
      publish: false,
      fetchImpl,
    });
    expect(result.published).toBe(false);
    expect(result.message).toBe(
      'Uploaded 0.1.1 to the Chrome Web Store (SUCCEEDED) without publishing.',
    );
    expect(calls.map((call) => call.url)).toEqual([
      'https://oauth2.googleapis.com/token',
      `https://chromewebstore.googleapis.com/upload/v2/publishers/${credentials.publisherId}/items/${credentials.extensionId}:upload`,
    ]);
    expect(calls[0]?.body).toContain('grant_type=refresh_token');
    expect(calls[0]?.body).toContain('refresh_token=refresh-token');
    expect(calls[1]?.method).toBe('POST');
    expect(calls[1]?.headers['Content-Type']).toBe('application/zip');
    expect(calls[1]?.headers.Authorization).toBe('Bearer access-token');
    expect(calls[1]?.body).toBe('zip-bytes');
    expect(result.message).not.toContain('access-token');
    expect(result.message).not.toContain('refresh-token');
    expect(result.message).not.toContain('client-secret');
  });

  it('publishes only after a successful upload when publish is true', async () => {
    const { calls, fetchImpl } = harness([
      { body: { access_token: 'access-token' } },
      { body: { uploadState: 'IN_PROGRESS' } },
      { body: { lastAsyncUploadState: 'SUCCEEDED' } },
      { body: { state: 'PENDING_REVIEW' } },
    ]);
    const slept: number[] = [];
    const result = await uploadToStore({
      credentials,
      zip: new Uint8Array([1, 2, 3]),
      publish: true,
      fetchImpl,
      sleep: (ms) => {
        slept.push(ms);
        return Promise.resolve();
      },
    });
    expect(slept).toEqual([5_000]);
    expect(result.published).toBe(true);
    expect(result.message).toContain('requested publish (PENDING_REVIEW)');
    expect(calls[2]?.url).toContain(':fetchStatus');
    expect(calls[3]?.url).toContain(':publish');
    expect(calls[3]?.method).toBe('POST');
    expect(calls[3]?.body).toBe('{}');
    expect(calls.some((call) => call.url.includes(':publish'))).toBe(true);
  });

  it('does not publish when the upload fails, and redacts token errors', async () => {
    const failed = harness([
      { body: { access_token: 'access-token' } },
      { body: { uploadState: 'FAILED' } },
    ]);
    await expect(
      uploadToStore({
        credentials,
        zip: new Uint8Array([1]),
        publish: true,
        fetchImpl: failed.fetchImpl,
      }),
    ).rejects.toThrow(/upload failed \(FAILED\)/);
    expect(failed.calls.some((call) => call.url.includes(':publish'))).toBe(false);

    const leaked = harness([
      {
        status: 400,
        body: { error: 'invalid_grant', error_description: 'rejected refresh-token' },
      },
    ]);
    await expect(
      uploadToStore({
        credentials,
        zip: new Uint8Array([1]),
        publish: true,
        fetchImpl: leaked.fetchImpl,
      }),
    ).rejects.toThrow(/\[redacted\]/);
    try {
      await uploadToStore({
        credentials,
        zip: new Uint8Array([1]),
        publish: false,
        fetchImpl: harness([
          {
            status: 400,
            body: { error: 'invalid_grant', error_description: 'rejected refresh-token' },
          },
        ]).fetchImpl,
      });
      expect.unreachable();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain('refresh-token');
      expect(message).not.toContain('client-secret');
      expect(message).not.toContain('client-id');
      expect(message).not.toContain('Authorization');
    }
  });

  it('redacts ids and encoded secrets when an error echoes them', async () => {
    const secretCredentials = {
      ...credentials,
      refreshToken: 'super/secret-token',
    };
    const echoed = harness([
      {
        status: 400,
        body: {
          error: 'invalid_grant',
          error_description: `${'y'.repeat(1990)}${secretCredentials.refreshToken} ${encodeURIComponent(secretCredentials.refreshToken)} ${secretCredentials.clientId} ${secretCredentials.extensionId}`,
        },
      },
    ]);
    try {
      await uploadToStore({
        credentials: secretCredentials,
        zip: new Uint8Array([1]),
        publish: true,
        fetchImpl: echoed.fetchImpl,
      });
      expect.unreachable();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain('[redacted]');
      expect(message).not.toContain('super/secr');
      expect(message).not.toContain('super%2F');
      expect(message).not.toContain(secretCredentials.clientId);
      expect(message).not.toContain(secretCredentials.extensionId);
      expect(message).not.toContain(secretCredentials.clientSecret);
    }

    const fetchImpl: StoreFetch = () => {
      throw new Error(
        `connect failed publishers/${credentials.publisherId}/items/${credentials.extensionId}`,
      );
    };
    try {
      await uploadToStore({
        credentials,
        zip: new Uint8Array([1]),
        publish: false,
        fetchImpl,
      });
      expect.unreachable();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain(credentials.publisherId);
      expect(message).not.toContain(credentials.extensionId);
      expect(message).not.toContain(credentials.clientSecret);
    }
  });

  it('does not treat a rejected publish as success', async () => {
    const rejected = harness([
      { body: { access_token: 'access-token' } },
      { body: { uploadState: 'SUCCEEDED', crxVersion: '0.1.1' } },
      { body: { state: 'REJECTED' } },
    ]);
    await expect(
      uploadToStore({
        credentials,
        zip: new Uint8Array([1]),
        publish: true,
        fetchImpl: rejected.fetchImpl,
      }),
    ).rejects.toThrow(/publish was not accepted \(REJECTED\)/);
    expect(rejected.calls.some((call) => call.url.includes(':publish'))).toBe(true);
  });

  it('treats only the string true as a publish request', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'sakutto-cws-'));
    try {
      writeFileSync(join(directory, 'extension.zip'), Buffer.from('zip-bytes'));
      const responses = [
        { body: { access_token: 'access-token' } },
        { body: { uploadState: 'SUCCEEDED', crxVersion: '0.1.1' } },
      ];
      const { calls, fetchImpl } = harness(responses);
      const logs: string[] = [];
      await runStore({
        directory,
        env: env({ CWS_PUBLISH: 'TRUE' }),
        fetchImpl,
        log: (message) => logs.push(message),
      });
      expect(calls.some((call) => call.url.includes(':publish'))).toBe(false);
      expect(logs[0]).toContain('without publishing');
      expect(findZip(directory)).toBe(join(directory, 'extension.zip'));
      writeFileSync(join(directory, 'other.zip'), Buffer.from('other'));
      expect(() => findZip(directory)).toThrow(/found 2/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects an id that is not a single path segment before calling the API', async () => {
    let called = false;
    const fetchImpl: StoreFetch = () => {
      called = true;
      throw new Error('fetch should not run');
    };
    await expect(
      uploadToStore({
        credentials: { ...credentials, extensionId: 'abc/def' },
        zip: new Uint8Array([1]),
        publish: false,
        fetchImpl,
      }),
    ).rejects.toThrow(/CWS_EXTENSION_ID/);
    expect(called).toBe(false);
  });
});
