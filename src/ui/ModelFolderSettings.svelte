<script lang="ts">
  import { onMount } from 'svelte';
  import {
    DEFAULT_MODEL_ID,
    HIGH_QUALITY_MODEL_ID,
    SELECTABLE_MODEL_IDS,
    getModel,
    type ModelId,
  } from '@/engine/model/catalog';
  import { emptySharedFolderStatus, type SharedFolderStatus } from '@/engine/model/folder-status';
  import { SHARED_FOLDER_CHANGED_EVENT } from '@/engine/model/folder-offer';
  import {
    adoptPickedSharedFolder,
    clearStoredSharedFolder,
    loadStoredSharedFolder,
    requestFolderPermission,
    sharedFolderPickerAvailable,
    type FolderPermission,
  } from '@/engine/model/shared-folder';
  import { t } from '@/shared/i18n';
  import { formatByteSizeList } from '@/ui/format';
  import SharedFolderBenefits from '@/ui/SharedFolderBenefits.svelte';
  import {
    requestEngineStatus,
    requestModelFolderDeleteOpfs,
    requestModelFolderReload,
  } from '@/shared/messages';

  let folder = $state<SharedFolderStatus>(emptySharedFolderStatus(sharedFolderPickerAvailable()));
  let busy = $state(false);
  let pickError = $state<string | null>(null);
  let pickHint = $state<string | null>(null);
  let granting = $state(false);
  let pickerAvailable = $derived(sharedFolderPickerAvailable());
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
    } finally {
      busy = false;
    }
  }

  async function grantAccess() {
    pickError = null;
    pickHint = null;
    granting = true;
    try {
      const engine = await requestEngineStatus();
      const current = engine?.sharedFolder;
      if (!current?.configured) return;
      // Re-pick is the reliable way to restore permission after a restart when
      // `requestPermission` is not enough; the stored handle is tried first.
      const granted = await grantStoredHandle();
      if (!granted) {
        pickError = t('modelFolderPermissionNeeded');
        return;
      }
      await reloadHost();
    } finally {
      granting = false;
    }
  }

  async function grantStoredHandle(): Promise<boolean> {
    const stored = await loadStoredSharedFolder();
    if (!stored) return false;
    const permission: FolderPermission = await requestFolderPermission(stored.handle);
    return permission === 'granted';
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
    window.addEventListener(SHARED_FOLDER_CHANGED_EVENT, onChanged);
    void refreshFromEngine();
    return () => window.removeEventListener(SHARED_FOLDER_CHANGED_EVENT, onChanged);
  });
</script>

{#if pickerAvailable || folder.configured}
  <div class="folder">
    <h3>{t('modelFolderHeading')}</h3>
    <p class="muted help">{t('modelFolderPickerHint')}</p>
    <p class="muted help">{t('modelFolderHelp')}</p>
    <SharedFolderBenefits leadKey="modelFolderBenefitsLead" sizeLabel={folderSizeLabel} />

    {#if folder.configured && folder.name}
      <p class="muted" role="status">{t('modelFolderUsing', [folder.name])}</p>
    {:else}
      <p class="muted">{t('modelFolderNotUsing')}</p>
    {/if}

    {#if folder.configured && folder.permission !== 'granted'}
      <p class="error" role="alert">{t('modelFolderPermissionNeeded')}</p>
      <button
        class="button"
        type="button"
        disabled={granting || busy}
        onclick={() => void grantAccess()}
      >
        {t('modelFolderPermissionGrant')}
      </button>
    {/if}

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
