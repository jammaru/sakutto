<script lang="ts">
  import { readRuntimeLastError } from '@/shared/runtime-last-error';
  import { browser } from 'wxt/browser';
  import { ensureStoredFolderPermission } from '@/engine/model/shared-folder';
  import { notifySharedFolderChanged } from '@/engine/model/folder-offer';
  import { t } from '@/shared/i18n';
  import { PDF_GRANT_COMMAND, readFolderGrantPending } from '@/shared/folder-grant-pending';
  import { requestModelFolderReload } from '@/shared/messages';

  const embedded = window.parent !== window;
  let busy = $state(false);
  let failed = $state(false);
  let succeeded = $state(false);

  async function closeTab(): Promise<void> {
    try {
      const tab = await browser.tabs.getCurrent();
      if (tab?.id !== undefined) {
        await browser.tabs.remove(tab.id);
        return;
      }
    } catch {
      readRuntimeLastError();
    }
    window.close();
  }

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
      succeeded = true;
      await requestModelFolderReload();
      notifySharedFolderChanged();
      const pending = await readFolderGrantPending();
      await browser.runtime.sendMessage({ type: 'folder:resume-pending' }).catch(() => {
        readRuntimeLastError();
      });
      await browser.runtime.sendMessage({ type: 'folder:grant-complete' }).catch(() => {
        readRuntimeLastError();
      });
      // A resumed PDF opens the reader; keep that new tab in front of the source viewer.
      if (pending?.tabId !== undefined && pending.command !== PDF_GRANT_COMMAND) {
        await browser.tabs.update(pending.tabId, { active: true }).catch(() => {
          readRuntimeLastError();
        });
      }
      await new Promise<void>((resolve) => {
        window.setTimeout(() => resolve(), 350);
      });
      await closeTab();
    } catch {
      readRuntimeLastError();
      failed = true;
    } finally {
      busy = false;
    }
  }
</script>

<main class="page">
  <div class="card">
    {#if embedded}
      <h1>{t('modelFolderEnableTabTitle')}</h1>
      <p class="hint">{t('modelFolderPermissionPage')}</p>
      <button type="button" class="button" disabled={busy} onclick={() => void openFromEmbedded()}>
        {t('modelFolderPermissionGrant')}
      </button>
    {:else}
      <h1>{t('modelFolderEnableTabTitle')}</h1>
      <p class="body">{t('modelFolderEnableTabBody')}</p>
      <p class="hint">{t('modelFolderEnableTabHint')}</p>
      {#if !succeeded}
        <button
          type="button"
          class="button"
          data-sakutto="folder-enable-grant"
          disabled={busy}
          onclick={(event) => void enable(event)}
        >
          {t('modelFolderPermissionGrant')}
        </button>
      {:else}
        <p class="done">{t('modelFolderEnableTabDone')}</p>
      {/if}
    {/if}
    {#if failed}
      <p class="error" role="alert">{t('modelFolderPermissionNeeded')}</p>
    {/if}
  </div>
</main>

<style>
  :global(html),
  :global(body) {
    min-height: 100%;
    margin: 0;
    background: #f8fafc;
  }

  .page {
    box-sizing: border-box;
    min-height: 100vh;
    display: grid;
    place-items: center;
    padding: 24px;
    font:
      15px/1.6 system-ui,
      sans-serif;
    color: #101828;
    background: #f8fafc;
  }

  .card {
    box-sizing: border-box;
    width: min(560px, 100%);
    padding: 32px;
    border: 1px solid #dbe3ea;
    border-radius: 16px;
    background: #fff;
    box-shadow: 0 14px 40px rgb(16 24 40 / 8%);
  }

  h1 {
    margin: 0 0 12px;
    font-size: 24px;
    line-height: 1.3;
  }

  .body,
  .hint,
  .done,
  .error {
    margin: 0 0 14px;
  }

  .hint {
    color: #475467;
    font-size: 13px;
  }

  .done {
    margin-top: 16px;
    color: #475467;
    font-size: 12px;
  }

  .button {
    box-sizing: border-box;
    display: block;
    width: 100%;
    padding: 12px 16px;
    border: 0;
    border-radius: 10px;
    background: #0e7490;
    color: #fff;
    font: inherit;
    font-weight: 700;
    cursor: pointer;
  }

  .button:disabled {
    opacity: 0.7;
    cursor: default;
  }

  .error {
    margin-top: 12px;
    color: #b42318;
  }
</style>
