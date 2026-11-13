import { createSha256, type Sha256Hasher } from './sha256';

export type HasherWorkerRequest =
  | { type: 'init'; preferWasm: boolean }
  | { type: 'update'; data: ArrayBuffer }
  | { type: 'reset' }
  | { type: 'digest'; id: number };

export type HasherWorkerResponse =
  | { type: 'ready' }
  | { type: 'ack'; bytes: number }
  | { type: 'digest'; id: number; hex: string; bytes: number }
  | { type: 'error'; message: string };

export interface HasherWorkerPort {
  postMessage(message: HasherWorkerResponse): void;
}

/**
 * The worker side of the ordered hashing protocol. Every message is chained so updates keep
 * their transfer order even though loading the wasm module and each update are asynchronous.
 */
export function createHasherWorker(port: HasherWorkerPort): (message: HasherWorkerRequest) => void {
  let chain: Promise<void> = Promise.resolve();
  let hasher: Sha256Hasher | null = null;
  let bytesHashed = 0;
  let failed = false;

  const run = async (message: HasherWorkerRequest): Promise<void> => {
    if (failed) return;

    switch (message.type) {
      case 'init':
        hasher = await createSha256({ preferWasm: message.preferWasm });
        bytesHashed = 0;
        port.postMessage({ type: 'ready' });
        return;
      case 'update':
        if (!hasher) throw new Error('The SHA-256 worker was not initialized.');
        hasher.update(new Uint8Array(message.data));
        bytesHashed += message.data.byteLength;
        port.postMessage({ type: 'ack', bytes: message.data.byteLength });
        return;
      case 'reset':
        if (!hasher) throw new Error('The SHA-256 worker was not initialized.');
        hasher.reset();
        bytesHashed = 0;
        port.postMessage({ type: 'ack', bytes: 0 });
        return;
      case 'digest': {
        if (!hasher) throw new Error('The SHA-256 worker was not initialized.');
        const hex = hasher.hex();
        port.postMessage({ type: 'digest', id: message.id, hex, bytes: bytesHashed });
        return;
      }
    }
  };

  return (message: HasherWorkerRequest): void => {
    chain = chain.then(
      () => run(message),
      () => run(message),
    );
    chain = chain.catch((error: unknown) => {
      failed = true;
      port.postMessage({
        type: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
    });
  };
}
