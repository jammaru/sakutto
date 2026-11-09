import { browser } from 'wxt/browser';
import { defineContentScript } from 'wxt/utils/define-content-script';
import { listPageBlocks } from '@/dom/blocks';
import { ComposeController, type ComposeLabels } from '@/dom/compose';
import { detectDocumentLanguage } from '@/dom/detect';
import { fakeTranslate } from '@/dom/fake-engine';
import type { OverlayLabels } from '@/dom/overlay';
import { PageSession, preferencesFor } from '@/dom/session';
import { loadSiteRule, pageHost, saveSiteRule, subscribeSiteRules } from '@/dom/sites';
import { mergeGlossary } from '@/shared/glossary';
import { currentUiLanguage, t } from '@/shared/i18n';
import {
  DEFAULT_COMPOSE_SHORTCUT,
  DEFAULT_SELECTION_SHORTCUT,
  matchesShortcut,
} from '@/shared/shortcuts';
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
  type ShortcutSnapshot,
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
function shortcutFromSnapshot(
  snapshot: ShortcutSnapshot | null,
  command: 'translate-selection' | 'translate-compose',
  fallback: string,
): string {
  if (!snapshot) return fallback;
  const binding = snapshot[command];
  // A command Chrome did not list is one this page cannot learn about; keep the default.
  if (binding === null) return fallback;
  return binding;
}

async function readBoundShortcuts(): Promise<{ selection: string; compose: string }> {
  const response: unknown = await browser.runtime
    .sendMessage({ type: 'commands:shortcuts' })
    .catch(() => undefined);
  const snapshot = isShortcutSnapshot(response) ? response : null;
  return {
    selection: shortcutFromSnapshot(snapshot, 'translate-selection', DEFAULT_SELECTION_SHORTCUT),
    compose: shortcutFromSnapshot(snapshot, 'translate-compose', DEFAULT_COMPOSE_SHORTCUT),
  };
}

async function requestSiteAccess(host: string): Promise<boolean> {
  const response = await browser.runtime
    .sendMessage({ type: 'site:grant', host })
    .catch(() => false);
  return response === true;
}

function composeLabels(): ComposeLabels {
  return {
    title: t('composeTitle'),
    icon: t('composeIcon'),
    replace: t('composeReplace'),
    undo: t('composeUndo'),
    close: t('close'),
    pending: t('composePending'),
    failed: t('composeFailed'),
    empty: t('composeEmpty'),
    tooLong: t('composeTooLong'),
    swap: t('composeSwap'),
    replaced: t('composeReplaced'),
    into: (language) => t('composeInto', [language]),
    chromeOnly: (language) => t('composeChromeOnly', [language]),
  };
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
    // The bound keys, or the manifest defaults until the background answers. An empty string
    // means the user unbound the command, so the page does not answer it at all.
    let selectionShortcut: string = DEFAULT_SELECTION_SHORTCUT;
    let composeShortcut: string = DEFAULT_COMPOSE_SHORTCUT;
    let lastCommand = '';
    let lastCommandAt = 0;
    let compose: ComposeController | null = null;
    const readBoundShortcutsNow = (): void => {
      void readBoundShortcuts().then((bound) => {
        selectionShortcut = bound.selection;
        composeShortcut = bound.compose;
      });
    };
    readBoundShortcutsNow();
    // Chrome has no event for a changed binding. A reader who rebinds and comes back to the
    // page brings it into focus, which is the moment to read the new key.
    window.addEventListener('focus', readBoundShortcutsNow);

    const engine = { translate: __SAKUTTO_FAKE_ENGINE__ ? fakeTranslate : translateViaBackground };

    const sessionPromise = (async () => {
      const settings = await loadSettings();
      const rule = await loadSiteRule(host);
      const session = new PageSession(document, {
        engine,
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
      compose = new ComposeController(document, {
        engine,
        labels: composeLabels(),
        preferences: {
          targetLanguage: rule.targetLanguage ?? settings.targetLanguage,
          form: settings.form,
          glossary: mergeGlossary(settings.glossary, rule.glossary),
          enabled: rule.auto !== 'never',
          uiLanguage: currentUiLanguage(),
        },
        composeKey: (event) =>
          composeShortcut.length > 0 && matchesShortcut(event, composeShortcut),
      });

      const detected = await detectDocumentLanguage(document);
      session.setDetectedLanguage(detected);

      const applyStored = async (): Promise<void> => {
        const [nextSettings, nextRule] = await Promise.all([loadSettings(), loadSiteRule(host)]);
        session.setLabels(overlayLabels());
        session.setPreferences(preferencesFor(nextSettings, nextRule, host));
        compose?.setLabels(composeLabels());
        compose?.setPreferences({
          targetLanguage: nextRule.targetLanguage ?? nextSettings.targetLanguage,
          form: nextSettings.form,
          glossary: mergeGlossary(nextSettings.glossary, nextRule.glossary),
          enabled: nextRule.auto !== 'never',
          uiLanguage: currentUiLanguage(),
        });
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
      if (command === 'compose') {
        compose?.handleShortcut();
        return session.state();
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
