<script lang="ts">
  import { onMount } from 'svelte';
  import { t, tForBrowser, type MessageKey } from '@/shared/i18n';
  import { requestShortcutSnapshot, type ShortcutQueryResult } from '@/shared/messages';
  import { openShortcutEditor } from '@/shared/shortcut-editor';
  import {
    SHORTCUT_COMMANDS,
    ariaShortcut,
    boundShortcut,
    defaultShortcutEnabled,
    displayShortcut,
    usesInPageFallback,
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

  function isOn(command: ShortcutCommand): boolean {
    return enabled[command] !== false;
  }

  function keyFor(command: ShortcutCommand): string {
    return boundShortcut(shortcutState?.snapshot ?? null, command, {
      assigned: shortcutState?.assigned[command],
      enabled: isOn(command),
    });
  }

  function keyText(command: ShortcutCommand): string {
    if (!isOn(command)) return t('shortcutOff');
    const shortcut = keyFor(command);
    if (shortcut.length === 0) return t('shortcutUnset');
    const displayed = displayShortcut(shortcut);
    if (showsFallback(command)) {
      return tForBrowser('shortcutFallbackKey', 'shortcutFallbackKeyFirefox', [displayed]);
    }
    return displayed;
  }

  function aria(command: ShortcutCommand): string | undefined {
    if (!isOn(command)) return undefined;
    const shortcut = keyFor(command);
    if (shortcut.length === 0) return undefined;
    return ariaShortcut(shortcut) ?? undefined;
  }

  function showsFallback(command: ShortcutCommand): boolean {
    return (
      isOn(command) &&
      usesInPageFallback(shortcutState?.snapshot ?? null, command, shortcutState?.assigned[command])
    );
  }

  function refresh(): void {
    void requestShortcutSnapshot().then((next) => {
      if (next) shortcutState = next;
    });
  }

  /**
   * The browser owns the key bindings, so the only honest control is a button that opens
   * its editor. The rows are read again when the reader comes back from that tab. Sakutto's
   * own checkbox is one off switch; clearing a key in the browser is another. The in-page
   * default only fills in when the browser never assigned the suggested key.
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
      {#if showsFallback(command)}
        <p class="fallback" data-sakutto="shortcut-fallback">
          {tForBrowser('shortcutFallbackNote', 'shortcutFallbackNoteFirefox')}
        </p>
      {/if}
    </dd>
  {/each}
</dl>
<button class="button secondary" type="button" onclick={openEditor}>{t('shortcutChange')}</button>
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

  .fallback {
    margin: 0;
    max-width: 28em;
    color: var(--muted);
    font-size: 11px;
    line-height: 1.45;
    text-align: right;
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
