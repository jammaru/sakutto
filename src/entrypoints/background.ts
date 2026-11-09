import { browser } from 'wxt/browser';
import { defineBackground } from 'wxt/utils/define-background';
import { EngineClient } from '@/background/engine-client';
import { OffscreenController } from '@/background/offscreen-lifecycle';
import { installPageActions } from '@/background/page-actions';
import { broadcastModelProgress, shouldWarmDownloadedModel } from '@/background/progress-broadcast';
import { measureQuality } from '@/background/quality';
import { TranslationBroker } from '@/background/translation-broker';
import { grantOriginsFor } from '@/dom/sites';
import { DEFAULT_MODEL_ID, getModel, type ModelId } from '@/engine/model/catalog';
import { hasLicenseConsent } from '@/shared/agreement';
import type { EngineCapabilities } from '@/shared/capabilities';
import { isEngineCapabilities } from '@/shared/capabilities';
import {
  isCacheClearRequest,
  isEngineCapabilitiesRequest,
  isEngineStatusRequest,
  isEngineTierRequest,
  isEngineWarmRequest,
  isModelCancelRequest,
  isOpenSetupRequest,
  isShortcutQuery,
  isSiteGrantRequest,
  isModelDeleteRequest,
  isModelDownloadRequest,
  isModelInspectRequest,
  isModelUseRequest,
  isQualitySampleRequest,
  isWebGpuDebugQuery,
  requestEngineProbe,
  type ModelProgressMessage,
} from '@/shared/messages';
import { resolveShortcutQuery } from '@/shared/shortcut-assignment';
import {
  WEBGPU_DEBUG_STORAGE_KEY,
  isWebGpuDebugProfile,
  offscreenDocumentMatches,
  offscreenDocumentUrl,
  type WebGpuDebugProfile,
} from '@/shared/gpu-diagnostic';
import { ensureSettings } from '@/shared/storage';

const OFFSCREEN_PAGE = 'offscreen.html';
const CAPABILITIES_CACHE_KEY = 'engineCapabilities';

function createOffscreenController(): OffscreenController {
  return new OffscreenController({
    hasDocument: async () => {
      const pageUrl = browser.runtime.getURL(`/${OFFSCREEN_PAGE}`);
      const contexts = await browser.runtime.getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT'],
      });
      return contexts.some((context) => {
        const url = 'documentUrl' in context ? String(context.documentUrl ?? '') : '';
        return offscreenDocumentMatches(url, pageUrl);
      });
    },
    createDocument: async () => {
      const stored = await browser.storage.local.get(WEBGPU_DEBUG_STORAGE_KEY);
      const profile = stored[WEBGPU_DEBUG_STORAGE_KEY];
      await browser.offscreen.createDocument({
        url: offscreenDocumentUrl(OFFSCREEN_PAGE, isWebGpuDebugProfile(profile) ? profile : 'off'),
        reasons: [browser.offscreen.Reason.WORKERS],
        justification:
          'Runs the translation runtime in a document whose workers stay alive independently of the toolbar UI.',
      });
    },
    closeDocument: async () => {
      await browser.offscreen.closeDocument();
    },
  });
}

export default defineBackground(() => {
  const client = new EngineClient(createOffscreenController());
  const broker = new TranslationBroker(client);
  const downloads = new Map<ModelId, AbortController>();
  let capabilitiesCache: EngineCapabilities | null = null;

  broker.start();
  installPageActions(broker);

  async function readCachedCapabilities(): Promise<EngineCapabilities | null> {
    if (capabilitiesCache) return capabilitiesCache;

    const stored = await browser.storage.session.get(CAPABILITIES_CACHE_KEY);
    const value = stored[CAPABILITIES_CACHE_KEY];
    if (isEngineCapabilities(value)) {
      capabilitiesCache = value;
      return value;
    }

    return null;
  }

  async function getEngineCapabilities(): Promise<EngineCapabilities | null> {
    const cached = await readCachedCapabilities();
    if (cached) return cached;

    await client.ensureHost();

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await client.ping();
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)));
        continue;
      }

      const capabilities = await requestEngineProbe();
      if (capabilities) {
        capabilitiesCache = capabilities;
        await browser.storage.session.set({ [CAPABILITIES_CACHE_KEY]: capabilities });
        return capabilities;
      }
    }

    return null;
  }

  async function broadcast(message: ModelProgressMessage): Promise<void> {
    await broadcastModelProgress(message, {
      sendExtension: async (item) => {
        await browser.runtime.sendMessage(item);
      },
      listTabs: () => browser.tabs.query({}),
      sendTab: async (tabId, item) => {
        await browser.tabs.sendMessage(tabId, item);
      },
    });
  }

  async function broadcastStatus(): Promise<void> {
    const status = await client.status().catch(() => null);
    if (!status) return;
    await broadcast({ type: 'model:progress', status: status.model });
  }

  function startDownload(modelId: ModelId): boolean {
    if (downloads.has(modelId)) return true;

    const controller = new AbortController();
    downloads.set(modelId, controller);
    const total = getModel(modelId).size;
    let received = 0;

    void (async () => {
      try {
        const status = await client.downloadModel(modelId, {
          signal: controller.signal,
          onProgress: (progress) => {
            received = progress.received;
            void broadcast({ type: 'model:progress', status: progress });
          },
        });
        await broadcast({ type: 'model:progress', status });
        const current = await client.status().catch(() => null);
        if (shouldWarmDownloadedModel(status, current?.model ?? null)) {
          const warmed = await client.warmModel().catch(() => null);
          if (warmed) await broadcast({ type: 'model:progress', status: warmed });
        }
      } catch (error) {
        if (controller.signal.aborted) {
          await broadcastStatus();
          return;
        }

        await broadcast({
          type: 'model:progress',
          status: {
            id: modelId,
            state: 'error',
            received,
            total,
            progress: Math.min(1, received / total),
            error: error instanceof Error ? error.message : String(error),
          },
        });
      } finally {
        downloads.delete(modelId);
      }
    })();

    return true;
  }

  async function deleteModel(modelId: ModelId) {
    downloads.get(modelId)?.abort();
    downloads.delete(modelId);
    return client.deleteModel(modelId).catch(() => null);
  }

  async function recordCommandAssignments(): Promise<void> {
    const commands = await browser.commands.getAll().catch(() => []);
    await resolveShortcutQuery(commands);
  }

  browser.runtime.onInstalled.addListener(({ reason }) => {
    void (async () => {
      await ensureSettings();
      await recordCommandAssignments();
      if (reason === 'install') {
        await browser.tabs.create({ url: browser.runtime.getURL('/onboarding.html') });
      }
    })().catch(() => undefined);
  });

  let warmStarted = false;

  async function warmStoredModel(): Promise<void> {
    if (warmStarted) return;
    warmStarted = true;
    const settings = await ensureSettings();
    if (!hasLicenseConsent(settings)) return;
    const status = await client.modelStatus(DEFAULT_MODEL_ID).catch(() => null);
    if (!status || (status.state !== 'ready' && status.state !== 'loaded')) return;
    const warmed = await client.warmModel().catch(() => null);
    if (warmed) await broadcast({ type: 'model:progress', status: warmed });
  }

  void warmStoredModel();
  void recordCommandAssignments().catch(() => undefined);
  browser.runtime.onStartup.addListener(() => {
    void warmStoredModel();
    void recordCommandAssignments().catch(() => undefined);
  });

  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== browser.runtime.id) return false;

    if (isEngineCapabilitiesRequest(message)) {
      void getEngineCapabilities().then(sendResponse, () => sendResponse(null));
      return true;
    }

    if (isWebGpuDebugQuery(message)) {
      void browser.storage.local.get(WEBGPU_DEBUG_STORAGE_KEY).then(
        (stored) => {
          const value = stored[WEBGPU_DEBUG_STORAGE_KEY];
          sendResponse((isWebGpuDebugProfile(value) ? value : 'off') satisfies WebGpuDebugProfile);
        },
        () => sendResponse('off' satisfies WebGpuDebugProfile),
      );
      return true;
    }

    if (isEngineStatusRequest(message)) {
      void client.status().then(sendResponse, () => sendResponse(null));
      return true;
    }

    if (isSiteGrantRequest(message)) {
      const origins = grantOriginsFor(sender.tab?.url, message.host);
      if (!origins) {
        sendResponse(false);
        return true;
      }
      // permissions.request() only succeeds in an extension page during a user gesture.
      void browser.permissions
        .contains({ origins })
        .then(async (granted) => {
          if (granted) {
            sendResponse(true);
            return;
          }
          const url = new URL(browser.runtime.getURL('/grant.html'));
          url.searchParams.set('host', message.host);
          await browser.windows.create({
            url: url.toString(),
            type: 'popup',
            width: 420,
            height: 280,
            focused: true,
          });
          sendResponse(false);
        })
        .catch(() => sendResponse(false));
      return true;
    }

    if (isOpenSetupRequest(message)) {
      void browser.tabs.create({ url: browser.runtime.getURL('/onboarding.html') }).then(
        () => sendResponse(true),
        () => sendResponse(false),
      );
      return true;
    }

    if (isShortcutQuery(message)) {
      void browser.commands
        .getAll()
        .then((commands) => resolveShortcutQuery(commands))
        .then(sendResponse, () => sendResponse(null));
      return true;
    }

    if (isEngineWarmRequest(message)) {
      void client.warmModel().then(
        (status) => {
          if (status) void broadcast({ type: 'model:progress', status });
          sendResponse(true);
          // A page translated in the same moment should get the runtime before this sample.
          setTimeout(() => {
            void measureQuality(client);
          }, 15_000);
        },
        () => sendResponse(false),
      );
      return true;
    }

    if (isModelInspectRequest(message)) {
      void client.modelStatus(message.modelId).then(sendResponse, () => sendResponse(null));
      return true;
    }

    if (isCacheClearRequest(message)) {
      void client.clearCache().then(
        () => sendResponse(true),
        () => sendResponse(false),
      );
      return true;
    }

    if (isEngineTierRequest(message)) {
      void client.setTier(message.tier).then(
        () => sendResponse(true),
        () => sendResponse(false),
      );
      return true;
    }

    if (isQualitySampleRequest(message)) {
      void measureQuality(client).then(sendResponse, () => sendResponse(null));
      return true;
    }

    if (isModelDownloadRequest(message)) {
      void ensureSettings().then(
        (settings) => {
          if (!hasLicenseConsent(settings)) {
            sendResponse(false);
            return;
          }
          sendResponse(startDownload(message.modelId));
        },
        () => sendResponse(false),
      );
      return true;
    }

    if (isModelCancelRequest(message)) {
      downloads.get(message.modelId)?.abort();
      downloads.delete(message.modelId);
      sendResponse(true);
      return false;
    }

    if (isModelDeleteRequest(message)) {
      void deleteModel(message.modelId).then(
        (status) => {
          if (status) void broadcast({ type: 'model:progress', status });
          sendResponse(status);
        },
        () => sendResponse(null),
      );
      return true;
    }

    if (isModelUseRequest(message)) {
      void client.useModel(message.modelId).then(
        (status) => {
          void broadcast({ type: 'model:progress', status });
          sendResponse(status);
        },
        () => sendResponse(null),
      );
      return true;
    }

    return false;
  });
});
