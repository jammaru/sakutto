<script lang="ts">
  import { readRuntimeLastError } from '@/shared/runtime-last-error';
  import { onMount } from 'svelte';
  import { browser } from 'wxt/browser';
  import { DEFAULT_MODEL_ID, HIGH_QUALITY_MODEL_ID, getModel } from '@/engine/model/catalog';
  import { sharedFolderSettingsHref } from '@/engine/model/folder-offer';
  import { shouldSuggestHighQuality } from '@/engine/model/suggestion';
  import {
    modelNeedsDownload,
    sharedFolderNeedsUserAction,
    shouldShowModelDownloadGate,
    translationStartBlocked,
    type EngineStatus,
    type ModelStatus,
  } from '@/shared/engine-status';
  import { sharedFolderNeedsPermission } from '@/engine/model/folder-status';
  import {
    queryStoredFolderPermission,
    sharedFolderPickerAvailable,
  } from '@/engine/model/shared-folder';
  import { hasLicenseConsent } from '@/shared/agreement';
  import { openOrFocusExtensionTab } from '@/shared/extension-tabs';
  import { currentUiLanguage, t, type MessageKey } from '@/shared/i18n';
  import {
    isModelProgressMessage,
    requestEngineStatus,
    requestEngineWarm,
    requestModelDownload,
    requestResumeFolderGrantPending,
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
  import { readFolderGrantPending } from '@/shared/folder-grant-pending';
  import {
    isPdfInspectResult,
    isPdfOpenResult,
    looksLikePdfUrl,
    type PdfInspectRequest,
    type PdfOpenRequest,
    type PdfOpenReason,
  } from '@/shared/pdf';
  import {
    loadSiteRule,
    pageHost,
    siteAccessOrigins,
    saveSiteRule,
    subscribeSiteRules,
    type SiteRule,
  } from '@/dom/sites';
  import { hostMatchesCaptionCustom } from '@/captions/custom-hosts';
  import {
    isCaptionAutoHost,
    resolveCaptionToggle,
    settleCaptionEnableIntent,
  } from '@/captions/sites';
  import {
    allSitesGrantCoversOrigins,
    hasAllSitesAccess,
    requestAllSitesAccess,
    syncAllSitesContentScripts,
  } from '@/dom/all-sites';
  import {
    readAllSitesPromoOpenCount,
    resolveAllSitesPromoPlacement,
    saveAllSitesPromoOpenCount,
    type AllSitesPromoPlacement,
  } from '@/dom/all-sites-promo';
  import {
    clearMailEnableIntent,
    hasMailOriginAccess,
    isMailHost,
    markMailEnableIntent,
    requestMailHostAccess,
    settleMailEnableIntent,
    syncMailContentScripts,
  } from '@/dom/mail-sites';
  import { hasBuiltInTranslatorUi } from '@/shared/browser';
  import {
    effectivePageTarget,
    isChromeOnlyLanguage,
    type TargetLanguage,
  } from '@/shared/languages';
  import { advanceModelStatus } from '@/shared/model-progress';
  import { openShortcutEditor } from '@/shared/shortcut-editor';
  import {
    SHORTCUT_COMMANDS,
    ariaShortcut,
    boundShortcut,
    defaultShortcuts,
    displayShortcut,
    showShortcutUnsetNotice,
    type ShortcutCommand,
  } from '@/shared/shortcuts';
  import { SHARED_FOLDER_CHANGED_EVENT } from '@/engine/model/folder-offer';
  import { FOLDER_PERMISSION_ERROR } from '@/engine/model/folder-permission';
  import { readDeviceHeadroom, type DeviceHeadroom } from '@/ui/device-headroom';
  import LanguageField from '@/ui/LanguageField.svelte';
  import ShortcutUnsetNotice from '@/ui/ShortcutUnsetNotice.svelte';
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
  let captionPermissionError = $state(false);
  let mailAccessGranted = $state<boolean | null>(null);
  let mailPermissionError = $state(false);
  let mailPermissionBusy = $state(false);
  let allSitesGranted = $state<boolean | null>(null);
  /** Popup opens recorded while all-sites access was off, including this one. */
  let allSitesPromoOpenCount = $state<number | null>(null);
  let pdfUrl = $state('');
  let pdfBusy = $state(false);
  let pdfFailed = $state(false);
  let pdfFailReason = $state<PdfOpenReason | null>(null);
  let engine = $state<EngineStatus | null>(null);
  let engineStatusError = $state(false);
  /** True after an activation-driven grant attempt failed in the popup. */
  let pendingFolderGrant = $state(false);
  let folderEnableBusy = $state(false);
  let modelMark = $state<ModelStatus | null>(null);
  let quality = $state<QualitySample | null>(null);
  let headroom = $state<DeviceHeadroom | null>(null);
  let shortcuts = $state<ShortcutQueryResult | null>(null);
  let shortcutError = $state(false);
  let showShortcutChange = $derived(!showShortcutUnsetNotice(shortcuts?.snapshot ?? null));
  /**
   * Decided before the hint first renders: the count and the live grant are read together,
   * so a repeat open paints the block in its lower slot directly instead of moving it after
   * mount. The first open keeps the block above the mail and caption sections.
   */
  let allSitesPromoPlacement = $derived.by((): AllSitesPromoPlacement => {
    if (allSitesGranted !== false || allSitesPromoOpenCount === null) return 'hidden';
    return resolveAllSitesPromoPlacement({
      openCount: allSitesPromoOpenCount,
      allSitesGranted: false,
      showHint: host !== null && pdfUrl.length === 0,
    });
  });

  /**
   * The key each browser command currently owns. Before the first answer, manifest
   * suggestions are placeholders. An empty browser binding has no in-page substitute.
   */
  let bound = $derived.by((): Record<ShortcutCommand, string> => {
    const enabled = settings?.shortcutsEnabled;
    const next: Record<ShortcutCommand, string> = { ...defaultShortcuts() };
    for (const command of SHORTCUT_COMMANDS) {
      next[command] = boundShortcut(shortcuts?.snapshot ?? null, command, {
        enabled: enabled?.[command] !== false,
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
  /**
   * The hints under the shortcut button. A PDF tab shows the reader instead of page
   * translation, so none of the page commands apply there. The PDF command has no suggested
   * key either — Chrome allows four and the page commands use them all — so the list is
   * empty on a PDF tab rather than naming a page command that does not apply there.
   */
  let visibleShortcutLines = $derived(pdfUrl.length > 0 ? [] : shortcutLines);
  let toggleKeys = $derived(ariaShortcut(bound['translate-page']) ?? undefined);

  function keyText(command: ShortcutCommand): string {
    const shortcut = bound[command];
    return shortcut.length > 0 ? displayShortcut(shortcut) : t('shortcutUnset');
  }

  let targetLanguage = $derived(
    effectivePageTarget(settings?.targetLanguage ?? 'en', rule?.targetLanguage),
  );
  let display = $derived(rule?.display ?? settings?.display ?? 'replace');
  let translated = $derived(view?.active === true);
  let needsMailAccess = $derived(
    settings?.gmailTranslateBanner === true &&
      host !== null &&
      isMailHost(host) &&
      mailAccessGranted === false,
  );
  let primaryLabel = $derived(translated ? t('restoreThisPage') : t('translateThisPage'));
  let folderNeedsPermission = $derived(sharedFolderNeedsPermission(engine?.sharedFolder));
  let showPendingFolderGrant = $derived(pendingFolderGrant && sharedFolderNeedsUserAction(engine));
  /**
   * The toolbar button starts a page translation, so it waits for the model the same way
   * the onboarding card does. Restoring an already translated page is always allowed, and
   * a Chrome-only target never needed PLaMo in the first place. An unknown status (the
   * first moment of the popup, or a host that did not answer) keeps the button as it is
   * rather than locking it on a guess.
   */
  let canStart = $derived(
    translated ||
      (hasBuiltInTranslatorUi() && isChromeOnlyLanguage(targetLanguage)) ||
      // A folder-only install can show the permission error before the reader clicks.
      // Keep the button usable so that click can renew the grant instead of requiring a
      // second click on the separate restore card.
      folderNeedsPermission ||
      !translationStartBlocked(engine ?? (modelMark ? { model: modelMark } : null)),
  );
  let modelNeedsInstall = $derived(
    modelNeedsDownload(engine ?? (modelMark ? { model: modelMark } : null)),
  );
  let canChooseFolder = $derived(
    sharedFolderPickerAvailable() || engine?.sharedFolder?.supported === true,
  );
  let showDownloadGate = $derived(
    !canStart && shouldShowModelDownloadGate(engine ?? (modelMark ? { model: modelMark } : null)),
  );
  let engineText = $derived.by(() => {
    if (!engine && engineStatusError) return t('runtimeError');
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

  /**
   * Reads the live grant and the stored open count in parallel with the rest of the popup
   * bootstrap. The count advances once per mount only while all-sites stays off, so a later
   * grant never rewrites what "first open" meant.
   */
  async function prepareAllSitesPromo(): Promise<void> {
    const [granted, storedOpenCount] = await Promise.all([
      hasAllSitesAccess(),
      readAllSitesPromoOpenCount(),
    ]);
    allSitesGranted = granted;
    if (granted) return;
    const openCount = storedOpenCount + 1;
    allSitesPromoOpenCount = openCount;
    void saveAllSitesPromoOpenCount(openCount);
  }

  async function refreshPage() {
    permissionError = false;
    mailPermissionError = false;
    mailAccessGranted = null;
    pdfFailed = false;
    pdfFailReason = null;
    try {
      const tabs = await browser.tabs.query({ active: true, currentWindow: true });
      const tab = tabs[0];
      tabId = tab?.id;
      pageUrl = tab?.url ?? '';
      // A PDF tab shows Chrome's own viewer, which no content script can reach, so the popup
      // offers the reader instead of the page controls. Paths that omit `.pdf` still count
      // when the live document or the response is `application/pdf`.
      pdfUrl = tab?.url && looksLikePdfUrl(tab.url) ? tab.url : '';
      if (pdfUrl.length === 0 && tabId !== undefined) {
        const inspected: unknown = await browser.runtime.sendMessage({
          type: 'pdf:inspect',
          tabId,
        } satisfies PdfInspectRequest);
        if (isPdfInspectResult(inspected) && inspected.pdf) pdfUrl = tab?.url ?? '';
      }
      host = pageUrl ? pageHost(pageUrl) : null;
      pageReady = tabId !== undefined && host !== null;
      if (host && isMailHost(host)) mailAccessGranted = await hasMailOriginAccess(host);
      if (pdfUrl.length > 0) {
        view = null;
        rule = null;
        pageMessage = 'ready';
        pageReady = true;
        return;
      }
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

  const ENGINE_STATUS_RETRY_MS = 1000;
  const ENGINE_STATUS_RETRY_LIMIT = 4;
  const ENGINE_STATUS_POLL_MS = 900;
  let engineRetryCount = 0;
  let engineRefreshTimer = 0;
  let engineRequestGeneration = 0;
  let popupMounted = false;

  function scheduleEngineRefresh(delayMs: number) {
    if (!popupMounted) return;
    window.clearTimeout(engineRefreshTimer);
    engineRefreshTimer = window.setTimeout(() => {
      engineRefreshTimer = 0;
      void refreshEngine();
    }, delayMs);
  }

  /**
   * A failed status fetch is not a final answer: the offscreen host may still be starting.
   * Retry a few times, then stop saying "checking" and show an error instead. A loading model
   * keeps polling until the host says it is usable, so the popup cannot stay on "waiting".
   */
  async function refreshEngine(): Promise<boolean> {
    window.clearTimeout(engineRefreshTimer);
    engineRefreshTimer = 0;
    const generation = ++engineRequestGeneration;
    const next = await requestEngineStatus();
    if (generation !== engineRequestGeneration) return false;

    if (!next) {
      engineStatusError = false;
      if (engineRetryCount < ENGINE_STATUS_RETRY_LIMIT) {
        engineRetryCount += 1;
        scheduleEngineRefresh(ENGINE_STATUS_RETRY_MS);
      } else {
        engineStatusError = true;
      }
      return false;
    }

    engineRetryCount = 0;
    engineStatusError = false;
    engine = { ...next, model: rememberModel(next.model) ?? next.model };
    void refreshFolderGrantPending();
    if (next.model.state === 'loading') scheduleEngineRefresh(ENGINE_STATUS_POLL_MS);
    return true;
  }

  function applyProgress(status: ModelStatus) {
    if (
      status.error === FOLDER_PERMISSION_ERROR ||
      status.state === 'ready' ||
      status.state === 'loaded' ||
      status.state === 'loading'
    ) {
      // Re-query the full engine snapshot. Patching only `model` leaves
      // `plamoReady` / `sharedFolder` stale, so the popup stays on "waiting".
      void refreshEngine();
      return;
    }
    const next = rememberModel(status);
    if (!next) return;
    if (engine && engine.model.id === next.id) {
      engine = { ...engine, model: next };
      // Backend and plamoReady can change under the same model id (notably WebGPU falling
      // back to the CPU), so re-query instead of patching only the model field.
      if (next.state === 'loaded' || next.state === 'ready') void refreshEngine();
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

  async function changeTarget(language: TargetLanguage) {
    void ensureFolderPermissionForAction();
    try {
      settings = await saveSettings({ targetLanguage: language });
      if (host && rule?.targetLanguage !== undefined) {
        const current = await loadSiteRule(host);
        const next = { ...current, host };
        delete next.targetLanguage;
        rule = await saveSiteRule(next);
      }
      settingsError = null;
    } catch {
      settingsError = 'save';
    }
  }

  /**
   * A popup click is a user gesture, so a dormant folder grant can be renewed here without
   * sending the reader to Settings. A query that is already granted costs no prompt and no
   * reload. This only runs for a page action that is about to read the folder.
   */
  interface FolderActionAccess {
    allowed: boolean;
    /** True when resuming a deferred command already performed the page action. */
    resumed: boolean;
  }

  async function ensureFolderPermissionForAction(): Promise<FolderActionAccess> {
    // The popup may only query. Persistent grant prompts run in the folder-enable tab.
    const permission = await queryStoredFolderPermission().catch(() => null);
    if (permission === 'granted') {
      const resumed = await requestResumeFolderGrantPending();
      return { allowed: true, resumed };
    }
    return { allowed: true, resumed: false };
  }

  async function translatePage() {
    if (commandBusy || tabId === undefined || !host) return;
    commandBusy = true;
    try {
      const access = await ensureFolderPermissionForAction();
      if (!access.allowed) return;
      // The resumed deferred command already toggled the page. Sending another command
      // here would translate twice or restore immediately after the resume.
      if (access.resumed) {
        view = await requestPageState(tabId);
        return;
      }
      if (!(await ensureContentScript(tabId))) {
        pageReady = false;
        pageMessage = 'unread';
        return;
      }
      view = await requestPageCommand(tabId, view?.active ? 'restore' : 'toggle');
    } finally {
      commandBusy = false;
    }
  }

  /**
   * Opens the PDF the tab shows in the extension's reader.
   *
   * The background reads the bytes, stores them and opens the reader tab, because a popup
   * closes as soon as it loses focus and a fetch from here would be cancelled halfway.
   */
  async function openPdf() {
    if (pdfBusy || tabId === undefined || pdfUrl.length === 0) return;
    pdfBusy = true;
    pdfFailed = false;
    pdfFailReason = null;
    try {
      const response: unknown = await browser.runtime.sendMessage({
        type: 'pdf:open',
        tabId,
      } satisfies PdfOpenRequest);
      if (!isPdfOpenResult(response) || !response.opened) {
        pdfFailed = true;
        pdfFailReason = isPdfOpenResult(response) && !response.opened ? response.reason : null;
      }
    } catch {
      pdfFailed = true;
    } finally {
      pdfBusy = false;
    }
  }

  async function setVideoCaptions(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    captionPermissionError = false;
    // User gesture: resolveCaptionToggle must call permissions.request with no prior pause.
    const result = await resolveCaptionToggle(input.checked);
    input.checked = result.on;
    if (result.denied) {
      captionPermissionError = true;
      return;
    }
    try {
      settings = await saveSettings({ translateVideoCaptions: result.on });
      settingsError = null;
    } catch {
      settingsError = 'save';
      input.checked = settings?.translateVideoCaptions === true;
      return;
    }
    if (
      result.on &&
      tabId !== undefined &&
      host &&
      (isCaptionAutoHost(host) || hostMatchesCaptionCustom(host, settings.captionCustomHosts))
    ) {
      await ensureContentScript(tabId);
    }
  }

  /**
   * One-click opt-in for every http/https page. Chrome closes the popup while the prompt
   * is open; nothing stored depends on this page surviving, because the live permission is
   * the source of truth and the background re-syncs from `permissions.onAdded`.
   * `permissions.request` must be the first awaited call in this click.
   */
  async function enableAllSites() {
    const granted = await requestAllSitesAccess();
    allSitesGranted = granted;
    if (granted) await syncAllSitesContentScripts();
  }

  /**
   * One-click grant for the Gmail/Outlook banner. Chrome closes the popup while its prompt
   * is open, so the background also re-syncs and re-injects when `permissions.onAdded`
   * fires. `permissions.request` must be the first awaited call in this click.
   */
  async function enableMailTranslation() {
    if (mailPermissionBusy) return;
    mailPermissionError = false;
    mailPermissionBusy = true;
    markMailEnableIntent();
    const granted = await requestMailHostAccess();
    if (!granted) {
      mailPermissionBusy = false;
      mailPermissionError = true;
      await clearMailEnableIntent();
      return;
    }
    await syncMailContentScripts();
    await clearMailEnableIntent();
    mailAccessGranted = true;
    if (tabId !== undefined) await ensureContentScript(tabId);
    mailPermissionBusy = false;
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
      // A broad all-sites grant already covers these http/https origins and requesting
      // them would still prompt, so the grant alone turns the rule on. Otherwise
      // `permissions.request` stays the first awaited call in this click.
      const granted = allSitesGrantCoversOrigins(origins)
        ? true
        : await browser.permissions.request({ origins }).catch(() => false);
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
      void openOrFocusExtensionTab('/onboarding.html');
      return;
    }
    try {
      await ensureFolderPermissionForAction();
      settings = await saveSettings({ highQualityDismissed: true });
      await requestModelDownload(HIGH_QUALITY_MODEL_ID);
    } catch {
      settingsError = 'save';
    }
  }

  async function refreshFolderGrantPending(): Promise<void> {
    pendingFolderGrant = (await readFolderGrantPending()) !== null;
  }

  /** Re-grants must happen in a tab so Chrome can persist "Allow on every visit". */
  async function enablePendingFolderGrant(): Promise<void> {
    if (folderEnableBusy) return;
    folderEnableBusy = true;
    try {
      await browser.runtime.sendMessage({ type: 'folder:open-enable' }).catch(() => {
        readRuntimeLastError();
      });
      pendingFolderGrant = false;
      window.close();
    } finally {
      folderEnableBusy = false;
    }
  }

  /** Toolbar open is not a user gesture; refresh status only, never auto-show the restore card. */
  async function refreshEngineOnOpen(): Promise<void> {
    await refreshEngine();
    await refreshFolderGrantPending();
  }

  /** Explicit recovery after the shared folder was stopped: no "waiting" without a download. */
  async function downloadMissingModel() {
    const stored = settings ?? (await loadSettings().catch(() => null));
    if (!hasLicenseConsent(stored)) {
      void openOrFocusExtensionTab('/onboarding.html');
      return;
    }
    await ensureFolderPermissionForAction();
    await requestModelDownload(DEFAULT_MODEL_ID);
    await refreshEngine();
  }

  function openModelFolderSettings() {
    void openOrFocusExtensionTab(sharedFolderSettingsHref((path) => browser.runtime.getURL(path)));
  }

  async function dismissHighQuality() {
    try {
      settings = await saveSettings({ highQualityDismissed: true });
    } catch {
      settingsError = 'save';
    }
  }

  function openOptions() {
    void browser.runtime.openOptionsPage().catch(() => {
      readRuntimeLastError();
    });
  }

  async function changeShortcuts() {
    shortcutError = !(await openShortcutEditor());
  }

  function openOnboarding() {
    void openOrFocusExtensionTab('/onboarding.html');
  }

  function openTyped() {
    void browser.tabs.create({ url: browser.runtime.getURL('/typed.html') }).catch(() => {
      readRuntimeLastError();
    });
  }

  onMount(() => {
    popupMounted = true;
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
    const onFolderChanged = () => {
      void refreshEngine();
    };
    browser.runtime.onMessage.addListener(onMessage);
    window.addEventListener(SHARED_FOLDER_CHANGED_EVENT, onFolderChanged);

    void settleCaptionEnableIntent().then((settled) => {
      if (settled.applied) void refreshSettings();
    });
    void settleMailEnableIntent().then((settled) => {
      if (!settled.applied) return;
      void refreshSettings();
      void refreshPage();
    });
    void refreshEngineOnOpen();
    void refreshFolderGrantPending();
    void refreshSettings();
    void prepareAllSitesPromo();
    void refreshPage();
    void requestEngineWarm();
    void requestQualitySample().then((sample) => {
      quality = sample;
    });
    void readDeviceHeadroom().then((value) => {
      headroom = value;
    });
    const refreshShortcuts = (): void => {
      void requestShortcutSnapshot().then((snapshot) => {
        if (snapshot) shortcuts = snapshot;
      });
    };
    let shortcutRefreshTimer = 0;
    const scheduleShortcutRefresh = (): void => {
      window.clearTimeout(shortcutRefreshTimer);
      shortcutRefreshTimer = window.setTimeout(refreshShortcuts, 80);
    };
    refreshShortcuts();
    window.addEventListener('focus', scheduleShortcutRefresh);
    document.addEventListener('visibilitychange', scheduleShortcutRefresh);

    return () => {
      popupMounted = false;
      window.clearTimeout(engineRefreshTimer);
      unsubscribe();
      unsubscribeRules();
      window.clearInterval(timer);
      browser.runtime.onMessage.removeListener(onMessage);
      window.clearTimeout(shortcutRefreshTimer);
      window.removeEventListener('focus', scheduleShortcutRefresh);
      document.removeEventListener('visibilitychange', scheduleShortcutRefresh);
      window.removeEventListener(SHARED_FOLDER_CHANGED_EVENT, onFolderChanged);
    };
  });
</script>

<main class="popup">
  {#snippet allSitesHint()}
    <section class="panel all-sites" data-sakutto="all-sites-hint">
      <p class="muted">{t('allSitesPopupHint')}</p>
      <button
        class="link-button"
        type="button"
        data-sakutto="all-sites-enable"
        onclick={() => void enableAllSites()}
      >
        {t('allSitesPopupEnable')}
      </button>
    </section>
  {/snippet}

  <header class="brand">
    <img src="/icon/32.png" alt="" width="28" height="28" />
    <div>
      <h1>{t('extensionName')}</h1>
      <p class="muted">{t('tagline')}</p>
    </div>
  </header>

  {#if showPendingFolderGrant}
    <button
      class="button block"
      type="button"
      data-sakutto="popup-folder-enable"
      disabled={folderEnableBusy}
      onclick={() => void enablePendingFolderGrant()}
    >
      {t('modelFolderEnableOneClick')}
    </button>
  {/if}

  {#if pdfUrl.length > 0}
    <button
      class="button block"
      type="button"
      aria-busy={pdfBusy ? 'true' : 'false'}
      disabled={pdfBusy}
      onclick={openPdf}
    >
      {t('openPdf')}
    </button>
    <p class="muted hint-text">{t('openPdfHint')}</p>
    {#if pdfFailed}
      <p class="error" role="alert">
        {t(pdfFailReason === 'file-denied' ? 'pdfFileAccessDenied' : 'pdfOpenFailed')}
      </p>
    {/if}
  {:else}
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
  {/if}

  {#if showDownloadGate && pdfUrl.length === 0}
    <div class="panel gate" role="status">
      {#if modelNeedsInstall}
        <p class="muted">{t('modelSelectionMissing')}</p>
        <div class="gate-actions">
          <button
            class="button"
            type="button"
            data-sakutto="popup-model-download"
            onclick={() => void downloadMissingModel()}
          >
            {t('modelDownload')}
          </button>
          {#if canChooseFolder}
            <button
              class="button secondary"
              type="button"
              data-sakutto="popup-model-folder"
              onclick={openModelFolderSettings}
            >
              {t('modelFolderChoose')}
            </button>
          {/if}
        </div>
      {:else}
        <p class="muted">{t('pageStartBlocked')}</p>
        <button class="link-button" type="button" onclick={openOnboarding}>
          {t('openOnboarding')}
        </button>
      {/if}
    </div>
  {/if}

  {#if !folderNeedsPermission && !modelNeedsInstall}
    <p class="engine" aria-live="polite">{engineText}</p>
  {/if}
  {#if engine?.modelFallback}
    <p class="muted" role="status">{t('modelSelectionFallback')}</p>
  {/if}

  {#if engine?.engineSource === 'local-server'}
    <p class="muted">{t('localServerExperimental')}</p>
    {#if engine.parallel !== null}
      <p class="muted">{t('diagConcurrent')} {String(engine.parallel)}</p>
    {/if}
  {:else if engine}
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
        onChange={(language: TargetLanguage) => void changeTarget(language)}
      />
      {#if pdfUrl.length === 0}
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
      {/if}
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

  {#if allSitesPromoPlacement === 'top'}
    {@render allSitesHint()}
  {/if}

  {#if settings && needsMailAccess}
    <section class="panel mail-access" data-sakutto="mail-permission">
      <p class="muted">{t('mailBannerAccessNeeded')}</p>
      <button
        class="button block"
        type="button"
        disabled={mailPermissionBusy}
        data-sakutto="mail-permission-enable"
        onclick={enableMailTranslation}
      >
        {t('mailBannerEnableForSite')}
      </button>
      {#if mailPermissionError}
        <p class="error" role="alert" data-sakutto="mail-permission-denied">
          {t('mailBannerPermissionDenied')}
        </p>
      {/if}
    </section>
  {/if}

  {#if settings}
    <label class="check">
      <input
        type="checkbox"
        data-sakutto="video-captions"
        checked={settings.translateVideoCaptions}
        onchange={setVideoCaptions}
      />
      <span>{t('videoCaptionsSetting')}</span>
    </label>
    {#if captionPermissionError}
      <p class="error" role="alert" data-sakutto="video-captions-denied">
        {t('videoCaptionsPermissionDenied')}
      </p>
    {/if}
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
    {#each visibleShortcutLines as line (line.label)}
      <li>{line.text}</li>
    {/each}
  </ul>
  <ShortcutUnsetNotice snapshot={shortcuts?.snapshot ?? null} />
  {#if showShortcutChange}
    <button class="link-button shortcut-change" type="button" onclick={changeShortcuts}>
      {t('shortcutChange')}
    </button>
  {/if}
  {#if shortcutError}
    <p class="error" role="alert">{t('errorAction')}</p>
  {/if}

  <button class="button secondary block" type="button" onclick={openTyped}>
    {t('openTyped')}
  </button>

  {#if allSitesPromoPlacement === 'bottom'}
    {@render allSitesHint()}
  {/if}

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

  .hint-text {
    font-size: 12px;
    line-height: 1.5;
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

  .gate .link-button,
  .all-sites .link-button {
    font-size: 12px;
  }

  .all-sites .link-button {
    justify-self: start;
  }

  .gate-actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
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
