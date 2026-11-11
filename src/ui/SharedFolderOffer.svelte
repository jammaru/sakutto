<script lang="ts">
  import { onMount } from 'svelte';
  import { DEFAULT_MODEL_ID, SELECTABLE_MODEL_IDS, getModel } from '@/engine/model/catalog';
  import {
    opfsHasOfficialModel,
    sharedFolderSettingsHref,
    shouldOfferSharedFolderMove,
    shouldPersistSharedFolderOfferImpression,
  } from '@/engine/model/folder-offer';
  import { sharedFolderPickerAvailable } from '@/engine/model/shared-folder';
  import type { EngineStatus, ModelStatus } from '@/shared/engine-status';
  import { formatByteSizeList } from '@/ui/format';
  import SharedFolderBenefits from '@/ui/SharedFolderBenefits.svelte';
  import { t } from '@/shared/i18n';
  import { requestModelInspect } from '@/shared/messages';
  import { saveSettings } from '@/shared/storage';
  import { browser } from 'wxt/browser';

  interface Props {
    engine: EngineStatus | null;
    dismissed: boolean;
    translating?: boolean;
  }

  let { engine, dismissed, translating = false }: Props = $props();

  let dismissedNow = $state(false);
  let shownThisVisit = $state(false);
  let persistStarted = false;
  let inspected = $state<ModelStatus[]>([]);
  let pickerAvailable = $derived(sharedFolderPickerAvailable());
  let folderConfigured = $derived(engine?.sharedFolder?.configured === true);
  let opfsReady = $derived(
    opfsHasOfficialModel([...(engine?.model ? [engine.model] : []), ...inspected]),
  );
  let visible = $derived(
    shouldOfferSharedFolderMove({
      pickerAvailable,
      folderConfigured,
      dismissed: dismissed || dismissedNow,
      translating,
      opfsHasOfficialModel: opfsReady,
      shownThisVisit,
      closedThisVisit: dismissedNow,
    }),
  );

  $effect(() => {
    if (
      !shouldPersistSharedFolderOfferImpression({
        pickerAvailable,
        folderConfigured,
        translating,
        opfsHasOfficialModel: opfsReady,
      })
    ) {
      return;
    }
    if ((dismissed || dismissedNow) && !shownThisVisit) return;
    shownThisVisit = true;
    if (persistStarted) return;
    persistStarted = true;
    void saveSettings({ sharedFolderOfferDismissed: true }).catch(() => {
      persistStarted = false;
    });
  });
  let sizeLabel = $derived.by(() => {
    const present: string[] = [];
    const sizes: number[] = [];
    for (const status of [...(engine?.model ? [engine.model] : []), ...inspected]) {
      if (!opfsHasOfficialModel([status]) || present.includes(status.id)) continue;
      present.push(status.id);
      sizes.push(getModel(status.id).size);
    }
    return formatByteSizeList(sizes.length > 0 ? sizes : [getModel(DEFAULT_MODEL_ID).size]);
  });

  async function refreshModels() {
    const statuses: ModelStatus[] = [];
    for (const id of SELECTABLE_MODEL_IDS) {
      const status = await requestModelInspect(id);
      if (status) statuses.push(status);
    }
    inspected = statuses;
  }

  async function openSettingsForPick() {
    await browser.tabs.create({
      url: sharedFolderSettingsHref((path) => browser.runtime.getURL(path)),
    });
  }

  async function later() {
    shownThisVisit = false;
    dismissedNow = true;
    await saveSettings({ sharedFolderOfferDismissed: true });
  }

  onMount(() => {
    void refreshModels();
  });
</script>

{#if visible}
  <section class="offer" aria-label={t('modelFolderHeading')}>
    <p class="muted">{t('modelFolderPickerHint')}</p>
    <SharedFolderBenefits leadKey="modelFolderOfferLead" {sizeLabel} compact />
    <p class="muted">{t('modelFolderPersistentHint')}</p>
    <div class="actions">
      <button class="button" type="button" onclick={() => void openSettingsForPick()}>
        {t('modelFolderOfferOpenSettings')}
      </button>
      <button class="button secondary" type="button" onclick={() => void later()}>
        {t('modelFolderOfferLater')}
      </button>
    </div>
  </section>
{/if}

<style>
  .offer {
    display: grid;
    gap: 6px;
    padding: 8px 10px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface);
    font-size: 12px;
  }

  .offer p {
    margin: 0;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
  }
</style>
