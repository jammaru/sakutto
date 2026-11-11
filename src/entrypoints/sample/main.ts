import { browser } from 'wxt/browser';
import { fakeTranslate } from '@/dom/fake-engine';
import type { OverlayLabels } from '@/dom/overlay';
import { PageSession, preferencesFor } from '@/dom/session';
import { t } from '@/shared/i18n';
import { isTargetLanguage } from '@/shared/languages';
import { FOLDER_PERMISSION_ERROR } from '@/engine/model/folder-permission';
import { sharedFolderNeedsPermission } from '@/engine/model/folder-status';
import { isModelProgressMessage, requestEngineStatus } from '@/shared/messages';
import { loadSettings } from '@/shared/storage';
import { translateViaBackground } from '@/shared/translation-client';

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
    engineFailed: t('localServerFailed'),
    folderPermission: t('modelFolderPermissionPage'),
    barAlwaysOn: t('pageAlwaysOn'),
  };
}

function showSample(targetLanguage: string): void {
  const language = targetLanguage === 'en' ? 'ja' : 'en';
  document.documentElement.lang = language;
  for (const article of document.querySelectorAll('article[data-sample]')) {
    if (article.getAttribute('data-sample') === language) article.removeAttribute('hidden');
    else article.remove();
  }
}

const requested = new URL(location.href).searchParams.get('to');
if (isTargetLanguage(requested)) showSample(requested);

const settings = await loadSettings();
const targetLanguage = isTargetLanguage(requested) ? requested : settings.targetLanguage;
if (!isTargetLanguage(requested)) showSample(targetLanguage);

const session = new PageSession(document, {
  engine: {
    async *translate(segments, options) {
      if (__SAKUTTO_FAKE_ENGINE__ && settings.engineSource !== 'local-server') {
        yield* fakeTranslate(segments, options);
        return;
      }
      yield* translateViaBackground(segments, options);
    },
  },
  labels: overlayLabels(),
  preferences: preferencesFor(
    { ...settings, targetLanguage },
    { host: 'sample', auto: 'ask' },
    'sample',
  ),
});

browser.runtime.onMessage.addListener((message) => {
  if (!isModelProgressMessage(message)) return;
  if (message.status.error === FOLDER_PERMISSION_ERROR) session.noteFolderPermission();
  if (message.status.state === 'loaded' || message.status.state === 'ready') {
    session.retryUntranslated();
  }
});

void requestEngineStatus()
  .then((status) => {
    if (sharedFolderNeedsPermission(status?.sharedFolder)) session.noteFolderPermission();
    if (status?.model.state === 'loaded' || status?.model.state === 'ready') {
      session.retryUntranslated();
    }
  })
  .catch(() => undefined);

await session.translate();
