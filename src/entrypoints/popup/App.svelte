<script lang="ts">
  import { onMount } from 'svelte';
  import { browser } from 'wxt/browser';
  import { HIGH_QUALITY_MODEL_ID, getModel } from '@/engine/model/catalog';
  import { shouldSuggestHighQuality } from '@/engine/model/suggestion';
  import { modelStartBlocked, type EngineStatus, type ModelStatus } from '@/shared/engine-status';
  import { hasLicenseConsent } from '@/shared/agreement';
  import { currentUiLanguage, t, type MessageKey } from '@/shared/i18n';
  import {
    isModelProgressMessage,
    requestEngineStatus,
    requestEngineWarm,
    requestModelDownload,
    requestPageCommand,
    requestPageState,
    requestQualitySample,
    requestShortcutSnapshot,
    type PageViewState,
    type ShortcutQueryResult,
  } from '@/shared/messages';
  import { ensureContentScript } from '@/shared/page-bridge';
  import type { QualitySample } from '@/shared/quality';
  import type { Settings } from '@/shared/settings';
  import { loadSettings, saveSettings, subscribeSettings } from '@/shared/storage';
  import {
    loadSiteRule,
    pageHost,
    siteAccessOrigins,
    saveSiteRule,
    subscribeSiteRules,
    type SiteRule,
  } from '@/dom/sites';
  import { isChromeOnlyLanguage, resolvePageTarget, type TargetLanguage } from '@/shared/languages';
  import { advanceModelStatus } from '@/shared/model-progress';
  import { openShortcutEditor } from '@/shared/shortcut-editor';
  import {
    DEFAULT_SHORTCUTS,
    SHORTCUT_COMMANDS,
    ariaShortcut,
    boundShortcut,
    displayShortcut,
    type ShortcutCommand,
  } from '@/shared/shortcuts';
  import { readDeviceHeadroom, type DeviceHeadroom } from '@/ui/device-headroom';
  import LanguageField from '@/ui/LanguageField.svelte';
  import { runtimeLabel } from '@/ui/runtime-label';

  type SettingsError = 'load' | 'save' | null;

  /** The hints under the button, each naming the key bound right now. */
  const SHORTCUT_HINTS: readonly { label: MessageKey; command: ShortcutCommand }[] = [
    { label: 'shortcutTranslate', command: 'translate-page' },
    { label: 'shortcutBilingual', command: 'toggle-bilingual' },
    { label: 'shortcutSelection', command: 'translate-selection' },
    { label: 'shortcutCompose', command: 'translate-compose' },
  ];

  let settings = $state<Settings | null>(null);
  let settingsError = $state<SettingsError>(null);
  let uiLanguage = $state(currentUiLanguage());
  let tabId = $state<number | undefined>(undefined);
  let pageUrl = $state('');
  let host = $state<string | null>(null);
  let rule = $state<SiteRule | null>(null);
  let view = $state<PageViewState | null>(null);
  let pageReady = $state(false);
  let pageMessage = $state<'ready' | 'unsupported' | 'unread'>('unsupported');
  let commandBusy = $state(false);
  let permissionError = $state(false);
  let engine = $state<EngineStatus | null>(null);
  let modelMark = $state<ModelStatus | null>(null);
  let quality = $state<QualitySample | null>(null);
  let headroom = $state<DeviceHeadroom | null>(null);
  let shortcuts = $state<ShortcutQueryResult | null>(null);
  let shortcutError = $state(false);

  /**
   * The key each command actually uses on a page. A browser-assigned key wins. The
   * manifest default fills in only when the browser never assigned one. Sakutto's own
   * setting, or a key the user cleared in the browser, turns the command off.
   */
  let bound = $derived.by((): Record<ShortcutCommand, string> => {
    const enabled = settings?.shortcutsEnabled;
    const next: Record<ShortcutCommand, string> = { ...DEFAULT_SHORTCUTS };
    for (const command of SHORTCUT_COMMANDS) {
      next[command] = boundShortcut(shortcuts?.snapshot ?? null, command, {
        fallback: DEFAULT_SHORTCUTS[command],
        enabled: enabled?.[command] !== false,
        assigned: shortcuts?.assigned[command],
      });
    }
    return next;
  });
  let shortcutLines = $derived(
    SHORTCUT_HINTS.filter((hint) => bound[hint.command].length > 0).map((hint) => ({
      label: hint.label,
      text: t(hint.label, [keyText(hint.command)]),
    })),
  );
  let toggleKeys = $derived(ariaShortcut(bound['translate-page']) ?? undefined);

  function keyText(command: ShortcutCommand): string {
    const shortcut = bound[command];
    return shortcut.length > 0 ? displayShortcut(shortcut) : t('shortcutUnset');
  }

  let storedTarget = $derived(rule?.targetLanguage ?? settings?.targetLanguage ?? 'en');
  let targetLanguage = $derived(
    resolvePageTarget(view?.pageLanguage ?? null, storedTarget, rule?.targetLanguage !== undefined),
  );
  let display = $derived(rule?.display ?? settings?.display ?? 'replace');
  let translated = $derived(view?.active === true);
  let primaryLabel = $derived(translated ? t('restoreThisPage') : t('translateThisPage'));
  /**
   * The toolbar button starts a page translation, so it waits for the model the same way
   * the onboarding card does. Restoring an already translated page is always allowed, and
   * a Chrome-only target never needed PLaMo in the first place. An unknown status (the
   * first moment of the popup, or a host that did not answer) keeps the button as it is
   * rather than locking it on a guess.
   */
  let canStart = $derived(
    translated ||
      isChromeOnlyLanguage(targetLanguage) ||
      !modelStartBlocked(engine?.model ?? modelMark),
  );
  let engineText = $derived.by(() => {
    const label = runtimeLabel({
      status: engine,
      pageSimple: view?.active === true && view.engine === 'chrome',
      targetLanguage,
    });
    return t(label.key, label.substitutions);
  });
  let offer = $derived(
    settings !== null &&
      shouldSuggestHighQuality({
        tier: engine?.tier ?? null,
        paragraphMs: quality?.milliseconds ?? null,
        deviceMemoryGb: headroom?.deviceMemoryGb ?? null,
        freeStorageBytes: headroom?.freeStorageBytes ?? null,
        maxBufferSize: headroom?.maxBufferSize ?? null,
        modelBytes: getModel(HIGH_QUALITY_MODEL_ID).size,
        dismissed: settings.highQualityDismissed,
        usingHighQuality: engine?.model.id === HIGH_QUALITY_MODEL_ID && engine.plamoReady,
      }),
  );

  async function refreshSettings() {
    try {
      settings = await loadSettings();
      settingsError = null;
    } catch {
      settingsError = 'load';
    }
  }

  async function refreshPage() {
    permissionError = false;
    try {
      const tabs = await browser.tabs.query({ active: true, currentWindow: true });
      const tab = tabs[0];
      tabId = tab?.id;
      pageUrl = tab?.url ?? '';
      host = pageUrl ? pageHost(pageUrl) : null;
      pageReady = tabId !== undefined && host !== null;
      if (!pageReady || !host || tabId === undefined) {
        view = null;
        rule = null;
        pageMessage = 'unsupported';
        return;
      }
      pageMessage = 'ready';
      await ensureContentScript(tabId);
      const [nextRule, nextView] = await Promise.all([loadSiteRule(host), requestPageState(tabId)]);
      rule = nextRule;
      view = nextView;
    } catch {
      pageReady = false;
      pageMessage = 'unread';
    }
  }

  function rememberModel(status: ModelStatus | null): ModelStatus | null {
    if (!status) return modelMark;
    const next = advanceModelStatus(modelMark, status);
    modelMark = next;
    return next;
  }

  async function refreshEngine() {
    const next = await requestEngineStatus();
    if (!next) return;
    engine = { ...next, model: rememberModel(next.model) ?? next.model };
  }

  function applyProgress(status: ModelStatus) {
    const next = rememberModel(status);
    if (!next) return;
    if (engine && engine.model.id === next.id) {
      engine = { ...engine, model: next };
      return;
    }
    void refreshEngine();
  }

  async function rememberSite(patch: Partial<SiteRule>) {
    if (!host) return;
    try {
      const current = await loadSiteRule(host);
      rule = await saveSiteRule({ ...current, ...patch, host });
      settingsError = null;
    } catch {
      settingsError = 'save';
    }
  }

  async function translatePage() {
    if (commandBusy || tabId === undefined || !host) return;
    commandBusy = true;
    try {
      if (!(await ensureContentScript(tabId))) {
        pageReady = false;
        return;
      }
      view = await requestPageCommand(tabId, view?.active ? 'restore' : 'toggle');
    } finally {
      commandBusy = false;
    }
  }

  async function setAlways(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    if (!host) return;
    permissionError = false;
    if (input.checked) {
      const origins = siteAccessOrigins(pageUrl);
      if (!origins) {
        input.checked = false;
        permissionError = true;
        return;
      }
      const granted = await browser.permissions.request({ origins }).catch(() => false);
      if (!granted) {
        input.checked = false;
        permissionError = true;
        return;
      }
      await rememberSite({ auto: 'always' });
      return;
    }
    await rememberSite({ auto: 'ask' });
  }

  async function useHighQuality() {
    if (!hasLicenseConsent(settings)) {
      await browser.tabs
        .create({ url: browser.runtime.getURL('/onboarding.html') })
        .catch(() => undefined);
      return;
    }
    try {
      settings = await saveSettings({ highQualityDismissed: true });
      await requestModelDownload(HIGH_QUALITY_MODEL_ID);
    } catch {
      settingsError = 'save';
    }
  }

  async function dismissHighQuality() {
    try {
      settings = await saveSettings({ highQualityDismissed: true });
    } catch {
      settingsError = 'save';
    }
  }

  function openOptions() {
    void browser.runtime.openOptionsPage().catch(() => undefined);
  }

  async function changeShortcuts() {
    shortcutError = !(await openShortcutEditor());
  }

  function openOnboarding() {
    void browser.tabs
      .create({ url: browser.runtime.getURL('/onboarding.html') })
      .catch(() => undefined);
  }

  function openTyped() {
    void browser.tabs.create({ url: browser.runtime.getURL('/typed.html') }).catch(() => undefined);
  }

  onMount(() => {
    const unsubscribe = subscribeSettings((next) => {
      settings = next;
      settingsError = null;
    });
    const unsubscribeRules = subscribeSiteRules(() => {
      void refreshPage();
    });
    const timer = window.setInterval(() => {
      if (tabId === undefined || view?.active !== true || view.pending === 0) return;
      void refreshPage();
    }, 400);
    const onMessage = (message: unknown) => {
      if (!isModelProgressMessage(message)) return;
      applyProgress(message.status);
    };
    browser.runtime.onMessage.addListener(onMessage);

    void refreshSettings();
    void refreshPage();
    void refreshEngine();
    void requestEngineWarm();
    void requestQualitySample().then((sample) => {
      quality = sample;
    });
    void readDeviceHeadroom().then((value) => {
      headroom = value;
    });
    void requestShortcutSnapshot().then((snapshot) => {
      shortcuts = snapshot;
    });

    return () => {
      unsubscribe();
      unsubscribeRules();
      window.clearInterval(timer);
      browser.runtime.onMessage.removeListener(onMessage);
    };
  });
</script>

<main class="popup">
  <header class="brand">
    <img src="/icon/32.png" alt="" width="28" height="28" />
    <div>
      <h1>{t('extensionName')}</h1>
      <p class="muted">{t('tagline')}</p>
    </div>
  </header>

  <button
    class="button block"
    type="button"
    aria-keyshortcuts={toggleKeys}
    aria-busy={view?.pending ? 'true' : 'false'}
    disabled={!pageReady || commandBusy || !canStart}
    onclick={translatePage}
  >
    {primaryLabel}
  </button>

  {#if !canStart}
    <div class="panel gate" role="status">
      <p class="muted">{t('pageStartBlocked')}</p>
      <button class="link-button" type="button" onclick={openOnboarding}>
        {t('openOnboarding')}
      </button>
    </div>
  {/if}

  <p class="engine" aria-live="polite">{engineText}</p>
  {#if engine}
    <p class="muted">
      {(engine.backend === 'webgpu'
        ? t('diagBackendGpu')
        : engine.backend === 'cpu-wasm'
          ? t('diagBackendCpu')
          : t('diagBackendUnknown')) +
        (engine.threads !== null ? ` · ${t('diagThreads')} ${String(engine.threads)}` : '') +
        (engine.parallel !== null ? ` · n_parallel ${String(engine.parallel)}` : '')}
    </p>
  {/if}
  {#if view?.active && view.tokensPerSecond !== null && view.segmentsPerSecond !== null}
    <p class="muted" aria-live="polite">
      {t('pageRate', [view.tokensPerSecond.toFixed(1), view.segmentsPerSecond.toFixed(1)])}
    </p>
  {/if}
  {#if view?.active && view.pending > 0 && view.total > 0}
    <p class="muted" aria-live="polite">
      {t('pageProgress', [String(view.done), String(view.total)])}
    </p>
    <div
      class="track"
      role="progressbar"
      aria-valuemin="0"
      aria-valuemax={view.total}
      aria-valuenow={view.done}
      aria-label={t('pageProgressLabel')}
    >
      <span style="width: {(view.done / view.total) * 100}%"></span>
    </div>
  {:else if view?.pending}
    <p class="muted">{t('pageTranslating')}</p>
  {/if}
  {#if view?.targetAdjusted}
    <p class="muted">{t('targetAdjustedNote')}</p>
  {/if}
  {#if view?.active && view.pending === 0 && view.skipped > 0}
    <p class="muted" role="status">{t('pagePartial', [String(view.skipped)])}</p>
  {/if}
  {#if view?.sameLanguage}
    <p class="muted">{t('sameLanguageHint')}</p>
  {/if}

  {#if settings && pageReady}
    <section class="panel" aria-label={t('settingsLabel')}>
      <LanguageField
        value={targetLanguage}
        {uiLanguage}
        onChange={(language: TargetLanguage) => rememberSite({ targetLanguage: language })}
      />
      <label class="field">
        <span>{t('displayLabel')}</span>
        <span class="hint">{t('displaySiteHint')}</span>
        <select
          value={display}
          onchange={(event) => {
            const select = event.currentTarget as HTMLSelectElement;
            void rememberSite({
              display: select.value === 'bilingual' ? 'bilingual' : 'replace',
            });
          }}
        >
          <option value="replace">{t('displayReplace')}</option>
          <option value="bilingual">{t('displayBilingual')}</option>
        </select>
      </label>
      <label class="check">
        <input type="checkbox" checked={rule?.auto === 'always'} onchange={setAlways} />
        <span>{t('alwaysTranslateSite')}</span>
      </label>
      {#if permissionError}
        <p class="error" role="alert">{t('errorPermission')}</p>
      {/if}
    </section>
  {:else if !pageReady}
    <p class="muted">
      {pageMessage === 'unread' ? t('errorPage') : t('pageStatusUnavailable')}
    </p>
  {/if}

  {#if settingsError}
    <p class="error" role="alert">
      {settingsError === 'save' ? t('errorSaveSettings') : t('errorSettings')}
    </p>
  {/if}

  {#if offer}
    <section class="panel offer">
      <p>{t('highQualityOffer')}</p>
      <div class="offer-actions">
        <button class="button" type="button" onclick={useHighQuality}>{t('useHighQuality')}</button>
        <button class="button secondary" type="button" onclick={dismissHighQuality}>
          {t('dismissHighQuality')}
        </button>
      </div>
    </section>
  {/if}

  <ul class="shortcuts">
    {#each shortcutLines as line (line.label)}
      <li>{line.text}</li>
    {/each}
  </ul>
  <button class="link-button shortcut-change" type="button" onclick={changeShortcuts}>
    {t('shortcutChange')}
  </button>
  {#if shortcutError}
    <p class="error" role="alert">{t('errorAction')}</p>
  {/if}

  <button class="button secondary block" type="button" onclick={openTyped}>
    {t('openTyped')}
  </button>

  <footer class="footer">
    <button class="link-button" type="button" onclick={openOptions}>{t('openOptions')}</button>
    <p class="notice">{t('unofficialNotice')}</p>
  </footer>
</main>

<style>
  .popup {
    display: grid;
    gap: var(--space-3);
    width: 336px;
    padding: var(--space-4);
  }

  .brand {
    display: flex;
    align-items: center;
    gap: var(--space-3);
  }

  .brand img {
    border-radius: var(--radius-sm);
  }

  h1 {
    font-size: 14px;
    font-weight: 700;
  }

  .brand p,
  .engine,
  .shortcuts {
    font-size: 12px;
  }

  .engine {
    font-weight: 700;
  }

  .track {
    height: 6px;
    overflow: hidden;
    border-radius: 999px;
    background: var(--border);
  }

  .track > span {
    display: block;
    height: 100%;
    background: var(--accent);
  }

  .hint {
    font-weight: 400;
  }

  .field,
  .check {
    display: grid;
    gap: var(--space-1);
    margin-top: var(--space-3);
  }

  .check {
    grid-template-columns: auto 1fr;
    align-items: center;
    gap: var(--space-2);
  }

  .field > span {
    color: var(--muted);
    font-size: 11px;
    font-weight: 600;
  }

  select {
    width: 100%;
    padding: 7px 9px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface);
    color: var(--text);
  }

  .offer p {
    margin-bottom: var(--space-2);
  }

  .gate {
    display: grid;
    gap: var(--space-2);
    justify-items: start;
  }

  .gate .link-button {
    font-size: 12px;
  }

  .offer-actions {
    display: flex;
    gap: var(--space-2);
  }

  .shortcuts {
    display: grid;
    gap: 2px;
    color: var(--muted);
  }

  .shortcut-change {
    justify-self: start;
    font-size: 11px;
  }

  .footer {
    display: grid;
    gap: var(--space-2);
  }

  .footer .link-button {
    justify-self: start;
    font-size: 11px;
  }
</style>
