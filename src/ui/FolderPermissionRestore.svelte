<script lang="ts">
  import type { ModelId } from '@/engine/model/catalog';
  import {
    folderRecordsModel,
    sharedFolderNeedsPermission,
    type SharedFolderStatus,
  } from '@/engine/model/folder-status';
  import { notifySharedFolderChanged } from '@/engine/model/folder-offer';
  import {
    probeStoredFolderReadable,
    restoreStoredFolderPermission,
  } from '@/engine/model/shared-folder';
  import { t } from '@/shared/i18n';
  import { requestEngineWarm, requestModelFolderReload } from '@/shared/messages';

  interface Props {
    folder: SharedFolderStatus | null | undefined;
    compact?: boolean;
    modelId?: ModelId | undefined;
    /** Load the model after a grant. Off during onboarding until the license click. */
    warm?: boolean;
    onRestored?: () => Promise<void> | void;
  }

  let { folder, compact = false, modelId, warm = true, onRestored }: Props = $props();

  let granting = $state(false);
  let grantError = $state(false);
  let probed = $state(false);
  let visible = $derived(sharedFolderNeedsPermission(folder));
  let presentHint = $derived(folderRecordsModel(folder, modelId));

  async function afterGrant(): Promise<void> {
    await requestModelFolderReload();
    notifySharedFolderChanged();
    if (warm) await requestEngineWarm();
    await onRestored?.();
  }

  async function grantAccess() {
    grantError = false;
    granting = true;
    try {
      const permission = await restoreStoredFolderPermission();
      if (permission !== 'granted') {
        grantError = true;
        return;
      }
      await afterGrant();
    } catch {
      grantError = true;
    } finally {
      granting = false;
    }
  }

  $effect(() => {
    if (!visible) {
      probed = false;
      return;
    }
    if (probed) return;
    probed = true;
    void probeStoredFolderReadable().then(async (readable) => {
      if (!readable) return;
      await afterGrant();
    });
  });
</script>

{#if visible}
  <div class="restore" class:compact role="alert">
    <p class:muted={compact}>{t('modelFolderPermissionNeeded')}</p>
    {#if presentHint}
      <p class:muted={compact}>{t('modelFolderPermissionPresent')}</p>
    {/if}
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
