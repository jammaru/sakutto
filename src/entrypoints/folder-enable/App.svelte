<script lang="ts">
  import { browser } from 'wxt/browser';
  import { ensureStoredFolderPermission } from '@/engine/model/shared-folder';
  import { notifySharedFolderChanged } from '@/engine/model/folder-offer';
  import { t } from '@/shared/i18n';
  import { requestModelFolderReload } from '@/shared/messages';

  let token = '';
  let busy = $state(false);
  let failed = $state(false);

  window.addEventListener('message', (event) => {
    if (event.source !== window.parent) return;
    const payload = event.data as { type?: unknown; token?: unknown } | null;
    if (payload?.type !== 'sakutto-folder-enable-token') return;
    if (typeof payload.token !== 'string' || payload.token.length === 0) return;
    token = payload.token;
  });

  async function enable(event: MouseEvent): Promise<void> {
    // A scripted click can reuse the iframe URL; only a real user activation may grant.
    if (!event.isTrusted || busy || token.length === 0) return;
    busy = true;
    failed = false;
    try {
      const valid: unknown = await browser.runtime
        .sendMessage({ type: 'folder:enable-validate', token })
        .catch(() => false);
      if (valid !== true) {
        failed = true;
        return;
      }
      const access = await ensureStoredFolderPermission();
      if (access.status !== 'granted') {
        failed = true;
        return;
      }
      // A click on an already-granted folder needs no session restart. Only a prompt that
      // this gesture renewed has to be re-opened by the engine host.
      if (access.changed) await requestModelFolderReload();
      notifySharedFolderChanged();
      await browser.runtime.sendMessage({ type: 'folder:resume-pending' }).catch(() => undefined);
      // The background validates this extension page and forwards a typed completion
      // message to the tab that deferred its command.
      await browser.runtime.sendMessage({ type: 'folder:grant-complete' }).catch(() => undefined);
    } catch {
      failed = true;
    } finally {
      busy = false;
    }
  }
</script>

<main>
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
