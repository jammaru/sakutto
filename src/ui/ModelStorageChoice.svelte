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

  <div
    class="store-option"
    class:recommended={recommended === mode}
    data-store-recommended={recommended === mode ? '' : undefined}
  >
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
    {#each notes as key (key)}
      <p class="muted start-note">{t(key)}</p>
    {/each}
  </div>

  <div
    class="store-option"
    class:recommended={recommended === 'browser'}
    data-store-recommended={recommended === 'browser' ? '' : undefined}
  >
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

  .store-option.recommended {
    padding: var(--space-2);
    border: 1px solid color-mix(in srgb, var(--accent) 45%, var(--border));
    border-radius: 8px;
    background: color-mix(in srgb, var(--accent) 6%, var(--surface));
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
