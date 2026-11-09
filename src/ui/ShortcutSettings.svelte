<script lang="ts">
  import { onMount } from 'svelte';
  import { t, type MessageKey } from '@/shared/i18n';
  import { requestShortcutSnapshot } from '@/shared/messages';
  import { openShortcutEditor } from '@/shared/shortcut-editor';
  import {
    SHORTCUT_COMMANDS,
    ariaShortcut,
    displayShortcut,
    type ShortcutCommand,
    type ShortcutSnapshot,
  } from '@/shared/shortcuts';

  const LABELS: Readonly<Record<ShortcutCommand, MessageKey>> = {
    'translate-page': 'commandTranslate',
    'toggle-bilingual': 'commandBilingual',
    'translate-selection': 'commandSelection',
  };

  let bound = $state<ShortcutSnapshot | null>(null);
  let openFailed = $state(false);

  function keyText(command: ShortcutCommand): string {
    const shortcut = bound?.[command];
    if (shortcut === null || shortcut === undefined || shortcut.length === 0) {
      return t('shortcutUnset');
    }
    return displayShortcut(shortcut);
  }

  function aria(command: ShortcutCommand): string | undefined {
    const shortcut = bound?.[command];
    if (shortcut === null || shortcut === undefined || shortcut.length === 0) return undefined;
    return ariaShortcut(shortcut) ?? undefined;
  }

  function refresh(): void {
    void requestShortcutSnapshot().then((snapshot) => {
      if (snapshot) bound = snapshot;
    });
  }

  /**
   * Chrome owns the key bindings, so the only honest control is a button that opens Chrome's
   * own editor. The rows are read again when the reader comes back from that tab.
   */
  async function openEditor(): Promise<void> {
    openFailed = !(await openShortcutEditor());
  }

  onMount(() => {
    refresh();
    const onFocus = (): void => refresh();
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  });
</script>

<dl class="bindings">
  {#each SHORTCUT_COMMANDS as command (command)}
    <div>
      <dt>{t(LABELS[command])}</dt>
      <dd>
        <kbd aria-keyshortcuts={aria(command)}>{keyText(command)}</kbd>
      </dd>
    </div>
  {/each}
</dl>
<button class="button secondary" type="button" onclick={openEditor}>{t('shortcutChange')}</button>
{#if openFailed}
  <p class="error" role="alert">{t('errorAction')}</p>
{/if}

<style>
  .bindings {
    display: grid;
    gap: var(--space-2);
    margin-bottom: var(--space-3);
  }

  .bindings div {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-3);
  }

  dt {
    color: var(--muted);
    font-size: 12px;
  }

  dd {
    margin: 0;
  }

  kbd {
    padding: 2px 7px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface-muted);
    font-family: var(--font-mono);
    font-size: 12px;
  }
</style>
