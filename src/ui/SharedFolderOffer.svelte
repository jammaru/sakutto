<script lang="ts">
  import { onMount } from 'svelte';
  import { DEFAULT_MODEL_ID, SELECTABLE_MODEL_IDS, getModel } from '@/engine/model/catalog';
  import {
    completeSharedFolderOffer,
    notifySharedFolderChanged,
    opfsHasOfficialModel,
    readSharedFolderOfferLater,
    shouldOfferSharedFolderMove,
    writeSharedFolderOfferLater,
  } from '@/engine/model/folder-offer';
  import {
    adoptPickedSharedFolder,
    sharedFolderPickerAvailable,
  } from '@/engine/model/shared-folder';
  import type { EngineStatus, ModelStatus } from '@/shared/engine-status';
  import { formatByteSize, formatByteSizeList } from '@/ui/format';
  import SharedFolderBenefits from '@/ui/SharedFolderBenefits.svelte';
  import { t } from '@/shared/i18n';
  import {
    isModelProgressMessage,
    requestEngineStatus,
    requestModelFolderReload,
    requestModelInspect,
  } from '@/shared/messages';
  import { saveSettings } from '@/shared/storage';
  import { browser } from 'wxt/browser';

  interface Props {
    engine: EngineStatus | null;
    dismissed: boolean;
  }

  let { engine, dismissed }: Props = $props();

  let laterHidden = $state(false);
  let dismissedNow = $state(false);
  let folderTaken = $state(false);
  let inspected = $state<ModelStatus[]>([]);
  let moving = $state(false);
  let progress = $state<ModelStatus | null>(null);
  let pickError = $state<string | null>(null);
  let pickerAvailable = $derived(sharedFolderPickerAvailable());
  let folderConfigured = $derived(folderTaken || engine?.sharedFolder?.configured === true);
  let opfsReady = $derived(
    opfsHasOfficialModel([
      ...(engine?.model ? [engine.model] : []),
      ...inspected,
      ...(progress ? [progress] : []),
    ]),
  );
  let visible = $derived(
    shouldOfferSharedFolderMove({
      pickerAvailable,
      folderConfigured,
      dismissed: dismissed || dismissedNow,
      laterHidden,
      opfsHasOfficialModel: opfsReady,
    }),
  );
  let sizeLabel = $derived.by(() => {
    const present: string[] = [];
    const sizes: number[] = [];
    for (const status of [
      ...(engine?.model ? [engine.model] : []),
      ...inspected,
      ...(progress ? [progress] : []),
    ]) {
      if (!opfsHasOfficialModel([status]) || present.includes(status.id)) continue;
      present.push(status.id);
      sizes.push(getModel(status.id).size);
    }
    return formatByteSizeList(sizes.length > 0 ? sizes : [getModel(DEFAULT_MODEL_ID).size]);
  });
  let movingLabel = $derived.by(() => {
    if (!progress) return t('runtimeLoading');
    if (progress.state === 'verifying') return t('runtimeVerifying');
    if (progress.state === 'downloading' || progress.state === 'loading') {
      const percent = String(Math.max(0, Math.min(100, Math.round(progress.progress * 100))));
      return t('modelFolderOfferMoving', [
        percent,
        formatByteSize(progress.received),
        formatByteSize(progress.total),
      ]);
    }
    return t('runtimeLoading');
  });

  async function refreshModels() {
    const statuses: ModelStatus[] = [];
    for (const id of SELECTABLE_MODEL_IDS) {
      const status = await requestModelInspect(id);
      if (status) statuses.push(status);
    }
    inspected = statuses;
  }

  async function moveToFolder() {
    pickError = null;
    moving = true;
    progress = null;
    try {
      const result = await completeSharedFolderOffer({
        pick: adoptPickedSharedFolder,
        reload: requestModelFolderReload,
      });
      if (result === 'cancelled') return;
      if (result === 'denied') {
        pickError = t('modelFolderPermissionNeeded');
        return;
      }
      if (result === 'failed') {
        pickError = t('modelFolderPickFailed');
        return;
      }
      folderTaken = true;
      const next = await requestEngineStatus();
      if (next) inspected = [next.model];
      notifySharedFolderChanged();
    } finally {
      moving = false;
    }
  }

  async function later() {
    laterHidden = true;
    await writeSharedFolderOfferLater().catch(() => undefined);
  }

  async function hideForever() {
    await saveSettings({ sharedFolderOfferDismissed: true });
    dismissedNow = true;
  }

  onMount(() => {
    const onMessage = (message: unknown) => {
      if (!isModelProgressMessage(message)) return;
      progress = message.status;
    };
    browser.runtime.onMessage.addListener(onMessage);
    void readSharedFolderOfferLater()
      .then((hidden) => {
        laterHidden = hidden;
      })
      .catch(() => undefined);
    void refreshModels();
    return () => browser.runtime.onMessage.removeListener(onMessage);
  });
</script>

{#if visible}
  <section class="offer" aria-label={t('modelFolderHeading')}>
    <SharedFolderBenefits leadKey="modelFolderOfferLead" {sizeLabel} />
    {#if moving}
      <p class="muted" role="status">{movingLabel}</p>
      {#if progress && progress.total > 0}
        <div
          class="track"
          role="progressbar"
          aria-valuemin="0"
          aria-valuemax={progress.total}
          aria-valuenow={progress.received}
          aria-label={movingLabel}
        >
          <span style="width: {Math.max(0, Math.min(100, progress.progress * 100))}%"></span>
        </div>
      {/if}
    {:else}
      <div class="actions">
        <button class="button" type="button" onclick={() => void moveToFolder()}>
          {t('modelFolderOfferMove')}
        </button>
        <button class="button secondary" type="button" onclick={() => void later()}>
          {t('modelFolderOfferLater')}
        </button>
        <button class="button secondary" type="button" onclick={() => void hideForever()}>
          {t('modelFolderOfferHide')}
        </button>
      </div>
    {/if}
    {#if pickError}
      <p class="error" role="alert">{pickError}</p>
    {/if}
  </section>
{/if}

<style>
  .offer {
    display: grid;
    gap: var(--space-2);
    padding: var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface);
  }

  .offer p {
    margin: 0;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
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
</style>
