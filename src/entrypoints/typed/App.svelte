<script lang="ts">
  import { onMount } from 'svelte';
  import { browser } from 'wxt/browser';
  import { DEFAULT_MODEL_ID } from '@/engine/model/catalog';
  import { isEngineError } from '@/engine/errors';
  import type { EngineStatus } from '@/shared/engine-status';
  import { currentUiLanguage, t } from '@/shared/i18n';
  import {
    CHROME_ONLY_LANGUAGES,
    displayLanguage,
    isChromeOnlyLanguage,
    type TargetLanguage,
  } from '@/shared/languages';
  import {
    isModelProgressMessage,
    requestEngineStatus,
    requestModelDownload,
    requestModelInspect,
  } from '@/shared/messages';
  import { hasLicenseConsent } from '@/shared/agreement';
  import type { Settings } from '@/shared/settings';
  import { loadSettings, saveSettings, subscribeSettings } from '@/shared/storage';
  import {
    MAX_TYPED_CHARS,
    copyTranslation,
    normalizeTypedInput,
    planTypedTranslation,
    typedReadiness,
    type TypedReadiness,
  } from '@/shared/typed-translation';
  import LanguageField from '@/ui/LanguageField.svelte';
  import { typedEngine } from './engine';

  let settings = $state<Settings | null>(null);
  let uiLanguage = $state(currentUiLanguage());
  let engineStatus = $state<EngineStatus | null>(null);
  let sourceText = $state('');
  let result = $state('');
  let translating = $state(false);
  let resultError = $state(false);
  let copied = $state(false);
  let copyFailed = $state(false);
  let downloadBusy = $state(false);
  let downloadFailed = $state(false);
  let abortController = $state<AbortController | null>(null);

  let targetLanguage = $derived<TargetLanguage>(settings?.targetLanguage ?? 'ja');
  let plan = $derived(planTypedTranslation(targetLanguage));
  let trimmed = $derived(normalizeTypedInput(sourceText));
  let tooLong = $derived(trimmed.length > MAX_TYPED_CHARS);
  let readiness = $derived<TypedReadiness>(
    typedReadiness({
      consent: hasLicenseConsent(settings),
      modelState: engineStatus?.model.state ?? 'absent',
      plamoReady: engineStatus?.plamoReady ?? false,
    }),
  );
  let chromeOnlyTarget = $derived(isChromeOnlyLanguage(targetLanguage));
  let canTranslate = $derived(
    !translating && trimmed.length > 0 && !tooLong && !chromeOnlyTarget && readiness === 'ready',
  );
  let targetLabel = $derived(displayLanguage(targetLanguage, uiLanguage));

  async function refreshEngine() {
    engineStatus = await requestEngineStatus();
    if (!engineStatus) {
      const inspected = await requestModelInspect(DEFAULT_MODEL_ID);
      if (inspected) {
        engineStatus = {
          model: inspected,
          backend: null,
          tier: null,
          threads: null,
          parallel: null,
          plamoReady: inspected.state === 'loaded',
          chromeSupported: false,
          active: null,
        };
      }
    }
  }

  async function changeTarget(language: TargetLanguage) {
    try {
      settings = await saveSettings({ targetLanguage: language });
    } catch {
      return;
    }
    resetResult();
  }

  function resetResult() {
    result = '';
    resultError = false;
    copied = false;
    copyFailed = false;
  }

  async function translateTyped() {
    if (!canTranslate) return;
    abortController?.abort();
    const controller = new AbortController();
    abortController = controller;
    translating = true;
    resetResult();
    let text = '';
    try {
      const segments = [{ id: 'typed', text: trimmed }];
      for await (const chunk of typedEngine.translate(segments, {
        tgt: targetLanguage,
        form: settings?.form ?? 'polite',
        priority: 0,
        signal: controller.signal,
        ...(settings && settings.glossary.length > 0 ? { glossary: settings.glossary } : {}),
      })) {
        if (chunk.textDelta !== undefined) {
          text = chunk.restart === true ? chunk.textDelta : text + chunk.textDelta;
          result = text;
        } else if (chunk.final !== undefined) {
          text = chunk.final;
          result = text;
        }
      }
      if (text.trim().length === 0) resultError = true;
    } catch (error) {
      if (!controller.signal.aborted) {
        resultError = true;
        if (isEngineError(error)) await refreshEngine();
      }
    } finally {
      if (abortController === controller) {
        translating = false;
        abortController = null;
      }
    }
  }

  function stop() {
    abortController?.abort();
    abortController = null;
    translating = false;
  }

  async function copyResult() {
    copyFailed = false;
    copied = false;
    const ok = await copyTranslation(
      result,
      typeof navigator === 'undefined' ? null : navigator.clipboard,
    );
    if (ok) copied = true;
    else copyFailed = true;
  }

  function swap() {
    if (!plan.other) return;
    void changeTarget(plan.other);
  }

  async function startDownload() {
    if (downloadBusy) return;
    downloadBusy = true;
    downloadFailed = false;
    try {
      const started = await requestModelDownload(DEFAULT_MODEL_ID);
      if (!started) downloadFailed = true;
    } catch {
      downloadFailed = true;
    } finally {
      downloadBusy = false;
      await refreshEngine();
    }
  }

  function openOnboarding() {
    void browser.tabs
      .create({ url: browser.runtime.getURL('/onboarding.html') })
      .catch(() => undefined);
  }

  function openOptions() {
    void browser.runtime.openOptionsPage().catch(() => undefined);
  }

  onMount(() => {
    const unsubscribeSettings = subscribeSettings((next) => {
      settings = next;
    });
    const onMessage = (message: unknown) => {
      if (!isModelProgressMessage(message)) return;
      void refreshEngine();
    };
    browser.runtime.onMessage.addListener(onMessage);

    void loadSettings()
      .then((loaded) => {
        settings = loaded;
      })
      .catch(() => undefined)
      .then(() => refreshEngine())
      .catch(() => undefined);

    return () => {
      unsubscribeSettings();
      browser.runtime.onMessage.removeListener(onMessage);
      abortController?.abort();
    };
  });

  const chromeOnlyNames = CHROME_ONLY_LANGUAGES.map((code) => displayLanguage(code, uiLanguage));
</script>

<main class="page">
  <header class="page-header">
    <img src="/icon/48.png" alt="" width="40" height="40" />
    <div>
      <h1>{t('extensionName')}</h1>
      <p class="muted">{t('typedLead')}</p>
    </div>
  </header>

  <section class="panel composer" aria-labelledby="typed-heading">
    <h2 id="typed-heading">{t('typedHeading')}</h2>

    <div class="direction">
      <LanguageField value={targetLanguage} {uiLanguage} onChange={changeTarget} />
      <button
        class="button secondary swap"
        type="button"
        onclick={swap}
        aria-label={t('typedSwap')}
        title={t('typedSwap')}
      >
        ⇄
      </button>
    </div>
    <p class="muted hint">{t('typedDirectionHint', [targetLabel])}</p>

    <label class="field">
      <span>{t('typedSourceLabel')}</span>
      <textarea
        bind:value={sourceText}
        rows="7"
        spellcheck="false"
        placeholder={t('typedPlaceholder')}
        aria-describedby="typed-counter"></textarea>
    </label>
    <p id="typed-counter" class="muted counter" class:over={tooLong}>
      {t('typedCounter', [String(trimmed.length), String(MAX_TYPED_CHARS)])}
    </p>

    {#if chromeOnlyTarget}
      <p class="muted" role="status">{t('typedChromeOnlyTarget', [targetLabel])}</p>
    {:else if readiness === 'no-consent'}
      <div class="gate">
        <p>{t('typedNeedsConsent')}</p>
        <button class="button" type="button" onclick={openOnboarding}>
          {t('typedOpenOnboarding')}
        </button>
      </div>
    {:else if readiness === 'model-absent' || readiness === 'model-partial'}
      <div class="gate">
        <p>{readiness === 'model-partial' ? t('typedModelPartial') : t('typedModelMissing')}</p>
        <button class="button" type="button" onclick={startDownload} disabled={downloadBusy}>
          {readiness === 'model-partial' ? t('downloadResume') : t('typedDownloadModel')}
        </button>
        {#if downloadFailed}
          <p class="error" role="alert">{t('errorAction')}</p>
        {/if}
      </div>
    {:else if readiness === 'model-busy'}
      <p class="muted" role="status">{t('typedModelBusy')}</p>
    {:else if readiness === 'model-error'}
      <p class="error" role="alert">{t('typedModelError')}</p>
    {/if}

    <div class="actions">
      {#if translating}
        <button class="button secondary" type="button" onclick={stop}>{t('typedStop')}</button>
      {:else}
        <button class="button" type="button" onclick={translateTyped} disabled={!canTranslate}>
          {t('typedTranslate')}
        </button>
      {/if}
      <button
        class="button secondary"
        type="button"
        onclick={copyResult}
        disabled={result.trim().length === 0}
      >
        {copied ? t('typedCopied') : t('typedCopy')}
      </button>
      <button
        class="button secondary"
        type="button"
        onclick={resetResult}
        disabled={result.length === 0}
      >
        {t('typedClear')}
      </button>
    </div>

    {#if copyFailed}
      <p class="error" role="alert">{t('typedCopyFailed')}</p>
    {/if}
    {#if tooLong}
      <p class="error" role="alert">{t('typedTooLong', [String(MAX_TYPED_CHARS)])}</p>
    {/if}
  </section>

  <section class="panel" aria-labelledby="result-heading">
    <h2 id="result-heading">{t('typedResultHeading')}</h2>
    {#if resultError}
      <p class="error" role="alert">{t('typedFailed')}</p>
    {:else if result.trim().length > 0}
      <output class="result" lang={targetLanguage}>{result}</output>
    {:else}
      <p class="muted">{t('typedResultEmpty')}</p>
    {/if}
    {#if translating}
      <p class="muted">{t('typedTranslating')}</p>
    {/if}
  </section>

  <footer class="footer">
    <button class="link-button" type="button" onclick={openOptions}>{t('openOptions')}</button>
    <p class="notice">{t('machineTranslationNotice')}</p>
    <p class="notice">{t('unofficialNotice')}</p>
    <p class="notice">{t('typedChromeOnlyNote', [chromeOnlyNames.join(t('listSeparator'))])}</p>
  </footer>
</main>

<style>
  .page {
    display: grid;
    gap: var(--space-4);
    max-width: 640px;
    margin: 0 auto;
    padding: var(--space-6) var(--space-5);
  }

  .page-header {
    display: flex;
    align-items: center;
    gap: var(--space-3);
  }

  .page-header img {
    border-radius: var(--radius-sm);
  }

  h1 {
    font-size: 16px;
    font-weight: 700;
  }

  h2 {
    margin-bottom: var(--space-3);
    color: var(--muted);
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  .composer {
    display: grid;
    gap: var(--space-3);
  }

  .direction {
    display: grid;
    grid-template-columns: 1fr auto;
    align-items: end;
    gap: var(--space-2);
  }

  .swap {
    min-width: 44px;
    padding: 9px 12px;
    font-size: 16px;
    line-height: 1;
  }

  .hint,
  .counter {
    font-size: 12px;
  }

  .counter {
    justify-self: end;
  }

  .counter.over {
    color: var(--danger);
  }

  .field {
    display: grid;
    gap: var(--space-1);
  }

  .field > span {
    color: var(--muted);
    font-size: 11px;
    font-weight: 600;
  }

  textarea {
    width: 100%;
    min-height: 140px;
    padding: 10px 12px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface);
    color: var(--text);
    font: inherit;
    resize: vertical;
  }

  .gate {
    display: grid;
    gap: var(--space-2);
    justify-items: start;
    padding: var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface-muted);
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
  }

  .result {
    display: block;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .footer {
    display: grid;
    gap: var(--space-1);
  }

  @media (max-width: 480px) {
    .page {
      padding: var(--space-5) var(--space-4);
    }
  }
</style>
