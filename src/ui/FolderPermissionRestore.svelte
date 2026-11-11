<script lang="ts">
  import {
    sharedFolderNeedsPermission,
    type SharedFolderStatus,
  } from '@/engine/model/folder-status';
  import { notifySharedFolderChanged } from '@/engine/model/folder-offer';
  import { restoreStoredFolderPermission } from '@/engine/model/shared-folder';
  import { t } from '@/shared/i18n';
  import { requestEngineWarm, requestModelFolderReload } from '@/shared/messages';

  interface Props {
    folder: SharedFolderStatus | null | undefined;
    compact?: boolean;
    onRestored?: () => Promise<void> | void;
  }

  let { folder, compact = false, onRestored }: Props = $props();

  let granting = $state(false);
  let grantError = $state(false);
  let visible = $derived(sharedFolderNeedsPermission(folder));

  async function grantAccess() {
    grantError = false;
    granting = true;
    try {
      const permission = await restoreStoredFolderPermission();
      if (permission !== 'granted') {
        grantError = true;
        return;
      }
      await requestModelFolderReload();
      notifySharedFolderChanged();
      await requestEngineWarm();
      await onRestored?.();
    } catch {
      grantError = true;
    } finally {
      granting = false;
    }
  }
</script>

{#if visible}
  <div class="restore" class:compact role="alert">
    <p class:muted={compact}>{t('modelFolderPermissionNeeded')}</p>
    <button class="button" type="button" disabled={granting} onclick={() => void grantAccess()}>
      {t('modelFolderPermissionGrant')}
    </button>
    {#if grantError}
      <p class="error" role="alert">{t('modelFolderPermissionNeeded')}</p>
    {/if}
  </div>
{/if}

<style>
  .restore {
    display: grid;
    gap: var(--space-2, 8px);
  }

  .restore.compact {
    padding: 8px 10px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface);
  }

  .restore p {
    margin: 0;
  }
</style>
