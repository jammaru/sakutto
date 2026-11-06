import { browser } from 'wxt/browser';
import { defineContentScript } from 'wxt/utils/define-content-script';
import { listPageBlocks } from '@/dom/blocks';
import { detectDocumentLanguage } from '@/dom/detect';
import { fakeTranslate } from '@/dom/fake-engine';
import type { OverlayLabels } from '@/dom/overlay';
import { PageSession, preferencesFor } from '@/dom/session';
import { loadSiteRule, pageHost, saveSiteRule, subscribeSiteRules } from '@/dom/sites';
import { isDefaultAltSShortcut, isPlainAltS } from '@/shared/shortcuts';
import { t } from '@/shared/i18n';
import {
  isModelProgressMessage,
  isPageCommandRequest,
  isPageInfoRequest,
  isPageStateRequest,
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

async function readSelectionShortcut(): Promise<boolean> {
  const response = await browser.runtime
    .sendMessage({ type: 'commands:shortcuts' })
    .catch(() => undefined);
  if (!response || typeof response !== 'object' || !('selection' in response)) return true;
  const selection = response.selection;
  if (selection === null) return true;
  if (typeof selection !== 'string' || selection.length === 0) return false;
  return isDefaultAltSShortcut(selection);
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
    simple: t('simpleTranslation'),
    simpleDetail: t('simpleTranslationDetail'),
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
    let allowSelectionShortcut = true;
    let lastCommand = '';
    let lastCommandAt = 0;
    void readSelectionShortcut().then((allowed) => {
      allowSelectionShortcut = allowed;
    });

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
        selectionKey: (event) => allowSelectionShortcut && isPlainAltS(event),
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

async function requestEngineTier(session: PageSession, upgrade = false): Promise<void> {
  try {
    const status = await requestEngineStatus();
    if (status?.tier) session.setTier(status.tier);
    if (upgrade || status?.model.state === 'loaded') session.upgradeChromeSegments();
  } catch {
    // A load broadcast still replaces the built-in translation if the status read fails.
    if (upgrade) session.upgradeChromeSegments();
  }
}
