import { browser } from 'wxt/browser';
import { defineContentScript } from 'wxt/utils/define-content-script';
import { listPageBlocks } from '@/dom/blocks';
import { ComposeController, type ComposeLabels, type ComposePreferences } from '@/dom/compose';
import { shouldHandleComposeCommand } from '@/dom/compose-field';
import { detectDocumentLanguage } from '@/dom/detect';
import { fakeTranslate } from '@/dom/fake-engine';
import type { OverlayLabels } from '@/dom/overlay';
import { PageSession, preferencesFor } from '@/dom/session';
import {
  loadSiteRule,
  pageHost,
  patchSiteRule,
  saveSiteRule,
  subscribeSiteRules,
  type SiteRule,
} from '@/dom/sites';
import { hasLicenseConsent } from '@/shared/agreement';
import type { ModelStatus } from '@/shared/engine-status';
import { mergeGlossary } from '@/shared/glossary';
import { currentUiLanguage, t } from '@/shared/i18n';
import { isTargetLanguage, type TargetLanguage } from '@/shared/languages';
import {
  boundShortcut,
  DEFAULT_SHORTCUTS,
  defaultShortcutEnabled,
  displayShortcut,
  emptyShortcutAssigned,
  matchesShortcut,
  SHORTCUT_PAGE_COMMANDS,
  type ShortcutAssigned,
  type ShortcutCommand,
  type ShortcutEnabled,
} from '@/shared/shortcuts';
import {
  isModelProgressMessage,
  isPageCommandRequest,
  isPageInfoRequest,
  isPageStateRequest,
  isShortcutQueryResult,
  requestEngineStatus,
  requestEngineWarm,
  type PageCommandName,
  type PageInfo,
  type ShortcutQueryResult,
  type ShortcutSnapshot,
} from '@/shared/messages';
import { loadSettings, saveSettings, subscribeSettings } from '@/shared/storage';
import type { Settings } from '@/shared/settings';
import { typedReadiness, type TypedReadiness } from '@/shared/typed-translation';
import { translateViaBackground } from '@/shared/translation-client';

interface ContentBridgeGlobal {
  __sakuttoContentBridgeReady?: boolean;
}

const bridge = globalThis as typeof globalThis & ContentBridgeGlobal;

/**
 * The browser only tells a page which keys are bound through the background worker. An
 * empty snapshot keeps the manifest defaults until that answer arrives. A command the
 * browser never assigned still uses the default; one the user cleared does not.
 */
async function readShortcutState(): Promise<ShortcutQueryResult | null> {
  const response: unknown = await browser.runtime
    .sendMessage({ type: 'commands:shortcuts' })
    .catch(() => undefined);
  return isShortcutQueryResult(response) ? response : null;
}

function shortcutFor(
  snapshot: ShortcutSnapshot | null,
  assigned: ShortcutAssigned,
  enabled: ShortcutEnabled,
  command: ShortcutCommand,
): string {
  return boundShortcut(snapshot, command, {
    fallback: DEFAULT_SHORTCUTS[command],
    enabled: enabled[command],
    assigned: assigned[command],
  });
}

function listensFor(
  snapshot: ShortcutSnapshot | null,
  assigned: ShortcutAssigned,
  enabled: ShortcutEnabled,
  command: ShortcutCommand,
): (event: KeyboardEvent) => boolean {
  return (event) => {
    const shortcut = shortcutFor(snapshot, assigned, enabled, command);
    return shortcut.length > 0 && matchesShortcut(event, shortcut);
  };
}

function commandEnabled(
  snapshot: ShortcutSnapshot | null,
  assigned: ShortcutAssigned,
  enabled: ShortcutEnabled,
  command: PageCommandName,
): boolean {
  const name = (Object.keys(SHORTCUT_PAGE_COMMANDS) as ShortcutCommand[]).find(
    (entry) => SHORTCUT_PAGE_COMMANDS[entry] === command,
  );
  if (!name) return true;
  return shortcutFor(snapshot, assigned, enabled, name).length > 0;
}

function composePreferencesFor(
  settings: Settings,
  rule: SiteRule,
  readiness: TypedReadiness,
  replaceShortcut: string,
): ComposePreferences {
  const composeTarget = settings.composeTargetLanguage;
  return {
    targetLanguage: composeTarget ?? rule.targetLanguage ?? settings.targetLanguage,
    form: settings.form,
    glossary: mergeGlossary(settings.glossary, rule.glossary),
    enabled: rule.auto !== 'never',
    uiLanguage: currentUiLanguage(),
    showIcon: settings.composeIcon,
    readiness,
    explicitTarget: composeTarget !== null,
    instantReplace: settings.composeInstantReplace,
    replaceShortcut,
    placement: settings.composePlacement,
    sitePlacement: rule.composePlacement ?? null,
    freePoint: rule.composeFreePoint ?? null,
  };
}

async function requestSiteAccess(host: string): Promise<boolean> {
  const response = await browser.runtime
    .sendMessage({ type: 'site:grant', host })
    .catch(() => false);
  return response === true;
}

function composeLabels(readiness?: TypedReadiness): ComposeLabels {
  const setup =
    readiness === 'no-consent'
      ? t('typedNeedsConsent')
      : readiness === 'model-error'
        ? t('typedModelError')
        : t('composeNeedSetup');
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
    stale: t('composeStale'),
    setup,
    loading: t('composeLoading'),
    ineligible: t('composeIneligible'),
    openSetup: t('composeOpenSetup'),
    target: t('composeTargetLabel'),
    autoSource: t('composeAutoSource'),
    replaceHint: (compose, enter) => t('composeReplaceHint', [compose, enter]),
    langPair: (source, target) => t('composeLangPair', [source, target]),
    into: (language) => t('composeInto', [language]),
    chromeOnly: (language) => t('composeChromeOnly', [language]),
    placementMenu: t('composePlacementMenu'),
    placementSite: t('composePlacementSite'),
    placementFollowSettings: t('composePlacementFollowSettings'),
    placementReset: t('composePlacementReset'),
    placementHandle: t('composePlacementHandle'),
    placementLabel: (placement) =>
      t(
        placement === 'below'
          ? 'composePlacementBelow'
          : placement === 'corner'
            ? 'composePlacementCorner'
            : placement === 'free'
              ? 'composePlacementFree'
              : 'composePlacementAbove',
      ),
  };
}

function composeReadiness(
  settings: Settings,
  model: Pick<ModelStatus, 'state'> | null,
  ready: boolean,
  statusKnown: boolean,
) {
  if (__SAKUTTO_FAKE_ENGINE__) return 'ready' as const;
  if (!hasLicenseConsent(settings)) {
    return typedReadiness({
      consent: false,
      modelState: model?.state ?? 'absent',
      plamoReady: ready,
    });
  }
  // A failed status fetch is not "no model"; keep showing loading until we know.
  if (!statusKnown) return 'model-busy' as const;
  return typedReadiness({
    consent: true,
    modelState: model?.state ?? 'absent',
    plamoReady: ready,
  });
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
    // The browser's bindings, or the manifest defaults until the background answers. A
    // command the browser never assigned still uses its default; a user-cleared one does not.
    let shortcutSnapshot: ShortcutSnapshot | null = null;
    let shortcutAssigned = emptyShortcutAssigned();
    let shortcutsEnabled = defaultShortcutEnabled();
    let lastCommand = '';
    let lastCommandAt = 0;
    let compose: ComposeController | null = null;
    let modelState: ModelStatus['state'] | null = null;
    let plamoReady = false;
    let modelStatusKnown = false;
    const refreshShortcuts = (): void => {
      void readShortcutState().then((state) => {
        if (!state) return;
        shortcutSnapshot = state.snapshot;
        shortcutAssigned = state.assigned;
      });
    };
    refreshShortcuts();
    // The browser has no event for a changed binding. A reader who rebinds and comes back
    // to the page brings it into focus, which is the moment to read the new key.
    window.addEventListener('focus', refreshShortcuts);

    const engine = { translate: __SAKUTTO_FAKE_ENGINE__ ? fakeTranslate : translateViaBackground };

    const sessionPromise = (async () => {
      const settings = await loadSettings();
      const rule = await loadSiteRule(host);
      if (!__SAKUTTO_FAKE_ENGINE__) {
        const status = await requestEngineStatus().catch(() => null);
        if (status) {
          modelState = status.model.state;
          plamoReady = status.plamoReady;
          modelStatusKnown = true;
        }
      }
      shortcutsEnabled = settings.shortcutsEnabled;
      const session = new PageSession(document, {
        engine,
        labels: overlayLabels(),
        preferences: preferencesFor(settings, rule, host),
        onSitePatch: async (patch) => {
          const current = await loadSiteRule(host);
          await saveSiteRule({ ...current, ...patch, host });
        },
        onGrantSite: () => requestSiteAccess(host),
        pageKey: (event) =>
          listensFor(shortcutSnapshot, shortcutAssigned, shortcutsEnabled, 'translate-page')(event),
        bilingualKey: (event) =>
          listensFor(
            shortcutSnapshot,
            shortcutAssigned,
            shortcutsEnabled,
            'toggle-bilingual',
          )(event),
        selectionKey: (event) =>
          listensFor(
            shortcutSnapshot,
            shortcutAssigned,
            shortcutsEnabled,
            'translate-selection',
          )(event),
      });
      const readiness = composeReadiness(
        settings,
        modelState ? { state: modelState } : null,
        plamoReady,
        modelStatusKnown,
      );
      compose = new ComposeController(document, {
        engine,
        labels: composeLabels(readiness),
        preferences: composePreferencesFor(
          settings,
          rule,
          readiness,
          displayShortcut(
            shortcutFor(shortcutSnapshot, shortcutAssigned, shortcutsEnabled, 'translate-compose'),
          ),
        ),
        composeKey: (event) =>
          listensFor(
            shortcutSnapshot,
            shortcutAssigned,
            shortcutsEnabled,
            'translate-compose',
          )(event),
        onWarm: () => {
          if (!__SAKUTTO_FAKE_ENGINE__) void requestEngineWarm();
        },
        onSetup: () => {
          void browser.runtime.sendMessage({ type: 'ui:open-setup' }).catch(() => undefined);
        },
        onTarget: (language: TargetLanguage) => {
          if (!isTargetLanguage(language)) return;
          void saveSettings({ composeTargetLanguage: language });
        },
        onPlacement: (placement) => {
          void patchSiteRule(host, (current) => {
            const next = { ...current, host, composePlacement: placement };
            if (placement !== 'free') delete next.composeFreePoint;
            return next;
          });
        },
        onFollowSettings: () => {
          void patchSiteRule(host, (current) => {
            const next = { ...current, host };
            delete next.composePlacement;
            delete next.composeFreePoint;
            return next;
          });
        },
        onFreePoint: (point) => {
          void patchSiteRule(host, (current) => {
            const next = { ...current, host };
            if (point) {
              next.composePlacement = 'free';
              next.composeFreePoint = point;
            } else {
              delete next.composeFreePoint;
            }
            return next;
          });
        },
      });

      const detected = await detectDocumentLanguage(document);
      session.setDetectedLanguage(detected);

      const applyStored = async (): Promise<void> => {
        const [nextSettings, nextRule] = await Promise.all([loadSettings(), loadSiteRule(host)]);
        shortcutsEnabled = nextSettings.shortcutsEnabled;
        session.setLabels(overlayLabels());
        session.setPreferences(preferencesFor(nextSettings, nextRule, host));
        const readiness = composeReadiness(
          nextSettings,
          modelState ? { state: modelState } : null,
          plamoReady,
          modelStatusKnown,
        );
        compose?.setLabels(composeLabels(readiness));
        compose?.setPreferences(
          composePreferencesFor(
            nextSettings,
            nextRule,
            readiness,
            displayShortcut(
              shortcutFor(
                shortcutSnapshot,
                shortcutAssigned,
                shortcutsEnabled,
                'translate-compose',
              ),
            ),
          ),
        );
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
      // Compose re-entry is owned by the controller so a Chrome command that found no field
      // cannot swallow the page keydown (or a second command) that does.
      if (command !== 'compose' && lastCommand === command && now - lastCommandAt < 80) {
        return (await sessionPromise).state();
      }
      lastCommand = command;
      lastCommandAt = now;
      const session = await sessionPromise;
      if (!commandEnabled(shortcutSnapshot, shortcutAssigned, shortcutsEnabled, command)) {
        return session.state();
      }
      if (!__SAKUTTO_FAKE_ENGINE__) {
        void requestEngineWarm();
        void requestEngineTier(session);
      }
      if (command === 'compose') {
        if (shouldHandleComposeCommand(document)) compose?.handleShortcut();
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
        modelState = message.status.state;
        modelStatusKnown = true;
        if (message.status.state === 'loaded') plamoReady = true;
        void sessionPromise.then(async (session) => {
          const [nextSettings, nextRule] = await Promise.all([loadSettings(), loadSiteRule(host)]);
          const readiness = composeReadiness(nextSettings, message.status, plamoReady, true);
          compose?.setLabels(composeLabels(readiness));
          compose?.setPreferences(
            composePreferencesFor(
              nextSettings,
              nextRule,
              readiness,
              displayShortcut(
                shortcutFor(
                  shortcutSnapshot,
                  shortcutAssigned,
                  shortcutsEnabled,
                  'translate-compose',
                ),
              ),
            ),
          );
          if (message.status.state === 'loaded' && !__SAKUTTO_FAKE_ENGINE__) {
            void requestEngineTier(session, true);
          }
        });
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
