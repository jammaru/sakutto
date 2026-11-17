<script lang="ts">
  import { t } from '@/shared/i18n';
  import type { ShortcutSnapshot } from '@/shared/messages';
  import { openShortcutEditor } from '@/shared/shortcut-editor';
  import { showShortcutUnsetNotice } from '@/shared/shortcuts';

  interface Props {
    snapshot: ShortcutSnapshot | null;
  }

  let { snapshot }: Props = $props();
  let openFailed = $state(false);
  let visible = $derived(showShortcutUnsetNotice(snapshot));

  async function openEditor(): Promise<void> {
    openFailed = !(await openShortcutEditor());
  }
</script>

{#if visible}
  <aside class="notice" data-sakutto="shortcut-unset-notice" role="status">
    <span>{t('shortcutUnsetNotice')}</span>
    <button type="button" data-sakutto="open-shortcut-settings" onclick={openEditor}>
      {t('shortcutOpenSettings')}
    </button>
    {#if openFailed}
      <span class="error" role="alert">{t('errorAction')}</span>
    {/if}
  </aside>
{/if}

<style>
  .notice {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
    color: var(--muted);
    font-size: 11px;
    line-height: 1.4;
  }

  button {
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--accent, #0e7490);
    font: inherit;
    text-decoration: underline;
    cursor: pointer;
  }

  button:focus-visible {
    outline: 2px solid var(--accent, #0e7490);
    outline-offset: 2px;
  }

  .error {
    color: var(--error, #b42318);
  }
</style>
