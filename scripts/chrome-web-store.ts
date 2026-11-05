import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const STORE_SECRET_NAMES = [
  'CWS_EXTENSION_ID',
  'CWS_CLIENT_ID',
  'CWS_CLIENT_SECRET',
  'CWS_REFRESH_TOKEN',
  'CWS_PUBLISHER_ID',
] as const;

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const PATH_ID = /^[A-Za-z0-9_-]+$/;
const SUCCESS_STATES = new Set(['SUCCEEDED']);
const PENDING_STATES = new Set(['IN_PROGRESS', 'UPLOAD_IN_PROGRESS', 'NOT_FOUND']);
const FAILURE_STATES = new Set(['FAILED', 'UPLOAD_FAILED']);
const PUBLISH_FAILURES = new Set(['REJECTED', 'CANCELLED', 'ITEM_STATE_UNSPECIFIED']);
const POLL_LIMIT = 60;
const MIN_REDACT_LENGTH = 8;
const ERROR_LIMIT = 4000;

export class StoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StoreError';
  }
}

export interface StoreCredentials {
  extensionId: string;
  publisherId: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export interface StoreRequest {
  method?: string;
  headers?: Record<string, string>;
  body?: Uint8Array | string;
}

export interface StoreResponse {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
}

export type StoreFetch = (url: string, init?: StoreRequest) => Promise<StoreResponse>;

export function skipMessage(): string {
  const names: string[] = [...STORE_SECRET_NAMES];
  const last = names.pop();
  if (last === undefined) return 'Chrome Web Store upload skipped.';
  return `Chrome Web Store upload skipped because ${names.join(', ')}, and ${last} are not all set.`;
}

export function credentialsFromEnv(env: NodeJS.ProcessEnv): StoreCredentials | null {
  const extensionId = (env.CWS_EXTENSION_ID ?? '').trim();
  const clientId = (env.CWS_CLIENT_ID ?? '').trim();
  const clientSecret = (env.CWS_CLIENT_SECRET ?? '').trim();
  const refreshToken = (env.CWS_REFRESH_TOKEN ?? '').trim();
  const publisherId = (env.CWS_PUBLISHER_ID ?? '').trim();
  if (
    extensionId === '' ||
    clientId === '' ||
    clientSecret === '' ||
    refreshToken === '' ||
    publisherId === ''
  ) {
    return null;
  }
  return { extensionId, publisherId, clientId, clientSecret, refreshToken };
}

export function findZip(directory: string): string {
  let zips: string[];
  try {
    zips = listZips(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new StoreError(`zip directory ${directory} is missing`);
    }
    throw error;
  }
  if (zips.length !== 1)
    throw new StoreError(`expected one zip in ${directory}, found ${zips.length}`);
  const zip = zips[0];
  if (zip === undefined) throw new StoreError(`expected one zip in ${directory}, found 0`);
  return zip;
}

function listZips(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...listZips(path));
    else if (entry.isFile() && entry.name.endsWith('.zip')) found.push(path);
  }
  found.sort();
  return found;
}

export async function runStore(options: {
  directory: string;
  env: NodeJS.ProcessEnv;
  fetchImpl?: StoreFetch;
  log?: (message: string) => void;
  sleep?: (ms: number) => Promise<void>;
}): Promise<'skipped' | 'uploaded'> {
  const log = options.log ?? ((message: string) => console.log(message));
  const credentials = credentialsFromEnv(options.env);
  if (!credentials) {
    log(skipMessage());
    return 'skipped';
  }
  try {
    const zip = new Uint8Array(readFileSync(findZip(options.directory)));
    const result = await uploadToStore({
      credentials,
      zip,
      publish: options.env.CWS_PUBLISH === 'true',
      fetchImpl: options.fetchImpl ?? defaultFetch,
      ...(options.sleep ? { sleep: options.sleep } : {}),
    });
    log(result.message);
    return 'uploaded';
  } catch (error) {
    if (error instanceof StoreError) throw error;
    throw new StoreError(clip(redact(errorText(error), secretValues(credentials))));
  }
}

export async function uploadToStore(options: {
  credentials: StoreCredentials;
  zip: Uint8Array;
  publish: boolean;
  fetchImpl: StoreFetch;
  sleep?: (ms: number) => Promise<void>;
}): Promise<{ uploadState: string; published: boolean; message: string }> {
  assertPathId('CWS_EXTENSION_ID', options.credentials.extensionId);
  assertPathId('CWS_PUBLISHER_ID', options.credentials.publisherId);
  const sleep = options.sleep ?? delay;
  const secrets = secretValues(options.credentials);
  try {
    return await uploadPackage(options, secrets, sleep);
  } catch (error) {
    if (error instanceof StoreError) throw error;
    throw new StoreError(clip(redact(errorText(error), secrets)));
  }
}

async function uploadPackage(
  options: {
    credentials: StoreCredentials;
    zip: Uint8Array;
    publish: boolean;
    fetchImpl: StoreFetch;
  },
  secrets: string[],
  sleep: (ms: number) => Promise<void>,
): Promise<{ uploadState: string; published: boolean; message: string }> {
  const token = await accessToken(options.credentials, options.fetchImpl, secrets);
  secrets.push(token);

  const uploaded = await requestJson(
    options.fetchImpl,
    uploadUrl(options.credentials),
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/zip',
      },
      body: options.zip,
    },
    secrets,
  );
  let uploadState = readState(uploaded, 'uploadState');
  const version = readVersion(uploaded);
  for (let attempt = 0; attempt < POLL_LIMIT; attempt += 1) {
    if (SUCCESS_STATES.has(uploadState)) break;
    if (FAILURE_STATES.has(uploadState)) {
      throw new StoreError(`Chrome Web Store upload failed (${uploadState}).`);
    }
    if (!PENDING_STATES.has(uploadState) || attempt === POLL_LIMIT - 1) {
      throw new StoreError(
        uploadState === 'UNKNOWN' || !PENDING_STATES.has(uploadState)
          ? `Chrome Web Store returned an unexpected upload state (${uploadState}).`
          : 'Chrome Web Store upload did not finish.',
      );
    }
    await sleep(5_000);
    const status = await requestJson(
      options.fetchImpl,
      statusUrl(options.credentials),
      { headers: { Authorization: `Bearer ${token}` } },
      secrets,
    );
    uploadState = readState(status, 'lastAsyncUploadState');
  }

  let publishState: string | null = null;
  if (options.publish) {
    const published = await requestJson(
      options.fetchImpl,
      publishUrl(options.credentials),
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: '{}',
      },
      secrets,
    );
    publishState = readState(published, 'state');
    if (PUBLISH_FAILURES.has(publishState)) {
      throw new StoreError(`Chrome Web Store publish was not accepted (${publishState}).`);
    }
    if (publishState === 'UNKNOWN') publishState = 'REQUESTED';
  }

  return {
    uploadState,
    published: publishState !== null,
    message: resultMessage(version, uploadState, publishState),
  };
}

function resultMessage(
  version: string | null,
  uploadState: string,
  publishState: string | null,
): string {
  const label = version ?? 'the package';
  if (publishState === null) {
    return `Uploaded ${label} to the Chrome Web Store (${uploadState}) without publishing.`;
  }
  return `Uploaded ${label} to the Chrome Web Store (${uploadState}) and requested publish (${publishState}).`;
}

async function accessToken(
  credentials: StoreCredentials,
  fetchImpl: StoreFetch,
  secrets: readonly string[],
): Promise<string> {
  const body = new URLSearchParams({
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
    refresh_token: credentials.refreshToken,
    grant_type: 'refresh_token',
  });
  const response = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const payload = await readPayload(response);
  if (!response.ok) {
    throw new StoreError(clip(redact(tokenError(response.status, payload), secrets)));
  }
  const token =
    typeof payload === 'object' && payload !== null
      ? (payload as { access_token?: unknown }).access_token
      : undefined;
  if (typeof token !== 'string' || token.trim() === '') {
    throw new StoreError('Chrome Web Store token response did not include an access token.');
  }
  return token;
}

async function requestJson(
  fetchImpl: StoreFetch,
  url: string,
  init: StoreRequest,
  secrets: readonly string[],
): Promise<unknown> {
  const response = await fetchImpl(url, init);
  const payload = await readPayload(response);
  if (!response.ok) throw new StoreError(clip(redact(apiError(response.status, payload), secrets)));
  return payload;
}

async function readPayload(response: StoreResponse): Promise<unknown> {
  const text = await response.text();
  if (text.trim() === '') return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function tokenError(status: number, payload: unknown): string {
  if (typeof payload === 'object' && payload !== null) {
    const record = payload as { error?: unknown; error_description?: unknown };
    const error = typeof record.error === 'string' ? record.error : '';
    const description =
      typeof record.error_description === 'string' ? record.error_description : '';
    if (error !== '' && /^[A-Za-z0-9_ .-]+$/.test(error)) {
      return `Chrome Web Store token request failed (${status} ${error}${description ? `: ${description}` : ''}).`;
    }
  }
  return `Chrome Web Store token request failed (${status}).`;
}

function apiError(status: number, payload: unknown): string {
  if (typeof payload === 'object' && payload !== null) {
    const error = (payload as { error?: unknown }).error;
    if (typeof error === 'object' && error !== null) {
      const message = (error as { message?: unknown }).message;
      if (typeof message === 'string' && message.trim() !== '') {
        return `Chrome Web Store request failed (${status}): ${message}`;
      }
    }
  }
  return `Chrome Web Store request failed (${status}).`;
}

function readState(payload: unknown, key: string): string {
  if (typeof payload !== 'object' || payload === null) return 'UNKNOWN';
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === 'string' && /^[A-Z0-9_]+$/.test(value) ? value : 'UNKNOWN';
}

function readVersion(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const value = (payload as { crxVersion?: unknown }).crxVersion;
  return typeof value === 'string' && /^\d+\.\d+\.\d+$/.test(value) ? value : null;
}

function assertPathId(label: string, value: string): void {
  if (!PATH_ID.test(value)) throw new StoreError(`${label} is not a single path segment.`);
}

function secretValues(credentials: StoreCredentials): string[] {
  return [
    credentials.clientSecret,
    credentials.refreshToken,
    credentials.clientId,
    credentials.extensionId,
    credentials.publisherId,
  ];
}

function redact(message: string, secrets: readonly string[]): string {
  const hidden = new Set<string>();
  for (const secret of secrets) {
    if (secret.length < MIN_REDACT_LENGTH) continue;
    hidden.add(secret);
    hidden.add(encodeURIComponent(secret));
    const form = new URLSearchParams([['v', secret]]).toString();
    const prefix = 'v=';
    if (form.startsWith(prefix)) hidden.add(form.slice(prefix.length));
  }
  const ordered = [...hidden]
    .filter((secret) => secret.length > 0)
    .sort((left, right) => right.length - left.length);
  let safe = message;
  for (const secret of ordered) safe = safe.split(secret).join('[redacted]');
  return safe;
}

function clip(message: string): string {
  return message.length > ERROR_LIMIT ? message.slice(0, ERROR_LIMIT) : message;
}

function errorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause instanceof Error ? `: ${error.cause.message}` : '';
  return `${error.message}${cause}`;
}

function itemName(credentials: StoreCredentials): string {
  return `publishers/${encodeURIComponent(credentials.publisherId)}/items/${encodeURIComponent(credentials.extensionId)}`;
}

function uploadUrl(credentials: StoreCredentials): string {
  return `https://chromewebstore.googleapis.com/upload/v2/${itemName(credentials)}:upload`;
}

function statusUrl(credentials: StoreCredentials): string {
  return `https://chromewebstore.googleapis.com/v2/${itemName(credentials)}:fetchStatus`;
}

function publishUrl(credentials: StoreCredentials): string {
  return `https://chromewebstore.googleapis.com/v2/${itemName(credentials)}:publish`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

const defaultFetch: StoreFetch = async (url, init) => {
  const request: RequestInit = {
    method: init?.method ?? 'GET',
    redirect: 'error',
  };
  if (init?.headers !== undefined) request.headers = init.headers;
  if (typeof init?.body === 'string') request.body = init.body;
  else if (init?.body !== undefined) {
    const copy = new Uint8Array(init.body.byteLength);
    copy.set(init.body);
    request.body = copy;
  }
  const response = await fetch(url, request);
  return {
    ok: response.ok,
    status: response.status,
    text: () => response.text(),
  };
};

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
  const directory = process.argv[2];
  if (directory === undefined || process.argv.length !== 3) {
    console.error('Usage: node scripts/chrome-web-store.ts <zip-directory>');
    process.exitCode = 1;
    return;
  }
  void runStore({ directory, env: process.env }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

if (isDirectRun()) main();
