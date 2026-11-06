<script lang="ts">
  import { onMount } from 'svelte';
  import { browser } from 'wxt/browser';
  import { DEFAULT_MODEL_ID, getModel } from '@/engine/model/catalog';
  import type { ModelStatus } from '@/shared/engine-status';
  import { agreementFromStorage } from '@/shared/agreement';
  import { currentUiLanguage, t } from '@/shared/i18n';
  import { resolveTargetLanguage, type TargetLanguage } from '@/shared/languages';
  import {
    isModelProgressMessage,
    requestModelCancel,
    requestModelDownload,
    requestModelInspect,
  } from '@/shared/messages';
  import { advanceModelStatus } from '@/shared/model-progress';
  import { PLAMO_OFFICIAL_LINKS } from '@/shared/plamo-license';
  import {
    PLAMO_LICENSE_VERSION,
    PLAMO_NOTICE_VERSION,
    needsLicenseReconsent,
  } from '@/shared/settings';
  import { loadSettings, saveSettings } from '@/shared/storage';
  import { prepareTranslatorPack } from '@/shared/translator-pack';
  import { estimateRemainingMs, type ByteMark } from '@/ui/download-eta';
  import { formatByteSize } from '@/ui/format';
  import {
    onboardingErrorMessage,
    onboardingPhaseAfterStatus,
    type OnboardingPhase,
  } from '@/ui/onboarding-phase';

  const licenseLinks = {
    plamoJa: browser.runtime.getURL('/licenses/PLaMo-Community-License-ja.txt'),
    plamoEn: browser.runtime.getURL('/licenses/PLaMo-Community-License-en.txt'),
    mit: browser.runtime.getURL('/licenses/LICENSE.txt'),
    notice: browser.runtime.getURL('/licenses/NOTICE.txt'),
  };

  const officialLinks = PLAMO_OFFICIAL_LINKS;

  const model = getModel(DEFAULT_MODEL_ID);

  type Phase = OnboardingPhase;

  let targetLanguage = $state<TargetLanguage>(resolveTargetLanguage(currentUiLanguage()));
  let startRequested = $state(false);
  let consentSaved = $state(false);
  /**
   * True when a stored consent predates the clearer commercial summary. That user already
   * agreed to the same license; they are shown the new notice once more, and the click
   * rewrites the record without touching the downloaded model.
   */
  let reconsent = $state(false);
  let phase = $state<Phase>('consent');
  let failureDetail = $state<string | null>(null);
  let received = $state(0);
  let total = $state(model.size);
  let progress = $state(0);
  let modelState = $state<ModelStatus['state']>('absent');
  let lastStatus = $state<ModelStatus | null>(null);
  let closing = $state(false);
  let closeFailed = $state(false);
  let tryFailed = $state(false);
  let continued = $state(false);
  let marks = $state<ByteMark[]>([]);
  let now = $state(Date.now());

  let percent = $derived(Math.max(0, Math.min(100, Math.round(progress * 100))));
  let etaLabel = $derived.by(() => {
    if (phase !== 'downloading' || modelState !== 'downloading') return null;
    const remaining = estimateRemainingMs(marks, total, now);
    if (remaining === null || remaining <= 0) return null;
    const seconds = Math.max(1, Math.round(remaining / 1000));
    if (seconds < 90) return t('downloadEtaSeconds', [String(seconds)]);
    return t('downloadEtaMinutes', [String(Math.max(1, Math.round(seconds / 60)))]);
  });
  let statusText = $derived.by(() => {
    if (modelState === 'verifying') return t('runtimeVerifying');
    if (modelState === 'loading') return t('runtimeLoading');
    if (modelState === 'downloading') {
      return t('runtimeDownloading', [
        String(percent),
        formatByteSize(received),
        formatByteSize(total),
      ]);
    }
    return `${formatByteSize(received)} / ${formatByteSize(total)}`;
  });
  let showStartButton = $derived(!consentSaved || phase === 'paused' || phase === 'error');
  let showStartNotice = $derived(showStartButton && !consentSaved);
  let failureText = $derived(
    phase === 'error'
      ? onboardingErrorMessage({
          error: failureDetail ?? undefined,
          fallback: t('onboardingStartFailed'),
          http: (status) => t('onboardingHttpError', [status]),
        })
      : null,
  );

  function applyStatus(status: ModelStatus) {
    if (status.id !== DEFAULT_MODEL_ID) return;
    const next = advanceModelStatus(lastStatus, status);
    lastStatus = next;
    received = next.received;
    total = next.total || model.size;
    progress = next.progress;
    modelState = next.state;
    if (next.state === 'error') failureDetail = next.error ?? null;
    else if (next.state === 'downloading' || next.state === 'ready' || next.state === 'loaded') {
      failureDetail = null;
    }
    if (status.state === 'downloading') noteBytes(next.received);
    phase = onboardingPhaseAfterStatus(phase, next.state, consentSaved || startRequested);
  }

  function noteBytes(receivedBytes: number): void {
    const at = Date.now();
    now = at;
    if (marks.length === 0 && receivedBytes > 0) continued = true;
    const last = marks[marks.length - 1];
    if (last && last.received === receivedBytes) return;
    const next = [...marks, { at, received: receivedBytes }];
    marks = next.length > 40 ? next.slice(-40) : next;
  }

  async function start() {
    if (phase === 'downloading') return;
    if (startRequested && phase !== 'paused' && phase !== 'error') return;
    failureDetail = null;
    const alreadyReady = modelState === 'ready' || modelState === 'loaded';
    startRequested = true;
    if (!alreadyReady) phase = 'downloading';

    const source = targetLanguage === 'en' ? 'ja' : 'en';
    const pack = prepareTranslatorPack(source, targetLanguage);

    try {
      await saveSettings({
        consent: {
          license: 'plamo-community',
          version: PLAMO_LICENSE_VERSION,
          notice: PLAMO_NOTICE_VERSION,
          acceptedAt: new Date().toISOString(),
          ageNoticeShown: true,
        },
      });
      consentSaved = true;
      reconsent = false;
    } catch {
      phase = 'error';
      startRequested = false;
      return;
    }

    if (received > 0) continued = true;

    if (alreadyReady || modelState === 'ready' || modelState === 'loaded') {
      phase = 'ready';
      void pack;
      return;
    }

    phase = 'downloading';
    void pack;
    const started = await requestModelDownload(DEFAULT_MODEL_ID);
    if (!started) phase = 'error';
  }

  async function pause() {
    await requestModelCancel(DEFAULT_MODEL_ID);
    phase = 'paused';
  }

  async function trySample() {
    tryFailed = false;
    try {
      const url = new URL(browser.runtime.getURL('/sample.html'));
      url.searchParams.set('to', targetLanguage);
      await browser.tabs.create({ url: url.toString() });
    } catch {
      tryFailed = true;
    }
  }

  async function close() {
    closing = true;
    closeFailed = false;
    try {
      const tab = await browser.tabs.getCurrent();
      if (tab?.id !== undefined) await browser.tabs.remove(tab.id);
      else window.close();
    } catch {
      closeFailed = true;
    } finally {
      closing = false;
    }
  }

  onMount(() => {
    const onMessage = (message: unknown) => {
      if (!isModelProgressMessage(message)) return;
      applyStatus(message.status);
    };
    browser.runtime.onMessage.addListener(onMessage);
    const timer = setInterval(() => {
      now = Date.now();
    }, 1000);

    void loadSettings()
      .then((settings) => {
        targetLanguage = settings.targetLanguage;
        // A consent written under an earlier notice stays valid, but this user has not seen
        // the clearer commercial summary. Showing it again does not invalidate the license,
        // does not touch the stored model, and only asks for one more click.
        reconsent = needsLicenseReconsent(settings);
        const stored = agreementFromStorage(settings.consent !== null, {
          started: startRequested,
        });
        if (stored === null) return;
        consentSaved = stored && !reconsent;
      })
      .catch(() => undefined)
      .then(() => requestModelInspect(DEFAULT_MODEL_ID))
      .then((status) => {
        if (status) applyStatus(status);
      })
      .catch(() => undefined);

    return () => {
      clearInterval(timer);
      browser.runtime.onMessage.removeListener(onMessage);
    };
  });
</script>

<main class="onboarding">
  <header class="hero">
    <img src="/icon/128.png" alt="" width="64" height="64" />
    <p class="eyebrow">{t('onboardingEyebrow')}</p>
    <h1>{t('extensionName')}</h1>
    <p class="lead">{t('onboardingLead')}</p>
  </header>

  {#if phase !== 'ready'}
    <section class="panel notes">
      <h2>{t('onboardingSetupHeading')}</h2>
      <ul>
        <li>{t('onboardingModelNote')}</li>
        <li>{t('onboardingBridgeNote')}</li>
        <li>{t('onboardingUseNow')}</li>
        <li>{t('onboardingPrivacyNote')}</li>
      </ul>
    </section>
  {/if}

  {#if phase === 'ready'}
    <section class="panel ready" aria-live="polite">
      <h2 class="ready-title">{t('onboardingReadyHeading')}</h2>
      <p>{t('onboardingReadyLead')}</p>
      <ul>
        <li>{t('onboardingReadyToolbar')}</li>
        <li>{t('onboardingReadyPage')}</li>
        <li>{t('onboardingReadySelection')}</li>
        <li>{t('onboardingReadyContext')}</li>
      </ul>
    </section>
  {:else if phase !== 'consent'}
    <section class="panel progress" aria-live="polite">
      <div
        class="track"
        role="progressbar"
        aria-valuemin="0"
        aria-valuemax="100"
        aria-valuenow={percent}
        aria-label={t('downloadProgressLabel')}
      >
        <span style="width: {percent}%"></span>
      </div>
      <p>{statusText}</p>
      {#if etaLabel}
        <p>{etaLabel}</p>
      {/if}
      {#if phase === 'paused'}
        <p>{t('downloadPaused')}</p>
      {:else if continued && phase === 'downloading'}
        <p>{t('downloadResuming')}</p>
      {/if}
      {#if phase === 'downloading' || phase === 'paused'}
        <p>{t('onboardingWhileDownloading')}</p>
      {:else if phase === 'error'}
        <p class="error" role="alert">{failureText}</p>
      {/if}
    </section>
  {/if}

  <div class="actions">
    {#if showStartNotice}
      <section class="panel consent" aria-labelledby="commercial-heading">
        <h2 id="commercial-heading">{t('onboardingCommercialHeading')}</h2>

        {#if reconsent}
          <p class="reconsent">{t('onboardingReconsentHeading')}</p>
          <p class="muted">{t('onboardingReconsentBody')}</p>
        {/if}

        <div class="terms">
          <div>
            <h3>{t('onboardingPersonalHeading')}</h3>
            <p>{t('onboardingPersonalBody')}</p>
          </div>
          <div>
            <h3>{t('onboardingCommercialHeading2')}</h3>
            <p>{t('onboardingCommercialBody')}</p>
            <ul class="conditions">
              <li>{t('onboardingCommercialRegistration')}</li>
              <li>{t('onboardingCommercialRevenue')}</li>
            </ul>
          </div>
          <div>
            <h3>{t('onboardingCommercialUnmetHeading')}</h3>
            <p>{t('onboardingCommercialUnmetBody')}</p>
          </div>
        </div>

        <p class="age">{t('onboardingAgeNotice')}</p>

        <p class="consent-links">
          <a href={officialLinks.licenseJa} target="_blank" rel="noreferrer"
            >{t('plamoOfficialLicenseJa')}</a
          >
          <a href={officialLinks.registration} target="_blank" rel="noreferrer"
            >{t('plamoRegistrationLink')}</a
          >
        </p>

        <!--
          Everything else stays reachable without repeating a wall of the same links above:
          the English official text, both bundled copies, this code's MIT license and NOTICE.
        -->
        <details class="more">
          <summary>{t('onboardingOtherLicenses')}</summary>
          <ul class="consent-links">
            <li>
              <a href={officialLinks.licenseEn} target="_blank" rel="noreferrer"
                >{t('plamoOfficialLicenseEn')}</a
              >
            </li>
            <li>
              <a href={licenseLinks.plamoJa} target="_blank" rel="noreferrer"
                >{t('licensePlaMoJa')}</a
              >
            </li>
            <li>
              <a href={licenseLinks.plamoEn} target="_blank" rel="noreferrer"
                >{t('licensePlaMoEn')}</a
              >
            </li>
            <li>
              <a href={licenseLinks.mit} target="_blank" rel="noreferrer">{t('licenseMit')}</a>
            </li>
            <li>
              <a href={licenseLinks.notice} target="_blank" rel="noreferrer">{t('licenseNotice')}</a
              >
            </li>
          </ul>
        </details>
      </section>
      <p id="start-notice" class="start-note">{t('onboardingConsentSentence')}</p>
    {/if}
    <div class="action-row">
      {#if phase === 'ready'}
        <button class="button" type="button" onclick={trySample}>{t('onboardingTry')}</button>
      {:else if phase === 'downloading' || phase === 'paused'}
        <button class="button" type="button" onclick={trySample}>{t('onboardingTryNow')}</button>
      {/if}
      {#if phase === 'downloading'}
        <button class="button secondary" type="button" onclick={pause}>{t('downloadCancel')}</button
        >
      {:else if showStartButton}
        <button
          class="button"
          type="button"
          onclick={start}
          disabled={closing}
          aria-describedby={showStartNotice ? 'start-notice' : undefined}
        >
          {consentSaved
            ? t('downloadResume')
            : reconsent
              ? t('onboardingReconsentStart')
              : t('onboardingStart')}
        </button>
      {/if}
      <button class="button secondary" type="button" onclick={close} disabled={closing}>
        {t('onboardingClose')}
      </button>
    </div>
  </div>
  {#if closeFailed || tryFailed}
    <p class="error" role="alert">{t('errorAction')}</p>
  {/if}

  <footer class="footer">
    <p class="notice">{t('unofficialNotice')}</p>
  </footer>
</main>

<style>
  .onboarding {
    display: grid;
    gap: var(--space-4);
    max-width: 540px;
    margin: 0 auto;
    padding: 56px var(--space-5) var(--space-6);
  }

  .hero {
    display: grid;
    gap: var(--space-2);
    justify-items: start;
  }

  .hero img {
    border-radius: 16px;
    margin-bottom: var(--space-2);
  }

  .eyebrow {
    color: var(--accent-strong);
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  h1 {
    font-size: 26px;
    line-height: 1.25;
  }

  .lead {
    color: var(--muted);
    font-size: 14px;
  }

  h2 {
    margin-bottom: var(--space-3);
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--muted);
  }

  .ready {
    border-color: var(--accent);
    background: color-mix(in srgb, var(--accent) 12%, var(--surface));
  }

  .ready-title {
    margin-bottom: var(--space-2);
    font-size: 22px;
    font-weight: 700;
    letter-spacing: 0;
    line-height: 1.35;
    text-transform: none;
    color: var(--text);
  }

  .ready ul {
    display: grid;
    gap: var(--space-2);
    margin-top: var(--space-3);
  }

  .ready li {
    position: relative;
    padding-left: 16px;
  }

  .ready li::before {
    content: '';
    position: absolute;
    top: 0.68em;
    left: 2px;
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--accent);
  }

  .notes ul {
    display: grid;
    gap: var(--space-2);
    margin-bottom: var(--space-3);
  }

  .notes li {
    position: relative;
    padding-left: 16px;
  }

  .notes li::before {
    content: '';
    position: absolute;
    top: 0.68em;
    left: 2px;
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--accent);
  }

  .track {
    height: 8px;
    overflow: hidden;
    border-radius: 999px;
    background: var(--surface-muted);
  }

  .track > span {
    display: block;
    height: 100%;
    background: var(--accent);
  }

  .progress {
    display: grid;
    gap: var(--space-2);
  }

  .actions {
    display: grid;
    gap: var(--space-3);
  }

  .start-note {
    margin: 0;
    color: var(--muted);
    font-size: 13px;
    line-height: 1.5;
  }

  .consent {
    border-color: var(--accent);
    background: color-mix(in srgb, var(--accent) 8%, var(--surface));
  }

  .consent .terms {
    display: grid;
    gap: var(--space-3);
  }

  .consent h3 {
    margin: 0 0 var(--space-1);
    font-size: 13px;
    font-weight: 700;
    letter-spacing: 0;
    text-transform: none;
    color: var(--text);
  }

  .consent .conditions {
    display: grid;
    gap: var(--space-1);
    margin-top: var(--space-2);
    padding-left: 18px;
    list-style: disc;
    font-size: 13px;
  }

  .consent .age {
    margin-top: var(--space-3);
    font-size: 13px;
  }

  .reconsent {
    margin-bottom: var(--space-1);
    font-weight: 700;
    font-size: 13px;
  }

  .more {
    margin-top: var(--space-2);
    font-size: 13px;
  }

  .more > summary {
    cursor: pointer;
    color: var(--accent-strong);
    font-weight: 600;
  }

  .more ul {
    margin-top: var(--space-2);
  }

  .consent-links {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-3);
    margin-top: var(--space-3);
    font-size: 13px;
  }

  .action-row {
    display: flex;
    gap: var(--space-2);
    justify-content: flex-end;
  }

  .action-row .button {
    min-width: 112px;
  }

  .footer {
    display: grid;
    gap: var(--space-1);
  }

  @media (prefers-reduced-motion: reduce) {
    .track > span {
      transition: none;
    }
  }
</style>
