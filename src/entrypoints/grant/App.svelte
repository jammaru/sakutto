<script lang="ts">
  import { browser } from 'wxt/browser';
  import { isSiteHost, loadSiteRule, saveSiteRule, siteAccessOrigins } from '@/dom/sites';
  import { t } from '@/shared/i18n';

  const host = new URL(location.href).searchParams.get('host') ?? '';
  const valid = isSiteHost(host);

  let message = $state('');
  let pending = $state(false);

  async function allow(): Promise<void> {
    if (!valid || pending) return;
    pending = true;
    message = '';
    const origins = siteAccessOrigins(`https://${host}/`);
    if (!origins) {
      message = t('siteGrantInvalid');
      pending = false;
      return;
    }
    const granted = await browser.permissions.request({ origins }).catch(() => false);
    if (!granted) {
      message = t('siteGrantDenied');
      pending = false;
      return;
    }
    try {
      const current = await loadSiteRule(host);
      await saveSiteRule({ ...current, host, auto: 'always' });
    } catch {
      message = t('siteGrantDenied');
      pending = false;
      return;
    }
    window.close();
  }
</script>

<main class="panel">
  <h1>{t('siteGrantTitle')}</h1>
  {#if valid}
    <p>{t('siteGrantBody', [host])}</p>
    <button class="button" type="button" onclick={allow} disabled={pending}>
      {t('siteGrantAllow')}
    </button>
    {#if message}
      <p class="error" role="alert">{message}</p>
    {/if}
  {:else}
    <p class="error" role="alert">{t('siteGrantInvalid')}</p>
  {/if}
</main>

<style>
  main {
    display: grid;
    gap: 12px;
    margin: 16px;
  }

  h1 {
    font-size: 16px;
  }
</style>
