<script lang="ts">
  import { t } from '@/shared/i18n';
  import type { Settings, SettingsPatch } from '@/shared/settings';
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
      <option value="fast">{t('paceFast')}</option>
      <option value="quality">{t('paceQuality')}</option>
    </select>
  </label>
  <p class="muted help">{t('paceHelp')}</p>
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
</style>
