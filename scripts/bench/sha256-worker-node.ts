import { parentPort } from 'node:worker_threads';

import {
  createHasherWorker,
  type HasherWorkerRequest,
  type HasherWorkerResponse,
} from '../../src/engine/model/sha256-worker-core.ts';

const port = parentPort;
if (!port) throw new Error('The SHA-256 benchmark worker needs a parent port.');

const handle = createHasherWorker({
  postMessage: (message: HasherWorkerResponse) => port.postMessage(message),
});

port.on('message', (message: HasherWorkerRequest) => {
  handle(message);
});
