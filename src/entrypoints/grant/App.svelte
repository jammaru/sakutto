<script lang="ts">
  import { browser } from 'wxt/browser';
  import { onMount } from 'svelte';
  import { allSitesGrantCoversOrigins, hasAllSitesAccess } from '@/dom/all-sites';
  import { isSiteHost, loadSiteRule, saveSiteRule, siteAccessOrigins } from '@/dom/sites';
  import { t } from '@/shared/i18n';

  const host = new URL(location.href).searchParams.get('host') ?? '';
  const valid = isSiteHost(host);

  let message = $state('');
  let pending = $state(false);

  onMount(() => {
    // Recorded while the page opens so the Allow click can read the all-sites state
    // synchronously and never awaits before its permission work. A click before this
    // resolves still prompts, exactly like a page opened before the broad grant.
    void hasAllSitesAccess();
  });

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
    // A broad all-sites grant already covers these http/https origins and requesting
    // them would still prompt, so the grant alone turns the rule on. Otherwise
    // `permissions.request` stays the first awaited call in this click.
    const granted = allSitesGrantCoversOrigins(origins)
      ? true
      : await browser.permissions.request({ origins }).catch(() => false);
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
