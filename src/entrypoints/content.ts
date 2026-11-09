import { browser } from 'wxt/browser';
import { defineContentScript } from 'wxt/utils/define-content-script';
import { listPageBlocks } from '@/dom/blocks';
import { detectDocumentLanguage } from '@/dom/detect';
import { fakeTranslate } from '@/dom/fake-engine';
import type { OverlayLabels } from '@/dom/overlay';
import { PageSession, preferencesFor } from '@/dom/session';
import { loadSiteRule, pageHost, saveSiteRule, subscribeSiteRules } from '@/dom/sites';
import { DEFAULT_SELECTION_SHORTCUT, matchesShortcut } from '@/shared/shortcuts';
import { t } from '@/shared/i18n';
import {
  isModelProgressMessage,
  isPageCommandRequest,
  isPageInfoRequest,
  isPageStateRequest,
  isShortcutSnapshot,
  requestEngineStatus,
  requestEngineWarm,
  type PageCommandName,
  type PageInfo,
} from '@/shared/messages';
import { loadSettings, subscribeSettings } from '@/shared/storage';
import { translateViaBackground } from '@/shared/translation-client';

interface ContentBridgeGlobal {
  __sakuttoContentBridgeReady?: boolean;
}

const bridge = globalThis as typeof globalThis & ContentBridgeGlobal;

/**
 * The key the user bound to "translate the selection". Chrome only tells a page which keys
 * are bound through the background worker, so this asks once and keeps the manifest default
 * when the answer never arrives. An empty string means the command has no key.
 */
async function readSelectionShortcut(): Promise<string> {
  const response: unknown = await browser.runtime
    .sendMessage({ type: 'commands:shortcuts' })
    .catch(() => undefined);
  if (!isShortcutSnapshot(response)) return DEFAULT_SELECTION_SHORTCUT;
  const selection = response['translate-selection'];
  // A command Chrome did not list is one this page cannot learn about; keep the default.
  if (selection === null) return DEFAULT_SELECTION_SHORTCUT;
  return selection;
}

async function requestSiteAccess(host: string): Promise<boolean> {
  const response = await browser.runtime
    .sendMessage({ type: 'site:grant', host })
    .catch(() => false);
  return response === true;
}

function overlayLabels(): OverlayLabels {
  return {
    original: t('originalLabel'),
    chromeNote: t('chromeTranslationNote'),
    machine: t('machineTranslationTooltip'),
    selectionPending: t('selectionPending'),
    selectionFailed: t('selectionFailed'),
    selectionTitle: t('selectionTitle'),
    selectionIcon: t('selectionIcon'),
    close: t('close'),
    bilingualOn: t('displayNowBilingual'),
    replaceOn: t('displayNowReplace'),
    barLabel: t('pageProgressLabel'),
    barProgress: (done, total) => t('pageProgress', [String(done), String(total)]),
    barRate: (tokens, segments) => t('pageRate', [tokens, segments]),
    barDone: t('pageTranslated'),
    barPartial: (blocks) => t('pagePartial', [String(blocks)]),
    barOriginal: t('restoreThisPage'),
    barAlways: t('alwaysTranslateSite'),
    barAlwaysOn: t('pageAlwaysOn'),
  };
}

function getPageInfo(): PageInfo {
  return {
    lang: document.documentElement.lang,
    translatableBlocks: listPageBlocks(document).length,
  };
}

export default defineContentScript({
  registration: 'runtime',
  main() {
    if (bridge.__sakuttoContentBridgeReady) return;
    if (pageHost(location.href) === null) return;
    bridge.__sakuttoContentBridgeReady = true;

    const host = pageHost(location.href) ?? '';
    // The bound key, or the manifest default until the background answers. An empty string
    // means the user unbound the command, so the page does not answer it at all.
    let selectionShortcut: string = DEFAULT_SELECTION_SHORTCUT;
    let lastCommand = '';
    let lastCommandAt = 0;
    const readBoundSelection = (): void => {
      void readSelectionShortcut().then((shortcut) => {
        selectionShortcut = shortcut;
      });
    };
    readBoundSelection();
    // Chrome has no event for a changed binding. A reader who rebinds and comes back to the
    // page brings it into focus, which is the moment to read the new key.
    window.addEventListener('focus', readBoundSelection);

    const sessionPromise = (async () => {
      const settings = await loadSettings();
      const rule = await loadSiteRule(host);
      const session = new PageSession(document, {
        engine: { translate: __SAKUTTO_FAKE_ENGINE__ ? fakeTranslate : translateViaBackground },
        labels: overlayLabels(),
        preferences: preferencesFor(settings, rule, host),
        onSitePatch: async (patch) => {
          const current = await loadSiteRule(host);
          await saveSiteRule({ ...current, ...patch, host });
        },
        onGrantSite: () => requestSiteAccess(host),
        selectionKey: (event) =>
          selectionShortcut.length > 0 && matchesShortcut(event, selectionShortcut),
      });

      const detected = await detectDocumentLanguage(document);
      session.setDetectedLanguage(detected);

      const applyStored = async (): Promise<void> => {
        const [nextSettings, nextRule] = await Promise.all([loadSettings(), loadSiteRule(host)]);
        session.setLabels(overlayLabels());
        session.setPreferences(preferencesFor(nextSettings, nextRule, host));
      };

      subscribeSettings(() => {
        void applyStored();
      });
      subscribeSiteRules(() => {
        void applyStored();
      });

      if (rule.auto === 'always') {
        if (!__SAKUTTO_FAKE_ENGINE__) {
          void requestEngineWarm();
          void requestEngineTier(session);
        }
        void session.translate();
      }
      return session;
    })();

    const run = async (command: PageCommandName) => {
      const now = Date.now();
      if (lastCommand === command && now - lastCommandAt < 80) {
        return (await sessionPromise).state();
      }
      lastCommand = command;
      lastCommandAt = now;
      const session = await sessionPromise;
      if (!__SAKUTTO_FAKE_ENGINE__) {
        void requestEngineWarm();
        void requestEngineTier(session);
      }
      await session.handle(command);
      return session.state();
    };

    browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (sender.id !== browser.runtime.id) return;
      if (isPageInfoRequest(message)) {
        sendResponse(getPageInfo());
        return;
      }
      if (isModelProgressMessage(message)) {
        if (message.status.state === 'loaded' && !__SAKUTTO_FAKE_ENGINE__) {
          void sessionPromise.then((session) => requestEngineTier(session, true));
        }
        return;
      }
      if (!isPageCommandRequest(message) && !isPageStateRequest(message)) return;

      void sessionPromise.then(async (session) => {
        if (isPageStateRequest(message)) {
          sendResponse(session.state());
          return;
        }
        if (isPageCommandRequest(message)) sendResponse(await run(message.command));
      });
      return true;
    });
  },
});

async function requestEngineTier(session: PageSession, retry = false): Promise<void> {
  try {
    const status = await requestEngineStatus();
    if (status?.tier) session.setTier(status.tier);
    if (retry || status?.model.state === 'loaded') session.retryUntranslated();
  } catch {
    // A load broadcast still re-queues the blocks that failed while the model loaded.
    if (retry) session.retryUntranslated();
  }
}
