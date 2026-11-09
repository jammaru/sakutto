import { browser } from 'wxt/browser';
import { fakeTranslate } from '@/dom/fake-engine';
import type { OverlayLabels } from '@/dom/overlay';
import { PageSession, preferencesFor } from '@/dom/session';
import { t } from '@/shared/i18n';
import { isTargetLanguage } from '@/shared/languages';
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
  engine: { translate: __SAKUTTO_FAKE_ENGINE__ ? fakeTranslate : translateViaBackground },
  labels: overlayLabels(),
  preferences: preferencesFor(
    { ...settings, targetLanguage },
    { host: 'sample', auto: 'ask' },
    'sample',
  ),
});

browser.runtime.onMessage.addListener((message) => {
  if (!isModelProgressMessage(message)) return;
  if (message.status.state === 'loaded') session.retryUntranslated();
});

void requestEngineStatus()
  .then((status) => {
    if (status?.model.state === 'loaded') session.retryUntranslated();
  })
  .catch(() => undefined);

await session.translate();
