<script lang="ts">
  import { onMount } from 'svelte';
  import { browser } from 'wxt/browser';
  import {
    DEFAULT_MODEL_ID,
    HIGH_QUALITY_MODEL_ID,
    getModel,
    type ModelId,
  } from '@/engine/model/catalog';
  import { FOLDER_PERMISSION_ERROR } from '@/engine/model/folder-permission';
  import { emptySharedFolderStatus, type SharedFolderStatus } from '@/engine/model/folder-status';
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
  import { isFirefoxBuild } from '@/shared/browser';
  import { openOrFocusExtensionTab } from '@/shared/extension-tabs';
  import { t, type MessageKey } from '@/shared/i18n';
  import { loadSettings } from '@/shared/storage';
  import { formatByteSize, formatByteSizeList } from '@/ui/format';
  import {
    isModelProgressMessage,
    requestEngineStatus,
    requestEngineWarm,
    requestModelFolderAdopt,
    requestModelFolderReload,
    requestModelFolderToBrowser,
  } from '@/shared/messages';

  const firefox = isFirefoxBuild();
  const folderSizeLabel = formatByteSizeList([
    getModel(DEFAULT_MODEL_ID).size,
    getModel(HIGH_QUALITY_MODEL_ID).size,
  ]);
  const benefits = {
    leadKey: 'modelFolderBenefitsLead' as MessageKey,
    sizeLabel: folderSizeLabel,
  };
  const chromiumNotes: readonly MessageKey[] = ['modelFolderPersistentHint'];
  const firefoxNotes: readonly MessageKey[] = ['modelStorageFirefoxCopyHint'];

  let folder = $state<SharedFolderStatus>(emptySharedFolderStatus(sharedFolderSupported()));
  let selected = $state<ModelStorageChoiceValue>('browser');
  let busy = $state(false);
  let error = $state<string | null>(null);
  let notice = $state<string | null>(null);
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
  let highlightPick = $derived(shouldHighlightFolderPicker(location.href));

  function currentChoice(status: SharedFolderStatus): ModelStorageChoiceValue {
    return status.configured && status.permission === 'granted' ? 'folder' : 'browser';
  }

  function applyStatus(status: SharedFolderStatus): void {
    folder = status;
    selected = currentChoice(status);
  }

  function clearActionMessages(): void {
    error = null;
    notice = null;
    progress = null;
    copyProgress = null;
  }

  async function refreshFromEngine(): Promise<void> {
    const engine = await requestEngineStatus();
    if (!engine?.sharedFolder || busy) return;
    folder = engine.sharedFolder;
    selected = currentChoice(folder);
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
          notice = t('modelStorageMoveDone');
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
      const next = await requestModelFolderToBrowser();
      if (!next) throw new Error('The folder could not be copied.');
      applyStatus(next);
      selected = 'browser';
      notice = t('modelStorageCopyDone');
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

  async function chooseFirefoxFolder(): Promise<void> {
    const previous = selected;
    const files = await pickDirectoryFiles(copyInput);
    if (!files) {
      selected = previous;
      return;
    }

    selected = 'copy';
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
        selected = previous;
        error = result.failed.length > 0 ? t('modelStorageCopyFailed') : t('modelStorageNoModels');
        return;
      }
      await requestModelFolderReload();
      await requestEngineWarm();
      selected = 'browser';
      notice = t('modelStorageCopyDone');
      if (result.failed.length > 0) error = t('modelStorageSomeCopiesFailed');
      notifySharedFolderChanged();
    } catch (copyError) {
      selected = previous;
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
    if (pickerAvailable) await chooseChromiumFolder();
    else await chooseFirefoxFolder();
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
      }
    };
    window.addEventListener(SHARED_FOLDER_CHANGED_EVENT, onChanged);
    browser.runtime.onMessage.addListener(onMessage);
    void refreshFromEngine();
    if (highlightPick) {
      queueMicrotask(() => document.getElementById('model-folder')?.scrollIntoView());
    }
    return () => {
      window.removeEventListener(SHARED_FOLDER_CHANGED_EVENT, onChanged);
      browser.runtime.onMessage.removeListener(onMessage);
    };
  });
</script>

{#if pickerAvailable || firefox || folder.configured}
  <div class="folder" id="model-folder" aria-busy={busy}>
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
        disabled={busy}
        onChoose={(choice) => void chooseStorage(choice)}
      />
    {:else}
      <ModelStorageChoice
        choice={selected}
        mode="copy"
        legendKey="modelStorageLegend"
        folderKey="modelStorageCopyFolder"
        browserKey="modelStorageBrowser"
        recommended="copy"
        introKey="modelStorageIntro"
        notes={firefoxNotes}
        {benefits}
        disabled={busy}
        onChoose={(choice) => void chooseStorage(choice)}
      />
      <input
        bind:this={copyInput}
        class="hidden"
        type="file"
        accept=".gguf"
        webkitdirectory
        multiple
      />
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
      <p class="error" role="alert">{error}</p>
    {/if}
    {#if notice}
      <p class="muted" role="status">{notice}</p>
    {/if}

    <FolderPermissionRestore {folder} modelId={DEFAULT_MODEL_ID} onRestored={refreshFromEngine} />

    {#each folder.integrityIssues as issue (issue.modelId)}
      <p class="error" role="alert">
        {t('modelFolderIntegrityFailed', [issue.file])}
      </p>
    {/each}
  </div>
{/if}

<style>
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

  p {
    margin: 0;
  }
</style>
