<script lang="ts">
  import { readRuntimeLastError } from '@/shared/runtime-last-error';
  import { browser } from 'wxt/browser';
  import { ensureStoredFolderPermission } from '@/engine/model/shared-folder';
  import { notifySharedFolderChanged } from '@/engine/model/folder-offer';
  import { t } from '@/shared/i18n';
  import { requestModelFolderReload } from '@/shared/messages';

  const embedded = window.parent !== window;
  let busy = $state(false);
  let failed = $state(false);

  async function openFromEmbedded(): Promise<void> {
    if (busy) return;
    busy = true;
    failed = false;
    try {
      await browser.runtime.sendMessage({ type: 'folder:open-enable' });
    } catch {
      readRuntimeLastError();
      failed = true;
    } finally {
      busy = false;
    }
  }

  async function enable(event: MouseEvent): Promise<void> {
    if (!event.isTrusted || busy) return;
    if (embedded) {
      await openFromEmbedded();
      return;
    }
    busy = true;
    failed = false;
    try {
      const access = await ensureStoredFolderPermission();
      if (access.status !== 'granted') {
        failed = true;
        return;
      }
      // A click on an already-granted folder needs no session restart. Only a prompt that
      // this gesture renewed has to be re-opened by the engine host.
      if (access.changed) await requestModelFolderReload();
      notifySharedFolderChanged();
      await browser.runtime.sendMessage({ type: 'folder:resume-pending' }).catch(() => {
        readRuntimeLastError();
      });
      await browser.runtime.sendMessage({ type: 'folder:grant-complete' }).catch(() => {
        readRuntimeLastError();
      });
      window.close();
    } catch {
      readRuntimeLastError();
      failed = true;
    } finally {
      busy = false;
    }
  }
</script>

<main>
  {#if embedded}
    <p class="hint">{t('modelFolderPermissionPage')}</p>
  {/if}
  <button type="button" class="button" disabled={busy} onclick={(event) => void enable(event)}>
    {t('modelFolderEnableOneClick')}
  </button>
  {#if failed}
    <p class="error" role="alert">{t('modelFolderPermissionNeeded')}</p>
  {/if}
</main>

<style>
  main {
    margin: 0;
    padding: 8px 10px;
    font:
      12px/1.4 system-ui,
      sans-serif;
    color: #101828;
    background: transparent;
  }

  .hint {
    margin: 0 0 8px;
  }

  .button {
    box-sizing: border-box;
    display: block;
    width: 100%;
    padding: 8px 10px;
    border: 0;
    border-radius: 8px;
    background: #0e7490;
    color: #fff;
    font: inherit;
    font-weight: 600;
    cursor: pointer;
  }

  .button:disabled {
    opacity: 0.7;
    cursor: default;
  }

  .error {
    margin: 6px 0 0;
    color: #b42318;
    font-size: 11px;
  }
</style>
