<script lang="ts">
  import { TRANSLATION_STYLES, isTranslationStyle, stylesForTarget } from '@/engine/prompt/style';
  import { t, type MessageKey } from '@/shared/i18n';
  import type { Formality, TranslationStyle } from '@/shared/settings';

  interface Props {
    targetLanguage: string;
    form: Formality;
    style: TranslationStyle;
    onChange: (patch: { form?: Formality; style?: TranslationStyle }) => void;
  }

  let { targetLanguage, form, style, onChange }: Props = $props();

  const styleLabels = {
    formal: 'styleFormal',
    polite: 'stylePolite',
    business: 'styleBusiness',
    neutral: 'styleNeutral',
    casual: 'styleCasual',
    friendly: 'styleFriendly',
    logical: 'styleLogical',
  } as const satisfies Record<TranslationStyle, MessageKey>;

  let offered = $derived(stylesForTarget(targetLanguage));
  let showForm = $derived(targetLanguage === 'ja');
  let showStyle = $derived(offered.length > 0);

  function updateForm(event: Event) {
    const select = event.currentTarget as HTMLSelectElement;
    onChange({ form: select.value === 'plain' ? 'plain' : 'polite' });
  }

  function updateStyle(event: Event) {
    const select = event.currentTarget as HTMLSelectElement;
    if (!isTranslationStyle(select.value)) return;
    onChange({ style: select.value });
  }
</script>

<div class="style-fields">
  {#if showForm}
    <label class="field">
      <span>{t('formalityLabel')}</span>
      <select value={form} onchange={updateForm}>
        <option value="polite">{t('formalityPolite')}</option>
        <option value="plain">{t('formalityPlain')}</option>
      </select>
    </label>
  {/if}

  {#if showStyle}
    <label class="field">
      <span>{t('styleLabel')}</span>
      <select value={style} onchange={updateStyle}>
        {#each TRANSLATION_STYLES as value (value)}
          <option {value}>{t(styleLabels[value])}</option>
        {/each}
      </select>
    </label>
    <p class="muted help">{t('styleHelp')}</p>
  {/if}
</div>

<style>
  .style-fields {
    display: contents;
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
