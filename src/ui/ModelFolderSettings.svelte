<script lang="ts">
  import { onMount } from 'svelte';
  import { browser } from 'wxt/browser';
  import {
    DEFAULT_MODEL_ID,
    HIGH_QUALITY_MODEL_ID,
    SELECTABLE_MODEL_IDS,
    getModel,
    type ModelId,
  } from '@/engine/model/catalog';
  import { FOLDER_PERMISSION_ERROR } from '@/engine/model/folder-permission';
  import { emptySharedFolderStatus, type SharedFolderStatus } from '@/engine/model/folder-status';
  import {
    SHARED_FOLDER_CHANGED_EVENT,
    shouldHighlightFolderPicker,
  } from '@/engine/model/folder-offer';
  import {
    adoptPickedSharedFolder,
    clearStoredSharedFolder,
    sharedFolderPickerAvailable,
  } from '@/engine/model/shared-folder';
  import FolderPermissionRestore from '@/ui/FolderPermissionRestore.svelte';
  import { t } from '@/shared/i18n';
  import { formatByteSizeList } from '@/ui/format';
  import SharedFolderBenefits from '@/ui/SharedFolderBenefits.svelte';
  import {
    isModelProgressMessage,
    requestEngineStatus,
    requestEngineWarm,
    requestModelFolderDeleteOpfs,
    requestModelFolderReload,
  } from '@/shared/messages';

  let folder = $state<SharedFolderStatus>(emptySharedFolderStatus(sharedFolderPickerAvailable()));
  let busy = $state(false);
  let pickError = $state<string | null>(null);
  let pickHint = $state<string | null>(null);
  let pickerAvailable = $derived(sharedFolderPickerAvailable());
  let highlightPick = $derived(shouldHighlightFolderPicker(location.href));
  const folderSizeLabel = formatByteSizeList([
    getModel(DEFAULT_MODEL_ID).size,
    getModel(HIGH_QUALITY_MODEL_ID).size,
  ]);

  function modelLabel(id: ModelId): string {
    return id === HIGH_QUALITY_MODEL_ID ? t('modelHigh') : t('modelStandard');
  }

  async function refreshFromEngine() {
    const engine = await requestEngineStatus();
    if (engine?.sharedFolder) folder = engine.sharedFolder;
  }

  async function reloadHost(): Promise<SharedFolderStatus | null> {
    const next = await requestModelFolderReload();
    if (next) folder = next;
    else await refreshFromEngine();
    return next;
  }

  async function chooseFolder() {
    pickError = null;
    pickHint = null;
    busy = true;
    try {
      const picked = await adoptPickedSharedFolder();
      if (picked.status === 'cancelled') {
        pickHint = t('modelFolderPickerHint');
        return;
      }
      if (picked.status === 'denied') {
        pickError = t('modelFolderPermissionNeeded');
        return;
      }
      if (picked.status === 'failed') {
        pickError = t('modelFolderPickFailed');
        return;
      }
      await reloadHost();
      await requestEngineWarm();
    } finally {
      busy = false;
    }
  }

  async function stopUsing() {
    pickError = null;
    pickHint = null;
    busy = true;
    try {
      await clearStoredSharedFolder();
      await reloadHost();
    } finally {
      busy = false;
    }
  }

  async function deleteOpfsCopy(id: ModelId) {
    busy = true;
    try {
      const next = await requestModelFolderDeleteOpfs(id);
      if (next) folder = next;
      else await refreshFromEngine();
    } finally {
      busy = false;
    }
  }

  onMount(() => {
    const onChanged = () => {
      void refreshFromEngine();
    };
    const onMessage = (message: unknown) => {
      if (!isModelProgressMessage(message)) return;
      if (
        message.status.error === FOLDER_PERMISSION_ERROR ||
        message.status.state === 'ready' ||
        message.status.state === 'loaded'
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

{#if pickerAvailable || folder.configured}
  <div class="folder" id="model-folder">
    <h3>{t('modelFolderHeading')}</h3>
    <p class="muted help">{t('modelFolderPickerHint')}</p>
    <p class="muted help">{t('modelFolderHelp')}</p>
    <p class="muted help">{t('modelFolderPersistentHint')}</p>
    <SharedFolderBenefits leadKey="modelFolderBenefitsLead" sizeLabel={folderSizeLabel} />

    {#if folder.configured && folder.name}
      <p class="muted" role="status">{t('modelFolderUsing', [folder.name])}</p>
    {:else}
      <p class="muted">{t('modelFolderNotUsing')}</p>
    {/if}

    <FolderPermissionRestore {folder} modelId={DEFAULT_MODEL_ID} onRestored={refreshFromEngine} />

    {#each folder.integrityIssues as issue (issue.modelId)}
      <p class="error" role="alert">
        {t('modelFolderIntegrityFailed', [issue.file])}
      </p>
    {/each}

    <div class="actions">
      {#if pickerAvailable}
        <button class="button" type="button" disabled={busy} onclick={() => void chooseFolder()}>
          {t('modelFolderChoose')}
        </button>
      {/if}
      <button
        class="button secondary"
        type="button"
        disabled={busy || !folder.configured}
        onclick={() => void stopUsing()}
      >
        {t('modelFolderStop')}
      </button>
    </div>

    {#if pickHint}
      <p class="muted help" data-folder-picker-hint role="status">{pickHint}</p>
    {/if}
    {#if pickError}
      <p class="error" role="alert">{pickError}</p>
    {/if}

    {#each SELECTABLE_MODEL_IDS as id (id)}
      {#if folder.opfsCopies.includes(id)}
        <p class="muted">{t('modelFolderOpfsCopy', [modelLabel(id)])}</p>
        <button
          class="button secondary"
          type="button"
          disabled={busy}
          onclick={() => void deleteOpfsCopy(id)}
        >
          {t('modelFolderDeleteOpfs')}
        </button>
      {/if}
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

  h3 {
    margin: 0;
    font-size: 12px;
    font-weight: 700;
  }

  .help {
    margin: 0;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
  }
</style>
