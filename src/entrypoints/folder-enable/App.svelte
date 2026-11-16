<script lang="ts">
  import { browser } from 'wxt/browser';
  import { ensureStoredFolderPermission } from '@/engine/model/shared-folder';
  import { notifySharedFolderChanged } from '@/engine/model/folder-offer';
  import { t } from '@/shared/i18n';
  import { requestModelFolderReload } from '@/shared/messages';

  let busy = $state(false);
  let failed = $state(false);

  async function enable(): Promise<void> {
    if (busy) return;
    busy = true;
    failed = false;
    try {
      const access = await ensureStoredFolderPermission();
      if (access.status !== 'granted') {
        failed = true;
        return;
      }
      await requestModelFolderReload();
      notifySharedFolderChanged();
      await browser.runtime.sendMessage({ type: 'folder:resume-pending' }).catch(() => undefined);
      window.parent.postMessage({ type: 'sakutto-folder-granted' }, '*');
    } catch {
      failed = true;
    } finally {
      busy = false;
    }
  }
</script>

<main>
  <button type="button" class="button" disabled={busy} onclick={() => void enable()}>
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
