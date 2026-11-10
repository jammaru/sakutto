import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';

import { probeLocalServer, startLocalServerTap } from '../scripts/bench/host.ts';

interface FakeUpstream {
  url: string;
  close(): Promise<void>;
}

const taps: Array<{ close(): Promise<void> }> = [];
const upstreams: FakeUpstream[] = [];

afterEach(async () => {
  for (const tap of taps.splice(0)) await tap.close().catch(() => undefined);
  for (const upstream of upstreams.splice(0)) await upstream.close().catch(() => undefined);
});

function listen(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<FakeUpstream> {
  const server: Server = createServer(handler);
  return new Promise((resolveListen) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('expected a TCP address');
      const fake: FakeUpstream = {
        url: `http://127.0.0.1:${String(address.port)}/v1`,
        close: () =>
          new Promise((resolveClose, reject) => {
            server.closeAllConnections();
            server.close((error) => (error ? reject(error) : resolveClose()));
          }),
      };
      upstreams.push(fake);
      resolveListen(fake);
    });
  });
}

describe('local-server bench tap', () => {
  it('fails preflight when the upstream port is closed', async () => {
    const dead = 'http://127.0.0.1:1/v1';
    await expect(probeLocalServer(dead)).rejects.toThrow(/could not reach/);
    await expect(startLocalServerTap(dead)).rejects.toThrow(/could not reach/);
  });

  it('counts only successful upstream completions, not 502s from a dead relay', async () => {
    const upstream = await listen((request, response) => {
      const path = request.url ?? '/';
      if (path.includes('/models')) {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ data: [] }));
        return;
      }
      if (path.includes('/completions')) {
        const fail = request.headers['x-fail'] === '1';
        response.writeHead(fail ? 500 : 200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ choices: [{ text: 'ok', finish_reason: 'stop' }] }));
        return;
      }
      response.writeHead(404);
      response.end();
    });

    const tap = await startLocalServerTap(upstream.url);
    taps.push(tap);

    const ok = await fetch(`${tap.url}/completions`, { method: 'POST', body: '{}' });
    expect(ok.status).toBe(200);
    expect(tap.completions).toBe(1);

    const failed = await fetch(`${tap.url}/completions`, {
      method: 'POST',
      headers: { 'x-fail': '1' },
      body: '{}',
    });
    expect(failed.status).toBe(500);
    expect(tap.completions).toBe(1);

    await upstream.close();
    upstreams.length = 0;

    const gone = await fetch(`${tap.url}/completions`, { method: 'POST', body: '{}' });
    expect(gone.status).toBe(502);
    expect(tap.completions).toBe(1);
  });
});
