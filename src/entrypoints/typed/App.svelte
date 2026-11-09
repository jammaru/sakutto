<script lang="ts">
  import { onMount } from 'svelte';
  import { browser } from 'wxt/browser';
  import { DEFAULT_MODEL_ID } from '@/engine/model/catalog';
  import { isEngineError } from '@/engine/errors';
  import type { EngineStatus } from '@/shared/engine-status';
  import { hasBuiltInTranslatorUi } from '@/shared/browser';
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
    isTranslateShortcut,
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
  let chromeOnlyTarget = $derived(hasBuiltInTranslatorUi() && isChromeOnlyLanguage(targetLanguage));
  let canTranslate = $derived(
    !translating && trimmed.length > 0 && !tooLong && !chromeOnlyTarget && readiness === 'ready',
  );
  let targetLabel = $derived(displayLanguage(targetLanguage, uiLanguage));
  let hasAnything = $derived(sourceText.length > 0 || result.length > 0);

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

  function clearBoth() {
    abortController?.abort();
    abortController = null;
    translating = false;
    sourceText = '';
    resetResult();
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

  function onSourceKeydown(event: KeyboardEvent) {
    if (!isTranslateShortcut(event)) return;
    if (!canTranslate) return;
    event.preventDefault();
    void translateTyped();
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

  /**
   * Turns the comparison around: what was translated becomes the text to translate, and
   * the target flips to the other half of the pair. Without this the swap only moved a
   * label, and the reader had to select the result and paste it back by hand.
   */
  function swap() {
    if (!plan.other) return;
    const carried = result.trim();
    stop();
    resetResult();
    if (carried.length > 0) sourceText = carried;
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
      <p class="muted lead">{t('typedLead')}</p>
    </div>
  </header>

  <section class="workspace" aria-labelledby="typed-heading">
    <h2 id="typed-heading" class="visually-hidden">{t('typedHeading')}</h2>

    <div class="direction">
      <LanguageField value={targetLanguage} {uiLanguage} onChange={changeTarget} />
      <button
        class="swap"
        type="button"
        onclick={swap}
        aria-label={t('typedSwap')}
        title={t('typedSwap')}
      >
        ⇄
      </button>
      <p class="muted hint">{t('typedDirectionHint', [targetLabel])}</p>
    </div>

    <div class="compare">
      <section class="pane" aria-labelledby="typed-source-title">
        <div class="pane-head">
          <h2 id="typed-source-title">{t('typedSourceLabel')}</h2>
          <span class="pane-note">{t('typedDetectSource')}</span>
          <button class="pane-action" type="button" onclick={clearBoth} disabled={!hasAnything}>
            {t('typedClear')}
          </button>
        </div>
        <textarea
          bind:value={sourceText}
          aria-labelledby="typed-source-title"
          aria-describedby="typed-counter"
          spellcheck="false"
          placeholder={t('typedPlaceholder')}
          onkeydown={onSourceKeydown}></textarea>
        <div class="pane-foot">
          <p id="typed-counter" class="counter" class:over={tooLong}>
            {t('typedCounter', [String(trimmed.length), String(MAX_TYPED_CHARS)])}
          </p>
        </div>
        {#if tooLong}
          <p class="error" role="alert">{t('typedTooLong', [String(MAX_TYPED_CHARS)])}</p>
        {/if}
      </section>

      <section
        class="pane output"
        aria-labelledby="typed-result-title"
        aria-busy={translating ? 'true' : 'false'}
      >
        <div class="pane-head">
          <h2 id="typed-result-title">{t('typedResultHeading')}</h2>
          <span class="pane-note">{targetLabel}</span>
          <button
            class="pane-action"
            type="button"
            onclick={copyResult}
            disabled={result.trim().length === 0}
          >
            {copied ? t('typedCopied') : t('typedCopy')}
          </button>
        </div>

        {#if chromeOnlyTarget}
          <p class="muted note" role="status">{t('typedChromeOnlyTarget', [targetLabel])}</p>
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
          <p class="muted note" role="status">{t('typedModelBusy')}</p>
        {:else if readiness === 'model-error'}
          <p class="error note" role="alert">{t('typedModelError')}</p>
        {:else if resultError}
          <p class="error note" role="alert">{t('typedFailed')}</p>
        {:else if result.trim().length > 0}
          <output class="result" lang={targetLanguage} aria-labelledby="typed-result-title"
            >{result}</output
          >
        {:else}
          <p class="muted empty">{t('typedResultEmpty')}</p>
        {/if}

        <div class="pane-foot">
          <p class="status" role="status">{translating ? t('typedTranslating') : ''}</p>
        </div>
      </section>
    </div>

    <div class="run">
      <div class="run-status">
        {#if copyFailed}
          <p class="error" role="alert">{t('typedCopyFailed')}</p>
        {/if}
      </div>
      <p class="muted shortcut">{t('typedRunHint')}</p>
      {#if translating}
        <button class="button secondary" type="button" onclick={stop}>{t('typedStop')}</button>
      {:else}
        <button class="button" type="button" onclick={translateTyped} disabled={!canTranslate}>
          {t('typedTranslate')}
        </button>
      {/if}
    </div>
  </section>

  <footer class="footer">
    <button class="link-button" type="button" onclick={openOptions}>{t('openOptions')}</button>
    <p class="notice">{t('machineTranslationNotice')}</p>
    <p class="notice">{t('unofficialNotice')}</p>
    {#if hasBuiltInTranslatorUi()}
      <p class="notice">{t('typedChromeOnlyNote', [chromeOnlyNames.join(t('listSeparator'))])}</p>
    {/if}
  </footer>
</main>

<style>
  .page {
    /* One hairline colour for the whole page: rules replace the boxes that used to carry
       the structure. */
    --rule: color-mix(in srgb, var(--border) 30%, transparent);
    display: grid;
    gap: var(--space-5);
    max-width: 1080px;
    margin: 0 auto;
    padding: var(--space-6) var(--space-5) var(--space-4);
  }

  .page-header {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding-bottom: var(--space-4);
    border-bottom: 1px solid var(--rule);
  }

  .page-header img {
    border-radius: var(--radius-sm);
  }

  .lead {
    max-width: 640px;
  }

  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    padding: 0;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }

  h1 {
    font-size: 16px;
    font-weight: 700;
  }

  h2 {
    color: var(--muted);
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  .workspace {
    display: grid;
    gap: var(--space-4);
  }

  .direction {
    display: flex;
    flex-wrap: wrap;
    align-items: end;
    gap: var(--space-2) var(--space-3);
  }

  .direction :global(.field) {
    min-width: 200px;
  }

  .swap {
    min-width: 44px;
    padding: 9px 10px;
    border: 1px solid var(--rule);
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text);
    font-size: 16px;
    line-height: 1;
  }

  .swap:hover {
    background: var(--surface-muted);
  }

  .hint {
    flex: 1 1 240px;
    padding-bottom: 8px;
    font-size: 12px;
  }
  .compare {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: 0;
  }

  /* The panes are two halves of one sheet: a single vertical rule between them, no card. */
  .pane {
    display: grid;
    align-content: start;
    gap: var(--space-2);
    min-width: 0;
    padding: var(--space-3) var(--space-4) var(--space-2) 0;
  }

  .pane.output {
    padding: var(--space-3) 0 var(--space-2) var(--space-4);
    border-left: 1px solid var(--rule);
  }

  .pane-head {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-height: 30px;
    padding-bottom: var(--space-2);
    border-bottom: 1px solid var(--rule);
    margin-bottom: var(--space-1);
  }

  .pane-note {
    flex: 1 1 auto;
    color: var(--muted);
    font-size: 11px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .pane-action {
    flex: none;
    min-height: 0;
    padding: 2px 2px;
    border: 0;
    background: none;
    color: var(--accent-strong);
    font-size: 12px;
    font-weight: 600;
    text-decoration: underline;
    text-underline-offset: 2px;
  }

  .pane-action:hover:not(:disabled) {
    background: none;
    color: var(--accent);
  }

  .pane-action:disabled {
    color: var(--muted);
    text-decoration: none;
    opacity: 1;
  }

  textarea {
    width: 100%;
    min-height: 240px;
    padding: 4px 0 0;
    border: 0;
    background: transparent;
    color: var(--text);
    font: inherit;
    line-height: 1.75;
    resize: vertical;
  }

  .result {
    display: block;
    min-height: 240px;
    padding: 4px 0 0;
    color: var(--text);
    line-height: 1.75;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .empty {
    min-height: 240px;
    padding: 4px 0 0;
    font-size: 12px;
    line-height: 1.7;
  }

  .note {
    font-size: 12px;
    line-height: 1.6;
  }

  .pane-foot {
    display: flex;
    justify-content: flex-end;
    min-height: 18px;
  }

  .counter,
  .status,
  .shortcut {
    font-size: 12px;
  }

  .counter.over {
    color: var(--danger);
  }

  .status {
    color: var(--muted);
  }

  .gate {
    display: grid;
    gap: var(--space-2);
    justify-items: start;
    padding: var(--space-3) 0 0;
    border-top: 1px solid var(--rule);
    font-size: 12px;
    line-height: 1.6;
  }

  .run {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: var(--space-3);
    padding-top: var(--space-3);
    border-top: 1px solid var(--rule);
  }

  .run-status {
    margin-right: auto;
  }

  .footer {
    display: grid;
    gap: var(--space-1);
    padding-top: var(--space-3);
    border-top: 1px solid var(--rule);
  }

  /* One column keeps both boxes wide enough to read; stacking source above result is the
     order the comparison is read in anyway. The vertical rule becomes a horizontal one so
     the two halves stay visually separate. */
  @media (max-width: 720px) {
    .compare {
      grid-template-columns: minmax(0, 1fr);
    }

    .pane {
      padding: var(--space-3) 0 var(--space-2);
    }

    .pane.output {
      padding: var(--space-4) 0 var(--space-2);
      border-top: 1px solid var(--rule);
      border-left: 0;
    }
  }

  @media (max-width: 480px) {
    .page {
      padding: var(--space-5) var(--space-4);
    }

    .run {
      flex-wrap: wrap;
      justify-content: flex-start;
    }

    .shortcut {
      flex-basis: 100%;
      order: 3;
    }
  }
</style>
