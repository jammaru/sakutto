<script lang="ts">
  import { hasBuiltInTranslatorUi } from '@/shared/browser';
  import { t } from '@/shared/i18n';
  import {
    CHROME_ONLY_LANGUAGES,
    SUPPORTED_LANGUAGES,
    displayLanguage,
    isChromeOnlyLanguage,
    isTargetLanguage,
    type TargetLanguage,
  } from '@/shared/languages';

  interface Props {
    value: string;
    uiLanguage: string;
    onChange: (language: TargetLanguage) => void;
  }

  let { value, uiLanguage, onChange }: Props = $props();

  const languages = hasBuiltInTranslatorUi()
    ? [...SUPPORTED_LANGUAGES, ...CHROME_ONLY_LANGUAGES]
    : [...SUPPORTED_LANGUAGES];

  function update(event: Event) {
    const select = event.currentTarget as HTMLSelectElement;
    if (!isTargetLanguage(select.value)) return;
    onChange(select.value);
  }
</script>

<label class="field">
  <span>{t('targetLanguageLabel')}</span>
  <select {value} onchange={update}>
    {#each languages as language (language)}
      <option value={language}>
        {displayLanguage(language, uiLanguage)}{isChromeOnlyLanguage(language)
          ? t('chromeOnlySuffix')
          : ''}
      </option>
    {/each}
  </select>
</label>

<style>
  .field {
    display: grid;
    gap: var(--space-1);
  }

  .field > span {
    color: var(--muted);
    font-size: 11px;
    font-weight: 600;
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
