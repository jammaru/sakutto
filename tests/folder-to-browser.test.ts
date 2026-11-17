import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_MODEL_ID, type ModelId } from '@/engine/model/catalog';
import type { SharedFolderStatus } from '@/engine/model/folder-status';
import { clearStoredSharedFolder } from '@/engine/model/shared-folder';
import { EngineHost, type EngineServices } from '@/engine/offscreen/host';
import type { BackendSelection } from '@/engine/in-browser/backend';
import type { ModelStatus } from '@/shared/engine-status';
import { FakePort, flushTasks } from './support/ports';

vi.mock('wxt/browser', () => ({
  browser: { runtime: { id: 'test-extension' } },
}));

vi.mock('@/engine/model/shared-folder', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/engine/model/shared-folder')>();
  return {
    ...actual,
    clearStoredSharedFolder: vi.fn(async () => undefined),
  };
});

const SELECTION: BackendSelection = {
  tier: 'c8',
  backend: 'cpu-wasm',
  nGpuLayers: 0,
  nThreads: 8,
  nParallel: 1,
  nCtx: 2048,
};

function modelStatus(): ModelStatus {
  return {
    id: DEFAULT_MODEL_ID,
    state: 'absent',
    received: 0,
    total: 1,
    progress: 0,
  };
}

function folderStatus(overrides: Partial<SharedFolderStatus> = {}): SharedFolderStatus {
  return {
    supported: true,
    configured: true,
    permission: 'granted',
    name: 'Sakutto',
    opfsCopies: [],
    integrityIssues: [],
    recordedModels: [DEFAULT_MODEL_ID],
    ...overrides,
  };
}

function emptyFolderStatus(): SharedFolderStatus {
  const status = folderStatus({ configured: false, permission: 'unknown' });
  delete status.name;
  return status;
}

function createServices(copied: readonly ModelId[] = []) {
  const copyPresentModelsToBrowser = vi.fn(async () => [...copied]);
  const services = {
    manager: {
      loadedModel: null,
      status: vi.fn(async () => modelStatus()),
      copyPresentModelsToBrowser,
      unload: vi.fn(async () => undefined),
    },
    router: { activeEngine: null, translate: vi.fn() },
    chrome: { available: true, dispose: vi.fn(async () => undefined) },
    lazy: { kind: 'plamo', reset: vi.fn(), translate: vi.fn() },
    load: vi.fn(async () => ({})),
    selection: SELECTION,
    disposeRetryRuntime: vi.fn(async () => undefined),
  } as unknown as EngineServices;
  return { services, copyPresentModelsToBrowser };
}

function responseValue(port: FakePort): unknown {
  return (port.messagesOfType('response').at(-1) as { value?: unknown } | undefined)?.value;
}

async function switchToBrowser(
  host: EngineHost,
  folder: SharedFolderStatus,
  refreshed = folder,
): Promise<FakePort> {
  const port = new FakePort();
  host.handlePort(port.port);
  (host as unknown as { folderSession: unknown }).folderSession = {
    status: () => folder,
    apply: vi.fn(async () => refreshed),
  };
  port.emit({ type: 'folder-to-browser', requestId: 'f1' });
  await flushTasks();
  return port;
}

beforeEach(() => {
  vi.mocked(clearStoredSharedFolder).mockClear();
});

describe('folder to browser switch', () => {
  it('keeps the handle and recorded models when the folder cannot be read', async () => {
    const { services, copyPresentModelsToBrowser } = createServices([DEFAULT_MODEL_ID]);
    const unreadable = folderStatus({ permission: 'prompt' });
    const port = await switchToBrowser(createHost(services), unreadable);

    expect(copyPresentModelsToBrowser).not.toHaveBeenCalled();
    expect(clearStoredSharedFolder).not.toHaveBeenCalled();
    expect(responseValue(port)).toMatchObject({
      folder: { configured: true, permission: 'prompt', recordedModels: [DEFAULT_MODEL_ID] },
      copied: [],
    });
  });

  it('reports an empty granted folder so Settings can say no models were found', async () => {
    const { services, copyPresentModelsToBrowser } = createServices([]);
    const empty = emptyFolderStatus();
    const port = await switchToBrowser(createHost(services), folderStatus(), empty);

    expect(copyPresentModelsToBrowser).toHaveBeenCalledOnce();
    expect(clearStoredSharedFolder).toHaveBeenCalledOnce();
    expect(responseValue(port)).toMatchObject({
      folder: { configured: false, permission: 'unknown' },
      copied: [],
    });
  });

  it('reports the models that were copied before the handle was dropped', async () => {
    const { services, copyPresentModelsToBrowser } = createServices([DEFAULT_MODEL_ID]);
    const empty = emptyFolderStatus();
    const port = await switchToBrowser(createHost(services), folderStatus(), empty);

    expect(copyPresentModelsToBrowser).toHaveBeenCalledOnce();
    expect(responseValue(port)).toMatchObject({
      folder: { configured: false },
      copied: [DEFAULT_MODEL_ID],
    });
  });
});

function createHost(services: EngineServices): EngineHost {
  return new EngineHost({ createServices: async () => services, idleReleaseMs: 60_000 });
}
