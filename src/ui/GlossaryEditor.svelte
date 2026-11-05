<script lang="ts">
  import type { GlossaryEntry } from '@/engine/types';
  import { parseGlossary, serializeGlossary } from '@/shared/glossary';
  import { t } from '@/shared/i18n';

  interface Props {
    entries: GlossaryEntry[];
    describedBy?: string;
    onChange: (entries: GlossaryEntry[]) => void;
  }

  let { entries, describedBy, onChange }: Props = $props();

  let text = $state('');
  let synced = $state('');

  $effect(() => {
    const next = serializeGlossary(entries);
    if (next !== synced) {
      text = next;
      synced = next;
    }
  });

  function commit() {
    const parsed = parseGlossary(text);
    synced = serializeGlossary(parsed);
    text = synced;
    onChange(parsed);
  }

  function importFile(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    void file.text().then((content) => {
      text = content;
      commit();
      input.value = '';
    });
  }

  function exportFile() {
    const blob = new Blob([serializeGlossary(parseGlossary(text))], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'sakutto-glossary.csv';
    link.click();
    URL.revokeObjectURL(url);
  }
</script>

<textarea
  rows="6"
  aria-label={t('glossaryHeading')}
  aria-describedby={describedBy}
  bind:value={text}
  onblur={commit}
  spellcheck="false"></textarea>
<div class="row-actions">
  <label class="link-button file">
    {t('glossaryImport')}
    <input type="file" accept=".csv,text/csv" onchange={importFile} />
  </label>
  <button class="link-button" type="button" onclick={exportFile}>{t('glossaryExport')}</button>
</div>

<style>
  textarea {
    width: 100%;
    min-height: 120px;
    padding: 8px 10px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface);
    color: var(--text);
    font: inherit;
    resize: vertical;
  }

  .row-actions {
    display: flex;
    gap: var(--space-3);
    margin-top: var(--space-2);
  }

  .file {
    position: relative;
    cursor: pointer;
  }

  .file:focus-within {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  .file input {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
  }
</style>
