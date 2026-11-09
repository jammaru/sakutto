<script lang="ts">
  import { t } from '@/shared/i18n';
  import {
    displayLanguage,
    isTargetLanguage,
    SUPPORTED_LANGUAGES,
    type TargetLanguage,
  } from '@/shared/languages';
  import {
    COMPOSE_PLACEMENTS,
    isComposePlacement,
    type Settings,
    type SettingsPatch,
  } from '@/shared/settings';
  import LanguageField from './LanguageField.svelte';

  interface Props {
    settings: Settings;
    uiLanguage: string;
    onChange: (patch: SettingsPatch) => void;
  }

  let { settings, uiLanguage, onChange }: Props = $props();

  function updateForm(event: Event) {
    const select = event.currentTarget as HTMLSelectElement;
    onChange({ form: select.value === 'plain' ? 'plain' : 'polite' });
  }

  function updateDisplay(event: Event) {
    const select = event.currentTarget as HTMLSelectElement;
    onChange({ display: select.value === 'bilingual' ? 'bilingual' : 'replace' });
  }

  function updatePace(event: Event) {
    const select = event.currentTarget as HTMLSelectElement;
    onChange({ pace: select.value === 'quality' ? 'quality' : 'fast' });
  }

  function updateComposeTarget(event: Event) {
    const select = event.currentTarget as HTMLSelectElement;
    if (select.value.length === 0) {
      onChange({ composeTargetLanguage: null });
      return;
    }
    if (!isTargetLanguage(select.value)) return;
    onChange({ composeTargetLanguage: select.value as TargetLanguage });
  }

  function updateComposePlacement(event: Event) {
    const select = event.currentTarget as HTMLSelectElement;
    if (!isComposePlacement(select.value)) return;
    onChange({ composePlacement: select.value });
  }

  const placementLabels = {
    above: 'composePlacementAbove',
    below: 'composePlacementBelow',
    corner: 'composePlacementCorner',
    free: 'composePlacementFree',
  } as const;
</script>

<div class="fields">
  <LanguageField
    value={settings.targetLanguage}
    {uiLanguage}
    onChange={(targetLanguage) => onChange({ targetLanguage })}
  />

  {#if settings.targetLanguage === 'ja'}
    <label class="field">
      <span>{t('formalityLabel')}</span>
      <select value={settings.form} onchange={updateForm}>
        <option value="polite">{t('formalityPolite')}</option>
        <option value="plain">{t('formalityPlain')}</option>
      </select>
    </label>
  {/if}

  <label class="field">
    <span>{t('displayLabel')}</span>
    <select value={settings.display} onchange={updateDisplay}>
      <option value="replace">{t('displayReplace')}</option>
      <option value="bilingual">{t('displayBilingual')}</option>
    </select>
  </label>

  <label class="field">
    <span>{t('paceLabel')}</span>
    <select value={settings.pace} onchange={updatePace}>
      <option value="quality">{t('paceQuality')}</option>
      <option value="fast">{t('paceFast')}</option>
    </select>
  </label>
  <p class="muted help">{t('paceHelp')}</p>

  <label class="check">
    <input
      type="checkbox"
      checked={settings.composeIcon}
      onchange={(event) => {
        const input = event.currentTarget as HTMLInputElement;
        onChange({ composeIcon: input.checked });
      }}
    />
    <span>{t('composeIconSetting')}</span>
  </label>
  <p class="muted help">{t('composeIconSettingHelp')}</p>

  <label class="field">
    <span>{t('composeTargetSetting')}</span>
    <select value={settings.composeTargetLanguage ?? ''} onchange={updateComposeTarget}>
      <option value="">{t('composeTargetAuto')}</option>
      {#each SUPPORTED_LANGUAGES as language (language)}
        <option value={language}>{displayLanguage(language, uiLanguage)}</option>
      {/each}
    </select>
  </label>
  <p class="muted help">{t('composeTargetSettingHelp')}</p>

  <label class="check">
    <input
      type="checkbox"
      checked={settings.composeInstantReplace}
      onchange={(event) => {
        const input = event.currentTarget as HTMLInputElement;
        onChange({ composeInstantReplace: input.checked });
      }}
    />
    <span>{t('composeInstantSetting')}</span>
  </label>
  <p class="muted help">{t('composeInstantSettingHelp')}</p>

  <label class="field">
    <span>{t('composePlacementSetting')}</span>
    <select value={settings.composePlacement} onchange={updateComposePlacement}>
      {#each COMPOSE_PLACEMENTS as placement (placement)}
        <option value={placement}>{t(placementLabels[placement])}</option>
      {/each}
    </select>
  </label>
  <p class="muted help">{t('composePlacementSettingHelp')}</p>
</div>

<style>
  .fields {
    display: grid;
    gap: var(--space-3);
  }

  .field {
    display: grid;
    gap: var(--space-1);
  }

  .field > span,
  .help {
    color: var(--muted);
    font-size: 11px;
    font-weight: 600;
  }

  .help {
    font-weight: 400;
    line-height: 1.5;
  }

  select {
    width: 100%;
    padding: 7px 9px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface);
    color: var(--text);
  }

  .check {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    color: var(--text);
    font-size: 13px;
  }
</style>
