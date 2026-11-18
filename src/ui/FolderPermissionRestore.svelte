<script lang="ts">
  import { onMount } from 'svelte';
  import { browser } from 'wxt/browser';
  import type { ModelId } from '@/engine/model/catalog';
  import {
    folderRecordsModel,
    sharedFolderNeedsPermission,
    type SharedFolderStatus,
  } from '@/engine/model/folder-status';
  import {
    SHARED_FOLDER_CHANGED_EVENT,
    notifySharedFolderChanged,
  } from '@/engine/model/folder-offer';
  import {
    queryStoredFolderPermission,
    probeStoredFolderReadable,
  } from '@/engine/model/shared-folder';
  import { isBraveBrowser } from '@/shared/browser';
  import { isFolderStorageRefreshedMessage } from '@/shared/folder-grant-messages';
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

  const braveBrowser = isBraveBrowser();

  let granting = $state(false);
  let grantError = $state(false);
  let probed = $state(false);
  /** Hide the card while the silent grant attempt from this gesture is still running. */
  let checkingPermission = $state(false);
  /** A query already says granted, even if the engine snapshot has not refreshed yet. */
  let silentGranted = $state(false);
  let settling = $state(false);
  let visible = $derived(
    sharedFolderNeedsPermission(folder) &&
      (autoSettle
        ? probed && !silentGranted && !checkingPermission
        : activationFailed && !silentGranted && !checkingPermission),
  );
  let presentHint = $derived(folderRecordsModel(folder, modelId));

  async function afterGrant(): Promise<void> {
    await requestModelFolderReload();
    if (warm) await requestEngineWarm();
    await onRestored?.();
    notifySharedFolderChanged();
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
    if (settling) return;
    settling = true;
    try {
      const permission = await queryStoredFolderPermission().catch(() => null);
      if (permission === 'granted') {
        silentGranted = true;
        await afterGrant().catch(() => undefined);
        return;
      }
      const readable = await probeStoredFolderReadable().catch(() => false);
      if (readable) {
        silentGranted = true;
        await afterGrant().catch(() => undefined);
      }
    } finally {
      settling = false;
    }
  }

  function requestSettle(): void {
    if (!sharedFolderNeedsPermission(folder) || !autoSettle || settling) return;
    checkingPermission = true;
    void settlePermission().finally(() => {
      checkingPermission = false;
    });
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
    requestSettle();
  });

  onMount(() => {
    const onFolderEvent = (): void => {
      if (!sharedFolderNeedsPermission(folder)) return;
      silentGranted = false;
      requestSettle();
    };
    const onSharedFolderChanged = (): void => {
      void onRestored?.();
    };
    const onFocus = (): void => {
      requestSettle();
    };
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') requestSettle();
    };
    const onMessage = (message: unknown): void => {
      if (isFolderStorageRefreshedMessage(message)) onFolderEvent();
    };
    window.addEventListener(SHARED_FOLDER_CHANGED_EVENT, onSharedFolderChanged);
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);
    browser.runtime.onMessage.addListener(onMessage);
    return () => {
      window.removeEventListener(SHARED_FOLDER_CHANGED_EVENT, onSharedFolderChanged);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
      browser.runtime.onMessage.removeListener(onMessage);
    };
  });
</script>

{#if visible}
  <div class="restore" class:compact role="alert">
    <p class:muted={compact}>{t('modelFolderPermissionNeeded')}</p>
    {#if presentHint}
      <p class:muted={compact}>{t('modelFolderPermissionPresent')}</p>
    {/if}
    {#if braveBrowser}
      <p class:muted={compact}>{t('modelFolderBravePermissionHint')}</p>
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
