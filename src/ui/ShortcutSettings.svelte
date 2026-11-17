<script lang="ts">
  import { onMount } from 'svelte';
  import { t, type MessageKey } from '@/shared/i18n';
  import { requestShortcutSnapshot, type ShortcutQueryResult } from '@/shared/messages';
  import { openShortcutEditor } from '@/shared/shortcut-editor';
  import ShortcutUnsetNotice from '@/ui/ShortcutUnsetNotice.svelte';
  import {
    SHORTCUT_COMMANDS,
    ariaShortcut,
    boundShortcut,
    defaultShortcutEnabled,
    displayShortcut,
    showShortcutUnsetNotice,
    type ShortcutCommand,
    type ShortcutEnabled,
  } from '@/shared/shortcuts';

  const LABELS: Readonly<Record<ShortcutCommand, MessageKey>> = {
    'translate-page': 'commandTranslate',
    'toggle-bilingual': 'commandBilingual',
    'translate-selection': 'commandSelection',
    'translate-compose': 'commandCompose',
  };

  interface Props {
    enabled?: ShortcutEnabled | undefined;
    onToggle?: ((command: ShortcutCommand, enabled: boolean) => void) | undefined;
  }

  let { enabled = defaultShortcutEnabled(), onToggle }: Props = $props();

  let shortcutState = $state<ShortcutQueryResult | null>(null);
  let openFailed = $state(false);
  let showShortcutChange = $derived(!showShortcutUnsetNotice(shortcutState?.snapshot ?? null));

  function isOn(command: ShortcutCommand): boolean {
    return enabled[command] !== false;
  }

  function keyFor(command: ShortcutCommand): string {
    return boundShortcut(shortcutState?.snapshot ?? null, command, {
      enabled: isOn(command),
    });
  }

  function keyText(command: ShortcutCommand): string {
    if (!isOn(command)) return t('shortcutOff');
    const shortcut = keyFor(command);
    if (shortcut.length === 0) return t('shortcutUnset');
    return displayShortcut(shortcut);
  }

  function aria(command: ShortcutCommand): string | undefined {
    if (!isOn(command)) return undefined;
    const shortcut = keyFor(command);
    if (shortcut.length === 0) return undefined;
    return ariaShortcut(shortcut) ?? undefined;
  }

  function refresh(): void {
    void requestShortcutSnapshot().then((next) => {
      if (next) shortcutState = next;
    });
  }

  /**
   * The browser owns the key bindings, so the only honest control is a button that opens
   * its editor. The rows and unset notice are read again when the reader comes back from
   * that tab. Sakutto's own checkbox is one off switch; clearing a browser key is another.
   */
  async function openEditor(): Promise<void> {
    openFailed = !(await openShortcutEditor());
  }

  onMount(() => {
    refresh();
    let timer = 0;
    const onFocus = (): void => {
      window.clearTimeout(timer);
      timer = window.setTimeout(refresh, 80);
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  });
</script>

<dl class="bindings">
  {#each SHORTCUT_COMMANDS as command (command)}
    <dt>{t(LABELS[command])}</dt>
    <dd>
      <div class="row">
        <label class="use">
          <input
            type="checkbox"
            checked={isOn(command)}
            onchange={(event) => {
              const input = event.currentTarget as HTMLInputElement;
              onToggle?.(command, input.checked);
            }}
          />
          <span>{t('shortcutUse')}</span>
        </label>
        <kbd aria-keyshortcuts={aria(command)}>{keyText(command)}</kbd>
      </div>
    </dd>
  {/each}
</dl>
<ShortcutUnsetNotice snapshot={shortcutState?.snapshot ?? null} />
{#if showShortcutChange}
  <button class="button secondary" type="button" onclick={openEditor}>{t('shortcutChange')}</button>
{/if}
{#if openFailed}
  <p class="error" role="alert">{t('errorAction')}</p>
{/if}

<style>
  .bindings {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    column-gap: var(--space-3);
    row-gap: var(--space-2);
    margin-bottom: var(--space-3);
  }

  .row {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  dt {
    color: var(--muted);
    font-size: 12px;
  }

  dd {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 4px;
    margin: 0;
  }

  .use {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    color: var(--muted);
    font-size: 11px;
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
