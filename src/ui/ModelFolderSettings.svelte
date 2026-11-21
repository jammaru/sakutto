<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { browser } from 'wxt/browser';
  import {
    DEFAULT_MODEL_ID,
    HIGH_QUALITY_MODEL_ID,
    SELECTABLE_MODEL_IDS,
    getModel,
    type ModelId,
  } from '@/engine/model/catalog';
  import { FOLDER_PERMISSION_ERROR } from '@/engine/model/folder-permission';
  import {
    emptySharedFolderStatus,
    sharedFolderStorageChoice,
    type SharedFolderStatus,
  } from '@/engine/model/folder-status';
  import {
    SHARED_FOLDER_CHANGED_EVENT,
    notifySharedFolderChanged,
    shouldHighlightFolderPicker,
  } from '@/engine/model/folder-offer';
  import {
    copySharedFolderFilesToOpfs,
    type FolderCopyProgress,
  } from '@/engine/model/folder-import';
  import { OpfsModelFileStore } from '@/engine/model/file-store';
  import {
    adoptPickedSharedFolder,
    sharedFolderPickerAvailable,
    sharedFolderSupported,
  } from '@/engine/model/shared-folder';
  import { isAbortError } from '@/engine/errors';
  import FolderPermissionRestore from '@/ui/FolderPermissionRestore.svelte';
  import ModelStorageChoice, { type ModelStorageChoiceValue } from '@/ui/ModelStorageChoice.svelte';
  import { pickDirectoryFiles } from '@/ui/folder-input';
  import { hasLicenseConsent } from '@/shared/agreement';
  import { isBraveBrowser, isFirefoxBuild } from '@/shared/browser';
  import { openOrFocusExtensionTab } from '@/shared/extension-tabs';
  import { modelCanTranslate } from '@/shared/engine-status';
  import { integrityMessageKey, t, type MessageKey } from '@/shared/i18n';
  import { loadSettings } from '@/shared/storage';
  import { formatByteSize, formatByteSizeList } from '@/ui/format';
  import {
    isModelProgressMessage,
    requestEngineStatus,
    requestEngineWarm,
    requestModelFolderAdopt,
    requestModelFolderReload,
    requestModelFolderToBrowser,
    requestModelInspect,
  } from '@/shared/messages';

  const firefoxBuild = isFirefoxBuild();
  const braveBrowser = isBraveBrowser();
  const folderSizeLabel = formatByteSizeList([
    getModel(DEFAULT_MODEL_ID).size,
    getModel(HIGH_QUALITY_MODEL_ID).size,
  ]);
  const benefits = {
    leadKey: 'modelFolderBenefitsLead' as MessageKey,
    sizeLabel: folderSizeLabel,
  };
  const chromiumNotes: readonly MessageKey[] = ['modelFolderPersistentHint'];

  let folder = $state<SharedFolderStatus>(emptySharedFolderStatus(sharedFolderSupported()));
  let catalogReady = $state(false);
  let selected = $state<ModelStorageChoiceValue>('browser');
  let busy = $state(false);
  let readingFolder = $state(false);
  let error = $state<string | null>(null);
  let notice = $state<string | null>(null);
  let noticeKind = $state<'success' | 'info' | null>(null);
  let noticeElement = $state<HTMLElement | null>(null);
  let progress = $state<{
    modelId: ModelId;
    verifying: boolean;
    received: number;
    total: number;
  } | null>(null);
  let copyProgress = $state<FolderCopyProgress | null>(null);
  let copyInput = $state<HTMLInputElement | null>(null);
  let copyController = $state.raw<AbortController | null>(null);
  let pickerAvailable = $derived(sharedFolderPickerAvailable());
  let showBrowserOnly = $derived(!firefoxBuild && sharedFolderSupported() && !pickerAvailable);
  let highlightPick = $derived(shouldHighlightFolderPicker(location.href));
  let showFirefoxImport = $derived(firefoxBuild && !pickerAvailable && !catalogReady);
  let showFirefoxImportUi = $derived(
    showFirefoxImport || readingFolder || (busy && copyController !== null),
  );

  async function refreshCatalogReady(): Promise<void> {
    if (!firefoxBuild || pickerAvailable) return;
    const statuses = await Promise.all(
      SELECTABLE_MODEL_IDS.map((modelId) => requestModelInspect(modelId)),
    );
    catalogReady = SELECTABLE_MODEL_IDS.every((_, index) =>
      modelCanTranslate(statuses[index] ?? null),
    );
  }

  function applyStatus(status: SharedFolderStatus): void {
    folder = status;
    selected = sharedFolderStorageChoice(status);
  }

  function clearActionMessages(): void {
    error = null;
    notice = null;
    noticeKind = null;
    progress = null;
    copyProgress = null;
  }

  function showSuccess(message: string): void {
    notice = message;
    noticeKind = 'success';
    void tick().then(() => noticeElement?.scrollIntoView({ block: 'nearest' }));
  }

  function showInfo(message: string): void {
    notice = message;
    noticeKind = 'info';
  }

  async function refreshFromEngine(): Promise<void> {
    const engine = await requestEngineStatus();
    if (!engine?.sharedFolder || busy) return;
    folder = engine.sharedFolder;
    selected = sharedFolderStorageChoice(folder);
  }

  async function chooseChromiumFolder(): Promise<void> {
    const previous = selected;
    selected = 'folder';
    clearActionMessages();
    busy = true;
    try {
      // Only the cheap license lookup may run before the picker. Reloading the engine or
      // querying the old folder first can spend the click's transient activation, so the
      // picker and its requestPermission run immediately for a licensed user.
      const settings = await loadSettings().catch(() => null);
      if (!hasLicenseConsent(settings)) {
        selected = previous;
        void openOrFocusExtensionTab('/onboarding.html');
        return;
      }
      const picked = await adoptPickedSharedFolder();
      if (picked.status === 'cancelled') {
        selected = previous;
        return;
      }
      if (picked.status === 'denied') {
        selected = previous;
        error = t('modelFolderPermissionNeeded');
        return;
      }
      if (picked.status === 'failed') {
        selected = previous;
        error = t('modelFolderPickFailed');
        return;
      }

      const next = await requestModelFolderAdopt();
      if (!next) throw new Error('The folder could not be prepared.');
      folder = next;
      if (next.configured && next.permission === 'granted') {
        selected = 'folder';
        if (next.opfsCopies.length > 0 || next.integrityIssues.length > 0) {
          error = t('modelStorageMoveFailed');
        } else {
          showSuccess(t('modelStorageMoveDone'));
        }
      } else {
        selected = previous;
        error = t('modelStorageMoveFailed');
      }
      await requestEngineWarm();
      notifySharedFolderChanged();
    } catch {
      selected = previous;
      error = t('modelStorageMoveFailed');
    } finally {
      busy = false;
      progress = null;
    }
  }

  async function chooseBrowser(): Promise<void> {
    if (!folder.configured) {
      selected = 'browser';
      return;
    }
    const previous = selected;
    selected = 'browser';
    clearActionMessages();
    busy = true;
    try {
      const result = await requestModelFolderToBrowser();
      if (!result) throw new Error('The folder could not be copied.');
      applyStatus(result.folder);
      selected = 'browser';
      if (result.copied.length > 0) {
        showSuccess(t('modelStorageCopyDone'));
      } else if (!result.folder.configured || result.folder.permission === 'granted') {
        // Nothing was in the folder. The handle is gone, so this is an empty-folder
        // outcome rather than a successful copy.
        showInfo(t('modelStorageNoModels'));
      }
      await requestEngineWarm();
      notifySharedFolderChanged();
    } catch {
      selected = previous;
      error = t('modelStorageCopyFailed');
    } finally {
      busy = false;
      progress = null;
    }
  }

  async function importFromSharedFolder(): Promise<void> {
    if (busy || readingFolder) return;
    readingFolder = false;
    let files: File[] | null;
    try {
      files = await pickDirectoryFiles(copyInput, window, {
        onAwaitingFiles: () => {
          readingFolder = true;
        },
      });
    } finally {
      readingFolder = false;
    }
    if (!files) return;

    clearActionMessages();
    busy = true;
    copyController = new AbortController();
    try {
      const store = await OpfsModelFileStore.open();
      const result = await copySharedFolderFilesToOpfs({
        files,
        store,
        signal: copyController.signal,
        onProgress: (item) => {
          copyProgress = item;
        },
      });
      if (result.imported.length === 0) {
        if (result.failed.length > 0) {
          error = t('modelStorageCopyFailed');
        } else {
          showInfo(t('modelStorageNoModels'));
        }
        return;
      }
      await requestModelFolderReload();
      await requestEngineWarm();
      showSuccess(t('modelStorageCopyDone'));
      if (result.failed.length > 0) error = t('modelStorageSomeCopiesFailed');
      notifySharedFolderChanged();
      await refreshCatalogReady();
    } catch (copyError) {
      if (!isAbortError(copyError) && !copyController.signal.aborted) {
        error = t('modelStorageCopyFailed');
      }
    } finally {
      busy = false;
      copyController = null;
      copyProgress = null;
      if (copyInput) copyInput.value = '';
    }
  }

  async function chooseStorage(next: ModelStorageChoiceValue): Promise<void> {
    if (busy || next === selected) return;
    if (next === 'browser') {
      await chooseBrowser();
      return;
    }
    await chooseChromiumFolder();
  }

  function cancelCopy(): void {
    copyController?.abort();
  }

  function progressLabel(): string {
    if (copyProgress) {
      const entry = getModel(copyProgress.modelId);
      const label =
        copyProgress.modelId === HIGH_QUALITY_MODEL_ID ? t('modelHigh') : t('modelStandard');
      return `${label}: ${formatByteSize(copyProgress.transfer.received)} / ${formatByteSize(entry.size)}`;
    }
    if (progress) {
      const entry = getModel(progress.modelId);
      const label =
        progress.modelId === HIGH_QUALITY_MODEL_ID ? t('modelHigh') : t('modelStandard');
      return `${label}: ${formatByteSize(progress.received)} / ${formatByteSize(progress.total || entry.size)}`;
    }
    return '';
  }

  function progressRatio(): number {
    const item = copyProgress?.transfer ?? progress;
    if (!item || item.total <= 0) return 0;
    return Math.min(1, item.received / item.total);
  }

  onMount(() => {
    const onChanged = () => {
      void refreshFromEngine();
    };
    const onMessage = (message: unknown) => {
      if (!isModelProgressMessage(message) || !busy) return;
      const status = message.status;
      if (status.state === 'downloading' || status.state === 'verifying') {
        progress = {
          modelId: status.id,
          verifying: status.state === 'verifying',
          received: status.received,
          total: status.total,
        };
      } else if (status.state === 'ready' || status.state === 'loaded') {
        progress = null;
      }
      if (
        status.error === FOLDER_PERMISSION_ERROR ||
        status.state === 'ready' ||
        status.state === 'loaded'
      ) {
        void refreshFromEngine();
        void refreshCatalogReady();
      }
    };
    const onFocus = (): void => {
      void refreshFromEngine();
    };
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') void refreshFromEngine();
    };
    window.addEventListener(SHARED_FOLDER_CHANGED_EVENT, onChanged);
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);
    browser.runtime.onMessage.addListener(onMessage);
    void refreshFromEngine();
    void refreshCatalogReady();
    if (highlightPick) {
      queueMicrotask(() => document.getElementById('model-folder')?.scrollIntoView());
    }
    return () => {
      window.removeEventListener(SHARED_FOLDER_CHANGED_EVENT, onChanged);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
      browser.runtime.onMessage.removeListener(onMessage);
    };
  });
</script>

{#if showBrowserOnly}
  <div class="folder" id="model-folder">
    <h3 class="storage-heading">{t('modelStorageLegend')}</h3>
    <p class="muted">{t('modelStorageBrowserOnlyHint')}</p>
    {#if braveBrowser}
      <p class="muted">{t('modelStorageBraveEnableFsaHint')}</p>
    {/if}
  </div>
{:else if pickerAvailable || (firefoxBuild && (showFirefoxImportUi || folder.configured))}
  <div class="folder" id="model-folder" aria-busy={busy || readingFolder}>
    {#if pickerAvailable}
      <ModelStorageChoice
        choice={selected}
        mode="folder"
        legendKey="modelStorageLegend"
        folderKey="modelStorageFolder"
        browserKey="modelStorageBrowser"
        recommended="folder"
        introKey="modelStorageIntro"
        notes={chromiumNotes}
        {benefits}
        disabled={busy || readingFolder}
        onChoose={(choice) => void chooseStorage(choice)}
      />
    {:else if showFirefoxImportUi}
      {#if showFirefoxImport}
        <p class="muted">{t('modelStorageFirefoxImportHint')}</p>
        <button
          class="button secondary"
          type="button"
          disabled={busy || readingFolder}
          onclick={() => void importFromSharedFolder()}
        >
          {t('modelStorageFirefoxImport')}
        </button>
      {/if}
      <input
        bind:this={copyInput}
        class="hidden"
        type="file"
        accept=".gguf"
        webkitdirectory
        multiple
      />
    {/if}

    {#if readingFolder && !busy}
      <div class="progress" role="status">
        <p class="muted">{t('modelFolderReading')}</p>
      </div>
    {/if}

    {#if busy}
      <div class="progress" role="status">
        {#if progress || copyProgress}
          <div
            class="track"
            role="progressbar"
            aria-valuemin="0"
            aria-valuemax="100"
            aria-valuenow={Math.round(progressRatio() * 100)}
            aria-label={t('modelStorageProgressLabel')}
          >
            <span style="width: {progressRatio() * 100}%"></span>
          </div>
          <p class="muted">
            {progress?.verifying || copyProgress?.transfer.phase === 'verify'
              ? t('modelVerifying')
              : progressLabel()}
          </p>
        {:else}
          <p class="muted">{t('modelStorageWorking')}</p>
        {/if}
        {#if copyController}
          <button class="button secondary" type="button" onclick={cancelCopy}>
            {t('downloadCancel')}
          </button>
        {/if}
      </div>
    {/if}

    {#if error}
      <div class="callout bad" role="alert">
        <span class="callout-icon" aria-hidden="true"></span>
        <p>{error}</p>
      </div>
    {/if}
    {#if notice}
      {#if noticeKind === 'success'}
        <div
          class="callout success"
          data-notice="success"
          role="status"
          aria-live="polite"
          bind:this={noticeElement}
        >
          <span class="callout-icon" aria-hidden="true"></span>
          <p>{notice}</p>
        </div>
      {:else}
        <p class="muted" role="status">{notice}</p>
      {/if}
    {/if}

    <FolderPermissionRestore {folder} modelId={DEFAULT_MODEL_ID} onRestored={refreshFromEngine} />

    {#each folder.integrityIssues as issue (issue.modelId)}
      <div class="callout bad" role="alert">
        <span class="callout-icon" aria-hidden="true"></span>
        <p>{t(integrityMessageKey(issue.kind), [issue.file])}</p>
      </div>
    {/each}
  </div>
{/if}

<style>
  .storage-heading {
    margin: 0;
    font-size: 13px;
  }

  .folder {
    display: grid;
    gap: var(--space-2);
    margin-top: var(--space-3);
    padding-top: var(--space-3);
    border-top: 1px solid var(--border);
  }

  .progress {
    display: grid;
    gap: var(--space-2);
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

  .hidden {
    display: none;
  }

  .callout {
    display: flex;
    align-items: flex-start;
    gap: var(--space-2);
    padding: var(--space-3);
    border: 1px solid color-mix(in srgb, var(--accent) 45%, var(--border));
    border-left-width: 4px;
    border-left-color: var(--accent);
    border-radius: var(--radius-md);
    background: color-mix(in srgb, var(--accent) 14%, var(--surface));
    color: var(--text);
    font-size: 14px;
    font-weight: 700;
    line-height: 1.45;
  }

  .callout.bad {
    border-color: color-mix(in srgb, var(--danger) 45%, var(--border));
    border-left-width: 4px;
    border-left-color: var(--danger);
    background: color-mix(in srgb, var(--danger) 12%, var(--surface));
  }

  .callout-icon {
    display: inline-flex;
    flex: 0 0 auto;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    margin-top: 1px;
    border-radius: 999px;
    background: var(--accent);
    color: var(--accent-contrast);
    font-size: 12px;
    font-weight: 800;
    line-height: 1;
  }

  .callout.bad .callout-icon {
    background: var(--danger);
    color: var(--surface);
  }

  .callout.success .callout-icon::before {
    content: '✓';
  }

  .callout.bad .callout-icon::before {
    content: '!';
  }

  p {
    margin: 0;
  }
</style>
