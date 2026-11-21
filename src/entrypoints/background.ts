import { browser } from 'wxt/browser';
import {
  bindPortDisconnectCleanup,
  broadcastRuntimeMessage,
  readRuntimeLastError,
} from '@/shared/runtime-last-error';
import { defineBackground } from 'wxt/utils/define-background';
import { EngineClient } from '@/background/engine-client';
import { OcrRecognitionRequests } from '@/background/ocr-requests';
import { captureActiveSenderTab } from '@/background/image-capture';
import { ModelDownloads } from '@/background/model-downloads';
import { OCR_RECOGNITION_TIMEOUT_MS, type OcrFailureResponse } from '@/engine/offscreen/protocol';
import { createEngineHostController } from '@/background/engine-host-document';
import {
  injectCaptionPages,
  injectGmailBannerPages,
  injectOutlookBannerPages,
  installPageActionListeners,
  installPageActions,
  openPdfForTabReason,
} from '@/background/page-actions';
import {
  gatePageCommand,
  openFolderEnableWindow,
  resumeFolderGrantPending,
} from '@/background/folder-grant';
import { resolveFolderArmCommandTarget } from '@/background/folder-arm-command';
import {
  isFolderArmCommandRequest,
  isFolderGrantCompleteMessage,
  isFolderOpenEnableRequest,
  isFolderResumePendingRequest,
  type FolderGrantCompleteMessage,
  type FolderStorageRefreshedMessage,
} from '@/shared/folder-grant-messages';
import { readFolderGrantPending } from '@/shared/folder-grant-pending';
import { syncCaptionCustomContentScripts } from '@/captions/register-custom';
import { deleteStoredPdf } from '@/background/pdf-store';
import {
  isPdfForgetRequest,
  isPdfInspectRequest,
  isPdfOpenRequest,
  type PdfInspectResult,
  type PdfOpenResult,
} from '@/shared/pdf';
import { tabServesPdf } from '@/background/pdf-detect';
import { isImageCaptureRequest } from '@/shared/image';
import { sendExtensionModelProgress } from '@/background/extension-progress-sink';
import { broadcastModelProgress } from '@/background/progress-broadcast';
import { measureQuality } from '@/background/quality';
import { TranslationBroker } from '@/background/translation-broker';
import { settleCaptionEnableIntent } from '@/captions/sites';
import { hasAllSitesAccess, syncAllSitesContentScripts } from '@/dom/all-sites';
import { settleMailEnableIntent, syncMailContentScripts } from '@/dom/mail-sites';
import { grantOriginsFor } from '@/dom/sites';
import type { ModelId } from '@/engine/model/catalog';
import { OCR_TIER_CATALOG, type OcrTier } from '@/engine/ocr/catalog';
import type { AssetStatus } from '@/engine/model/asset';
import { normalizeSelectedModelId } from '@/engine/model/selection';
import { hasLicenseConsent } from '@/shared/agreement';
import type { EngineCapabilities } from '@/shared/capabilities';
import { isEngineCapabilities } from '@/shared/capabilities';
import { pageReadPlayerResponse } from '@/captions/youtube';
import { pageFetchTimedtext, resolveCaptionFetchUrl } from '@/captions/timedtext';
import {
  isCacheClearRequest,
  isCaptionPlayerResponseRequest,
  isCaptionTimedtextRequest,
  isEngineCapabilitiesRequest,
  isEngineStatusRequest,
  isEngineTierRequest,
  isEngineWarmRequest,
  isModelCancelRequest,
  isOpenSetupRequest,
  isShortcutQuery,
  isSiteGrantRequest,
  isModelAttachRequest,
  isModelDeleteRequest,
  isModelDownloadRequest,
  isModelFolderAdoptRequest,
  isModelFolderDeleteOpfsRequest,
  isModelFolderReloadRequest,
  isModelFolderToBrowserRequest,
  isModelInspectRequest,
  isModelUseRequest,
  isOcrCancelRequest,
  isOcrDeleteRequest,
  isOcrDownloadRequest,
  isOcrInspectRequest,
  isOcrRecognizeRequest,
  isQualitySampleRequest,
  isWebGpuDebugQuery,
  requestEngineProbe,
  type ModelProgressMessage,
  type OcrProgressMessage,
} from '@/shared/messages';
import { resolveShortcutQuery, restoreEmptyCommandShortcuts } from '@/shared/shortcut-assignment';
import {
  WEBGPU_DEBUG_STORAGE_KEY,
  isWebGpuDebugProfile,
  type WebGpuDebugProfile,
} from '@/shared/gpu-diagnostic';
import { ensureSettings, subscribeSettings } from '@/shared/storage';
import {
  CONTENT_LIVENESS_GENERATION_MESSAGE,
  CONTENT_LIVENESS_PORT,
} from '@/shared/content-instance';

const CAPABILITIES_CACHE_KEY = 'engineCapabilities';

/** Only top-level extension grant surfaces may announce that a grant finished. */
function isFolderGrantSurfaceSender(sender: {
  id?: string | undefined;
  url?: string | undefined;
}): boolean {
  if (sender.id !== browser.runtime.id || typeof sender.url !== 'string') return false;
  const path = sender.url.split(/[?#]/)[0] ?? '';
  return path.endsWith('/folder-enable.html') || path.endsWith('/popup.html');
}

const contentLoadGeneration =
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `load-${String(Date.now())}`;

const client = new EngineClient(createEngineHostController());

export default defineBackground(() => {
  // Commands and context menus can wake a cold worker. Install those listeners before any
  // other background setup so the first event after a restart is not lost.
  installPageActionListeners(client);
  const broker = new TranslationBroker(client);
  const downloads = new ModelDownloads(client, broadcast);
  const ocrDownloads = new Map<OcrTier, AbortController>();
  const ocrDownloadTasks = new Map<OcrTier, Promise<AssetStatus<OcrTier>>>();
  const ocrRecognitions = new OcrRecognitionRequests();
  let capabilitiesCache: EngineCapabilities | null = null;

  client.onModelStatus((status) => {
    void broadcast({ type: 'model:progress', status });
  });
  client.onOcrStatus((status) => {
    void broadcast({ type: 'ocr:progress', status });
  });

  broker.start();
  installPageActions(broker, client);
  browser.runtime.onConnect.addListener((port) => {
    if (port.name !== CONTENT_LIVENESS_PORT) {
      bindPortDisconnectCleanup(port);
      return;
    }
    bindPortDisconnectCleanup(port);
    port.postMessage({
      type: CONTENT_LIVENESS_GENERATION_MESSAGE,
      generation: contentLoadGeneration,
    });
    readRuntimeLastError();
    port.onMessage.addListener(() => undefined);
  });
  subscribeSettings((settings) => {
    client.syncStoredSettings(settings);
    void syncCaptionCustomContentScripts(settings.captionCustomHosts);
    void syncMailContentScripts();
    if (settings.translateVideoCaptions) void injectCaptionPages();
    if (settings.gmailTranslateBanner) {
      void injectGmailBannerPages();
      void injectOutlookBannerPages();
    }
  });
  void ensureSettings().then((settings) => {
    void syncCaptionCustomContentScripts(settings.captionCustomHosts);
    void syncMailContentScripts();
    // Live permission state decides: no broad grant means no all-sites registration.
    void syncAllSitesContentScripts();
    if (settings.gmailTranslateBanner) {
      void injectGmailBannerPages();
      void injectOutlookBannerPages();
    }
  });
  browser.permissions.onAdded?.addListener((granted) => {
    void settleCaptionEnableIntent(
      granted.origins ? { grantedOrigins: granted.origins } : undefined,
    );
    void settleMailEnableIntent(granted.origins ? { grantedOrigins: granted.origins } : undefined);
    // Re-read every granted origin: this event names only what was just added, and a
    // broad all-sites grant changes what several narrower origin checks report.
    void syncMailContentScripts();
    void syncAllSitesContentScripts();
    void injectGmailBannerPages();
    void injectOutlookBannerPages();
  });
  browser.permissions.onRemoved?.addListener(() => {
    void syncMailContentScripts();
    void syncAllSitesContentScripts();
  });

  async function syncSource(): Promise<void> {
    const settings = await ensureSettings();
    await client.setSource(settings);
  }

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

  async function broadcast(message: ModelProgressMessage | OcrProgressMessage): Promise<void> {
    await broadcastModelProgress(message, {
      sendExtension: sendExtensionModelProgress,
      listTabs: () => browser.tabs.query({}),
      sendTab: async (tabId, item) => {
        await browser.tabs.sendMessage(tabId, item).catch(() => undefined);
        readRuntimeLastError();
      },
    });
  }

  function startOcrDownload(tier: OcrTier): boolean {
    if (ocrDownloadTasks.has(tier)) return true;
    const controller = new AbortController();
    const total = OCR_TIER_CATALOG[tier].size;
    let received = 0;
    ocrDownloads.set(tier, controller);
    const task = (async () => {
      try {
        const status = await client.downloadOcr(tier, {
          signal: controller.signal,
          onProgress: (progress) => {
            received = progress.received;
            void broadcast({ type: 'ocr:progress', status: progress });
          },
        });
        await broadcast({ type: 'ocr:progress', status });
        return status;
      } catch (error) {
        if (controller.signal.aborted) {
          const status = await client.ocrStatus(tier).catch(() => null);
          if (status) await broadcast({ type: 'ocr:progress', status });
          throw error;
        }
        const status: AssetStatus<OcrTier> = {
          id: tier,
          state: 'error',
          received,
          total,
          progress: Math.min(1, received / total),
          error: error instanceof Error ? error.message : String(error),
        };
        await broadcast({ type: 'ocr:progress', status });
        throw error;
      } finally {
        ocrDownloads.delete(tier);
        ocrDownloadTasks.delete(tier);
      }
    })();
    // The map owns rejection handling for fire-and-forget downloads. Recognition callers await
    // this same task, so a first scanned page never starts a duplicate bundle transfer.
    void task.catch(() => undefined);
    ocrDownloadTasks.set(tier, task);
    return true;
  }

  async function ensureOcrReady(tier: OcrTier): Promise<void> {
    const status = await client.ocrStatus(tier);
    if (status.state === 'ready' || status.state === 'loaded') return;
    // On-demand downloads used to leave the first scanned page waiting on a 23 MB transfer
    // with no visible error when that transfer could not start. Onboarding already offers the
    // bundle; if it is missing, ask the reader to say so instead of waiting forever.
    throw new Error('OCR models are not downloaded.');
  }

  async function deleteModel(modelId: ModelId) {
    // Check before removing the file: after deletion the host may already have selected a
    // fallback model, so only this snapshot says whether page translations used this id.
    const activeBefore = await client.status().catch(() => null);
    const removingActiveModel = activeBefore?.model.id === modelId;

    downloads.abort(modelId);
    if (removingActiveModel) broker.cancelAll();

    const status = await client.deleteModel(modelId).catch(() => null);
    // A port can open while the host is deleting; close anything that raced the snapshot.
    if (removingActiveModel) broker.cancelAll();
    return status;
  }

  async function recordCommandAssignments(restoreEmpty = false): Promise<void> {
    const commands = await browser.commands.getAll().catch(() => []);
    const next = restoreEmpty ? await restoreEmptyCommandShortcuts(commands) : commands;
    await resolveShortcutQuery(next);
  }

  browser.runtime.onInstalled.addListener(({ reason }) => {
    void (async () => {
      if (reason === 'update') await client.bootSource();
      else await syncSource();
      await recordCommandAssignments(reason === 'install' || reason === 'update');
      await syncMailContentScripts();
      await syncAllSitesContentScripts();
      if (reason === 'install') {
        await browser.tabs.create({ url: browser.runtime.getURL('/onboarding.html') });
      }
      await warmStoredModel();
    })().catch(() => undefined);
  });

  let warmStarted = false;

  async function warmStoredModel(): Promise<void> {
    if (warmStarted) return;
    warmStarted = true;
    const settings = await ensureSettings();
    if (!hasLicenseConsent(settings)) return;
    const status = await client
      .modelStatus(normalizeSelectedModelId(settings.selectedModelId))
      .catch(() => null);
    if (!status || (status.state !== 'ready' && status.state !== 'loaded')) return;
    const warmed = await client.warmModel().catch(() => null);
    if (warmed) await broadcast({ type: 'model:progress', status: warmed });
  }

  void syncSource()
    .then(() => warmStoredModel())
    .catch(() => undefined);
  void recordCommandAssignments().catch(() => undefined);
  browser.runtime.onStartup.addListener(() => {
    void syncSource()
      .then(() => warmStoredModel())
      .catch(() => undefined);
    void recordCommandAssignments().catch(() => undefined);
    void syncMailContentScripts();
    void syncAllSitesContentScripts();
  });

  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== browser.runtime.id) return false;

    if (isCaptionPlayerResponseRequest(message)) {
      const tabId = sender.tab?.id;
      if (tabId === undefined) {
        sendResponse(null);
        return true;
      }
      void browser.scripting
        .executeScript({
          target: { tabId },
          world: 'MAIN',
          func: pageReadPlayerResponse,
        })
        .then(
          (results) => sendResponse(results[0]?.result ?? null),
          () => sendResponse(null),
        );
      return true;
    }

    if (isCaptionTimedtextRequest(message)) {
      const tabId = sender.tab?.id;
      const tabUrl = sender.tab?.url ?? sender.url;
      const resolved =
        tabId !== undefined && tabUrl ? resolveCaptionFetchUrl(tabUrl, message.url) : null;
      if (tabId === undefined || !resolved) {
        sendResponse('');
        return true;
      }
      void browser.scripting
        .executeScript({
          target: { tabId },
          world: 'MAIN',
          func: pageFetchTimedtext,
          args: [resolved],
        })
        .then(
          (results) => {
            const value = results[0]?.result;
            sendResponse(typeof value === 'string' ? value : '');
          },
          () => sendResponse(''),
        );
      return true;
    }

    if (isImageCaptureRequest(message)) {
      // The image context-menu click supplies activeTab. Capture is only a fallback after the
      // content-side canvas read failed, so no broad image-origin permission is requested.
      void captureActiveSenderTab(sender).then(sendResponse);
      return true;
    }

    if (isEngineCapabilitiesRequest(message)) {
      void getEngineCapabilities().then(sendResponse, () => sendResponse(null));
      return true;
    }

    if (isPdfForgetRequest(message)) {
      void deleteStoredPdf(message.id);
      return;
    }

    if (isPdfInspectRequest(message)) {
      void (async () => {
        const tab = await browser.tabs.get(message.tabId).catch(() => null);
        const pdf = tab ? await tabServesPdf({ id: tab.id, url: tab.url }) : false;
        sendResponse({ pdf } satisfies PdfInspectResult);
      })();
      return true;
    }

    if (isPdfOpenRequest(message)) {
      void (async () => {
        const target =
          message.url === undefined
            ? await browser.tabs
                .get(message.tabId)
                .then((tab) => ({ id: tab.id, url: tab.url }))
                .catch(() => null)
            : { id: message.tabId, url: message.url };
        const reason = await openPdfForTabReason(target ?? undefined, message.pages ?? 0);
        sendResponse(
          reason === null
            ? ({ opened: true } satisfies PdfOpenResult)
            : ({
                opened: false,
                reason: reason === 'no-tab' ? 'not-pdf' : reason,
              } satisfies PdfOpenResult),
        );
      })();
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

    if (isFolderOpenEnableRequest(message)) {
      void openFolderEnableWindow().then(sendResponse);
      return true;
    }

    if (isFolderResumePendingRequest(message)) {
      void resumeFolderGrantPending(client).then(sendResponse);
      return true;
    }

    if (isFolderArmCommandRequest(message)) {
      const target = resolveFolderArmCommandTarget(message, sender);
      if (!target) {
        sendResponse(null);
        return true;
      }
      void gatePageCommand(client, target.tabId, target.command, target.frameId).then(sendResponse);
      return true;
    }

    if (isFolderGrantCompleteMessage(message)) {
      if (!isFolderGrantSurfaceSender(sender)) {
        sendResponse(false);
        return true;
      }
      void (async () => {
        // Prefer the tab that deferred its command. The iframe sender is a fallback for a
        // selection grant where no command was pending.
        const pending = await readFolderGrantPending();
        const tabId = pending?.tabId ?? sender.tab?.id;
        if (tabId === undefined) {
          sendResponse(false);
          return;
        }
        const complete: FolderGrantCompleteMessage = { type: 'folder:grant-complete' };
        await browser.tabs
          .sendMessage(
            tabId,
            complete,
            pending?.frameId === undefined ? {} : { frameId: pending.frameId },
          )
          .catch(() => undefined);
        const refreshed: FolderStorageRefreshedMessage = { type: 'folder:storage-refreshed' };
        await broadcastRuntimeMessage(refreshed);
        sendResponse(true);
      })();
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
        .then(async (commands) => ({
          ...(await resolveShortcutQuery(commands)),
          allSitesAccess: await hasAllSitesAccess(),
        }))
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

    if (isOcrInspectRequest(message)) {
      void client.ocrStatus(message.tier).then(sendResponse, () => sendResponse(null));
      return true;
    }

    if (isOcrDownloadRequest(message)) {
      void ensureSettings().then(
        (settings) => {
          if (!hasLicenseConsent(settings)) {
            sendResponse(false);
            return;
          }
          sendResponse(startOcrDownload(message.tier));
        },
        () => sendResponse(false),
      );
      return true;
    }

    if (isOcrCancelRequest(message)) {
      if (message.requestId === undefined) {
        // Download cancellation is a deliberate settings action for the shared tier transfer.
        // It must not abort unrelated recognition callers using the already-loaded model.
        ocrDownloads.get(message.tier)?.abort();
        ocrDownloads.delete(message.tier);
      } else {
        ocrRecognitions.cancel(message.tier, message.requestId);
      }
      sendResponse(true);
      return false;
    }

    if (isOcrDeleteRequest(message)) {
      void (async () => {
        ocrDownloads.get(message.tier)?.abort();
        ocrRecognitions.cancelTier(message.tier);
        const status = await client.deleteOcr(message.tier).catch(() => null);
        if (status) await broadcast({ type: 'ocr:progress', status });
        sendResponse(status);
      })();
      return true;
    }

    if (isOcrRecognizeRequest(message)) {
      const controller = ocrRecognitions.start(message.requestId, message.tier);
      if (!controller) {
        sendResponse(null);
        return false;
      }
      void (async () => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timedOut = new Promise<OcrFailureResponse>((resolve) => {
          timer = setTimeout(() => {
            // Abort both the local and the offscreen side, then answer instead of hanging.
            controller.abort();
            resolve({ __ocrError: 'timeout' });
          }, OCR_RECOGNITION_TIMEOUT_MS);
        });
        const work = (async (): Promise<unknown> => {
          try {
            await ensureOcrReady(message.tier);
            return await client.recognizeOcr(message.tier, message.image, controller.signal);
          } catch (error) {
            (globalThis as { console: Console }).console.error('OCR recognition failed:', error);
            if (controller.signal.aborted) return null;
            // A missing or unusable OCR bundle is actionable; other failures stay generic.
            const fromReadiness =
              error instanceof Error &&
              /OCR model consent|not downloaded|model-missing/iu.test(error.message);
            return fromReadiness
              ? ({ __ocrError: 'model-missing' } satisfies OcrFailureResponse)
              : null;
          }
        })();
        try {
          sendResponse(await Promise.race([work, timedOut]));
        } finally {
          if (timer !== undefined) clearTimeout(timer);
          ocrRecognitions.finish(message.requestId, controller);
        }
      })();
      return true;
    }

    if (isModelAttachRequest(message)) {
      void downloads.attach(message.modelId).then(sendResponse, () => sendResponse(null));
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
          sendResponse(downloads.start(message.modelId));
        },
        () => sendResponse(false),
      );
      return true;
    }

    if (isModelCancelRequest(message)) {
      void downloads.cancel(message.modelId);
      sendResponse(true);
      return false;
    }

    if (isModelDeleteRequest(message)) {
      void deleteModel(message.modelId).then(
        async (status) => {
          if (status) {
            await broadcast({ type: 'model:progress', status });
            if (status.state === 'absent') {
              const current = await client.status().catch(() => null);
              if (
                current &&
                (current.model.id !== status.id || current.model.state !== status.state)
              ) {
                await broadcast({ type: 'model:progress', status: current.model });
              }
            }
          }
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

    if (isModelFolderReloadRequest(message)) {
      void client.reloadModelFolder().then(sendResponse, () => sendResponse(null));
      return true;
    }

    if (isModelFolderDeleteOpfsRequest(message)) {
      void client.deleteOpfsCopy(message.modelId).then(sendResponse, () => sendResponse(null));
      return true;
    }

    if (isModelFolderAdoptRequest(message)) {
      void client.adoptModelFolder().then(sendResponse, () => sendResponse(null));
      return true;
    }

    if (isModelFolderToBrowserRequest(message)) {
      void client.moveModelFolderToBrowser().then(sendResponse, () => sendResponse(null));
      return true;
    }

    return false;
  });
});
