import {
  createHasherWorker,
  type HasherWorkerRequest,
  type HasherWorkerResponse,
} from './sha256-worker-core';

interface WorkerScope {
  postMessage(message: HasherWorkerResponse): void;
  onmessage: ((event: MessageEvent<HasherWorkerRequest>) => void) | null;
}

const scope = self as unknown as WorkerScope;
const handle = createHasherWorker(scope);

scope.onmessage = (event: MessageEvent<HasherWorkerRequest>): void => {
  handle(event.data);
};
