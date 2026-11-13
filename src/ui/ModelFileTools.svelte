<script lang="ts">
  import {
    DEFAULT_MODEL_ID,
    HIGH_QUALITY_MODEL_ID,
    SELECTABLE_MODEL_IDS,
    getModel,
    type ModelId,
  } from '@/engine/model/catalog';
  import {
    folderPermissionError,
    isAbortError,
    isEngineError,
    isFolderPermissionError,
  } from '@/engine/errors';
  import { OpfsModelFileStore, type ModelFileStore } from '@/engine/model/file-store';
  import {
    exportModelFile,
    importModelFile,
    isModelImportIntegrityError,
    modelInstallPath,
    type ModelTransferProgress,
  } from '@/engine/model/import-export';
  import {
    loadStoredSharedFolder,
    requestFolderPermission,
    sharedFolderSupported,
  } from '@/engine/model/shared-folder';
  import { SharedFolderModelFileStore } from '@/engine/model/shared-store';
  import { t } from '@/shared/i18n';
  import { requestEngineWarm, requestModelFolderReload } from '@/shared/messages';
  import { formatByteSize } from './format';

  interface Props {
    onImported?: (modelId: ModelId) => Promise<void> | void;
  }

  let { onImported }: Props = $props();

  const models: readonly ModelId[] = SELECTABLE_MODEL_IDS;
  let modelId = $state<ModelId>(DEFAULT_MODEL_ID);
  let fileInput = $state<HTMLInputElement | null>(null);
  let importing = $state(false);
  let exporting = $state(false);
  let phase = $state<ModelTransferProgress['phase']>('copy');
  let received = $state(0);
  let total = $state(getModel(DEFAULT_MODEL_ID).size);
  let error = $state<string | null>(null);
  let done = $state(false);
  let exported = $state(false);
  let controller: AbortController | null = null;

  let selectedFile = $derived(getModel(modelId).file);
  let ratio = $derived(total > 0 ? Math.min(1, received / total) : 0);

  function label(id: ModelId): string {
    return id === HIGH_QUALITY_MODEL_ID ? t('modelHigh') : t('modelStandard');
  }

  function chooseFile() {
    error = null;
    done = false;
    fileInput?.click();
  }

  async function importFile(file: File) {
    const entry = getModel(modelId);
    if (!file.name.toLowerCase().endsWith('.gguf')) {
      error = t('modelImportWrongFile', [entry.file]);
      return;
    }

    importing = true;
    done = false;
    exported = false;
    error = null;
    phase = 'copy';
    received = 0;
    total = entry.size;
    controller = new AbortController();

    try {
      const store = await OpfsModelFileStore.open();
      await importModelFile({
        file,
        modelId,
        store,
        signal: controller.signal,
        onProgress: (progress) => {
          phase = progress.phase;
          received = progress.received;
          total = progress.total;
        },
      });
      await requestModelFolderReload();
      await requestEngineWarm();
      done = true;
      await onImported?.(modelId);
    } catch (importError) {
      if (isAbortError(importError) || controller.signal.aborted) {
        // Cancelling an import leaves the previous installed model untouched.
      } else if (isModelImportIntegrityError(importError)) {
        error = t('modelImportWrongFile', [entry.file]);
      } else {
        error = t('modelImportFailed');
      }
    } finally {
      importing = false;
      controller = null;
    }
  }

  async function onFileChosen(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (file) await importFile(file);
  }

  function cancelImport() {
    controller?.abort();
  }

  async function storeForExport(): Promise<ModelFileStore> {
    const opfs = await OpfsModelFileStore.open();
    const stat = await opfs.stat(modelInstallPath(modelId));
    if (stat) return opfs;

    if (sharedFolderSupported()) {
      const stored = await loadStoredSharedFolder().catch(() => null);
      if (stored) {
        const permission = await requestFolderPermission(stored.handle);
        if (permission === 'granted') return SharedFolderModelFileStore.open(stored.handle);
        throw folderPermissionError();
      }
    }
    return opfs;
  }

  async function exportFile() {
    exporting = true;
    exported = false;
    error = null;
    try {
      const store = await storeForExport();
      await exportModelFile({ modelId, store });
      exported = true;
    } catch (exportError) {
      if (isFolderPermissionError(exportError)) {
        error = t('modelFolderPermissionNeeded');
      } else if (isEngineError(exportError) && exportError.code === 'model-missing') {
        error = t('modelExportMissing');
      } else {
        error = t('modelExportFailed');
      }
    } finally {
      exporting = false;
    }
  }
</script>

<div class="tools">
  <h3>{t('modelImportHeading')}</h3>
  <p class="muted">{t('modelImportHelp')}</p>
  <div class="row">
    <label class="field">
      <span>{t('modelImportModelLabel')}</span>
      <select bind:value={modelId} disabled={importing || exporting}>
        {#each models as id (id)}
          <option value={id}>{label(id)}</option>
        {/each}
      </select>
    </label>
    <p class="file-name">{selectedFile}</p>
  </div>

  <input bind:this={fileInput} class="hidden" type="file" accept=".gguf" onchange={onFileChosen} />

  <div class="row">
    <button class="button" type="button" disabled={importing || exporting} onclick={chooseFile}>
      {t('modelImportChoose')}
    </button>
    {#if importing}
      <button class="button secondary" type="button" onclick={cancelImport}>
        {t('downloadCancel')}
      </button>
    {:else}
      <button
        class="button secondary"
        type="button"
        disabled={exporting}
        onclick={() => void exportFile()}
      >
        {t('modelImportExport')}
      </button>
    {/if}
  </div>

  {#if importing}
    <div
      class="track"
      role="progressbar"
      aria-valuemin="0"
      aria-valuemax="100"
      aria-valuenow={Math.round(ratio * 100)}
      aria-label={t('modelImportHeading')}
    >
      <span style="width: {ratio * 100}%"></span>
    </div>
    <p class="muted" role="status">
      {phase === 'verify'
        ? t('modelVerifying')
        : `${formatByteSize(received)} / ${formatByteSize(total)}`}
    </p>
  {/if}

  {#if done}
    <p class="muted" role="status">{t('modelImportDone')}</p>
  {:else if exported}
    <p class="muted" role="status">{t('modelImportExportDone')}</p>
  {/if}
  {#if error}
    <p class="error" role="alert">{error}</p>
  {/if}
</div>

<style>
  .tools {
    display: grid;
    gap: var(--space-2);
    margin-top: var(--space-3);
    padding-top: var(--space-3);
    border-top: 1px solid var(--border);
  }

  h3 {
    margin: 0;
    font-size: 12px;
    font-weight: 700;
  }

  .row {
    display: flex;
    flex-wrap: wrap;
    align-items: end;
    gap: var(--space-2);
  }

  .field {
    display: grid;
    gap: var(--space-1);
  }

  .field span {
    font-size: 12px;
    color: var(--muted);
  }

  .file-name {
    margin: 0 0 6px;
    font-size: 12px;
    color: var(--muted);
    word-break: break-all;
  }

  .hidden {
    display: none;
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

  p {
    margin: 0;
  }
</style>
