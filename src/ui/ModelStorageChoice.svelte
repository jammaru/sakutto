<script lang="ts">
  import { t, type MessageKey } from '@/shared/i18n';
  import SharedFolderBenefits from './SharedFolderBenefits.svelte';

  export type ModelStorageMode = 'folder' | 'copy';
  export type ModelStorageChoiceValue = 'browser' | ModelStorageMode;

  interface Props {
    choice: ModelStorageChoiceValue;
    mode: ModelStorageMode;
    legendKey: MessageKey;
    folderKey: MessageKey;
    browserKey: MessageKey;
    recommended?: ModelStorageChoiceValue | null;
    introKey?: MessageKey | null;
    notes?: readonly MessageKey[];
    benefits?: { leadKey: MessageKey; sizeLabel: string } | null;
    disabled?: boolean;
    onChoose: (choice: ModelStorageChoiceValue) => void;
  }

  let {
    choice,
    mode,
    legendKey,
    folderKey,
    browserKey,
    recommended = null,
    introKey = null,
    notes = [],
    benefits = null,
    disabled = false,
    onChoose,
  }: Props = $props();
</script>

{#if introKey}
  <p class="muted storage-intro">{t(introKey)}</p>
{/if}

<fieldset class="store">
  <legend>{t(legendKey)}</legend>

  <div class="store-option">
    <label class="store-choice">
      <input
        type="radio"
        name="model-storage"
        value="browser"
        checked={choice === 'browser'}
        {disabled}
        onchange={() => onChoose('browser')}
      />
      <span>{t(browserKey)}</span>
    </label>
  </div>

  <div class="store-option" data-store-recommended={recommended === mode ? '' : undefined}>
    <div class="store-option-heading">
      <label class="store-choice">
        <input
          type="radio"
          name="model-storage"
          value={mode}
          checked={choice === mode}
          {disabled}
          onchange={() => onChoose(mode)}
        />
        <span>{t(folderKey)}</span>
      </label>
      {#if recommended === mode}
        <span class="recommended-badge">{t('storageOptionRecommended')}</span>
      {/if}
    </div>
    {#each notes as key (key)}
      <p class="muted start-note">{t(key)}</p>
    {/each}
  </div>

  {#if benefits}
    <SharedFolderBenefits leadKey={benefits.leadKey} sizeLabel={benefits.sizeLabel} />
  {/if}
</fieldset>

<style>
  .storage-intro {
    margin: 0 0 var(--space-2);
    font-size: 13px;
    line-height: 1.5;
  }

  .store {
    display: grid;
    gap: var(--space-2);
    margin: 0;
    padding: 0;
    border: 0;
  }

  .store legend {
    padding: 0;
    margin-bottom: var(--space-1);
    font-size: 13px;
    font-weight: 700;
  }

  .store-option {
    display: grid;
    gap: var(--space-1);
  }

  .store-option-heading {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1) var(--space-2);
    align-items: flex-start;
  }

  .recommended-badge {
    padding: 0 6px;
    border: 1px solid var(--border);
    border-radius: 999px;
    color: var(--muted);
    background: var(--surface-muted);
    font-size: 11px;
    font-weight: 600;
    line-height: 1.5;
  }

  .store-choice {
    display: flex;
    gap: var(--space-2);
    align-items: flex-start;
    font-size: 14px;
  }

  .start-note {
    margin: 0;
    margin-left: 1.6em;
    color: var(--muted);
    font-size: 13px;
    line-height: 1.5;
  }
</style>
