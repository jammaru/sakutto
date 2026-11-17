<script lang="ts">
  import { browser } from 'wxt/browser';
  import type { ModelId } from '@/engine/model/catalog';
  import {
    folderRecordsModel,
    sharedFolderNeedsPermission,
    type SharedFolderStatus,
  } from '@/engine/model/folder-status';
  import { notifySharedFolderChanged } from '@/engine/model/folder-offer';
  import { queryStoredFolderPermission } from '@/engine/model/shared-folder';
  import { t } from '@/shared/i18n';
  import { requestEngineWarm, requestModelFolderReload } from '@/shared/messages';

  interface Props {
    folder: SharedFolderStatus | null | undefined;
    compact?: boolean;
    modelId?: ModelId | undefined;
    /** Load the model after a grant. Off during onboarding until the license click. */
    warm?: boolean;
    /** When false, only show the card after an activation attempt fails (popup toolbar open). */
    autoSettle?: boolean;
    /** Bound when autoSettle is false and a click-time grant did not succeed. */
    activationFailed?: boolean;
    onRestored?: () => Promise<void> | void;
  }

  let {
    folder,
    compact = false,
    modelId,
    warm = true,
    autoSettle = true,
    activationFailed = false,
    onRestored,
  }: Props = $props();

  let granting = $state(false);
  let grantError = $state(false);
  let probed = $state(false);
  /** Hide the card while the silent grant attempt from this gesture is still running. */
  let checkingPermission = $state(false);
  /** A query already says granted, even if the engine snapshot has not refreshed yet. */
  let silentGranted = $state(false);
  let visible = $derived(
    sharedFolderNeedsPermission(folder) &&
      (autoSettle
        ? probed && !silentGranted && !checkingPermission
        : activationFailed && !silentGranted && !checkingPermission),
  );
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
      // Only the folder-enable tab may call requestPermission so Chrome keeps the
      // persistent "Allow on every visit" grant.
      await browser.runtime.sendMessage({ type: 'folder:open-enable' });
    } catch {
      grantError = true;
    } finally {
      granting = false;
    }
  }

  async function settlePermission(): Promise<void> {
    const permission = await queryStoredFolderPermission().catch(() => null);
    if (permission !== 'granted') return;
    silentGranted = true;
    await afterGrant().catch(() => undefined);
  }

  $effect(() => {
    if (!sharedFolderNeedsPermission(folder)) {
      probed = false;
      silentGranted = false;
      checkingPermission = false;
      return;
    }
    if (!autoSettle) {
      probed = true;
      return;
    }
    if (probed) return;
    probed = true;
    checkingPermission = true;
    void settlePermission().finally(() => {
      checkingPermission = false;
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
