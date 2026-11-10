<script lang="ts">
  import { testLocalServer, type LocalServerModel } from '@/engine/local-server/client';
  import { requestServerPermission } from '@/engine/local-server/permissions';
  import { isRemoteServerUrl, LOCAL_SERVER_PRESETS } from '@/engine/local-server/url';
  import type { EngineError } from '@/engine/errors';
  import { t } from '@/shared/i18n';
  import type { EngineSource } from '@/shared/engine-status';
  import type { Settings, SettingsPatch } from '@/shared/settings';

  interface Props {
    settings: Settings;
    onUpdate: (patch: SettingsPatch) => Promise<void>;
  }

  let { settings, onUpdate }: Props = $props();

  let models = $state<LocalServerModel[]>([]);
  let testing = $state(false);
  let testError = $state<EngineError | null>(null);
  let testOk = $state(false);
  let permissionDenied = $state(false);
  let remote = $derived(isRemoteServerUrl(settings.localServerUrl));

  async function changeSource(event: Event) {
    const value = (event.currentTarget as HTMLSelectElement).value;
    const source: EngineSource = value === 'local-server' ? 'local-server' : 'in-browser';
    if (source === 'local-server') {
      const granted = await requestServerPermission(settings.localServerUrl);
      if (!granted) {
        permissionDenied = true;
        return;
      }
    }
    permissionDenied = false;
    await onUpdate({ engineSource: source });
  }

  async function changeUrl(event: Event) {
    const url = (event.currentTarget as HTMLInputElement).value;
    testOk = false;
    testError = null;
    if (settings.engineSource === 'local-server') {
      const granted = await requestServerPermission(url);
      if (!granted) {
        permissionDenied = true;
        return;
      }
    }
    permissionDenied = false;
    await onUpdate({ localServerUrl: url });
  }

  async function applyPreset(id: keyof typeof LOCAL_SERVER_PRESETS) {
    const url = LOCAL_SERVER_PRESETS[id].url;
    testOk = false;
    testError = null;
    if (settings.engineSource === 'local-server') {
      const granted = await requestServerPermission(url);
      if (!granted) {
        permissionDenied = true;
        return;
      }
    }
    permissionDenied = false;
    await onUpdate({ localServerUrl: url });
  }

  async function changeModel(event: Event) {
    const target = event.currentTarget as HTMLInputElement | HTMLSelectElement;
    await onUpdate({ localServerModel: target.value });
  }

  async function changeApiKey(event: Event) {
    await onUpdate({ localServerApiKey: (event.currentTarget as HTMLInputElement).value });
  }

  async function changeTimeout(event: Event) {
    const value = Number((event.currentTarget as HTMLInputElement).value);
    if (!Number.isFinite(value)) return;
    await onUpdate({ localServerTimeoutMs: value * 1000 });
  }

  async function changeAllowRemote(event: Event) {
    await onUpdate({
      localServerAllowRemote: (event.currentTarget as HTMLInputElement).checked,
    });
  }

  function testMessage(error: EngineError | null): string {
    if (!error) return t('localServerTestOk');
    if (error.code === 'server-unavailable') return t('localServerUnreachable');
    if (error.code === 'server-timeout') return t('localServerTimeout');
    if (error.code === 'server-model-missing') return t('localServerModelMissing');
    return t('localServerTestFail');
  }

  async function runTest() {
    testing = true;
    testOk = false;
    testError = null;
    permissionDenied = false;
    const granted = await requestServerPermission(settings.localServerUrl);
    if (!granted) {
      permissionDenied = true;
      testing = false;
      return;
    }
    const result = await testLocalServer({
      baseUrl: settings.localServerUrl,
      model: settings.localServerModel,
      apiKey: settings.localServerApiKey,
      timeoutMs: settings.localServerTimeoutMs,
      allowRemote: settings.localServerAllowRemote,
    });
    models = result.models;
    testOk = result.ok;
    testError = result.error ?? null;
    if (result.ok && settings.localServerModel.length === 0 && result.models[0]) {
      await onUpdate({ localServerModel: result.models[0].id });
    }
    testing = false;
  }
</script>

<label class="field">
  <span>{t('engineSourceLabel')}</span>
  <select value={settings.engineSource} onchange={changeSource}>
    <option value="in-browser">{t('engineSourceInBrowser')}</option>
    <option value="local-server">{t('engineSourceLocalServer')}</option>
  </select>
</label>
<p class="muted help">{t('engineSourceHelp')}</p>

{#if settings.engineSource === 'local-server'}
  <div class="presets">
    <button class="button secondary" type="button" onclick={() => void applyPreset('mlx')}>
      {t('localServerPresetMlx')}
    </button>
    <button class="button secondary" type="button" onclick={() => void applyPreset('lm-studio')}>
      {t('localServerPresetLmStudio')}
    </button>
  </div>
  <p class="muted help">{t('localServerPresetHelp')}</p>

  <label class="field">
    <span>{t('localServerUrlLabel')}</span>
    <input
      type="url"
      value={settings.localServerUrl}
      onchange={changeUrl}
      autocomplete="off"
      spellcheck="false"
    />
  </label>

  {#if remote}
    <label class="check">
      <input
        type="checkbox"
        checked={settings.localServerAllowRemote}
        onchange={changeAllowRemote}
      />
      <span>{t('localServerNonLocalWarning')}</span>
    </label>
  {/if}

  <label class="field">
    <span>{t('localServerModelLabel')}</span>
    {#if models.length > 0}
      <select value={settings.localServerModel} onchange={changeModel}>
        <option value="">{t('localServerModelsEmpty')}</option>
        {#each models as model (model.id)}
          <option value={model.id}>{model.id}</option>
        {/each}
      </select>
    {:else}
      <input
        type="text"
        value={settings.localServerModel}
        onchange={changeModel}
        autocomplete="off"
        spellcheck="false"
      />
    {/if}
  </label>

  <label class="field">
    <span>{t('localServerApiKeyLabel')}</span>
    <input
      type="password"
      value={settings.localServerApiKey}
      onchange={changeApiKey}
      autocomplete="off"
    />
  </label>

  <label class="field">
    <span>{t('localServerTimeoutLabel')}</span>
    <input
      type="number"
      min="5"
      max="600"
      step="5"
      value={Math.round(settings.localServerTimeoutMs / 1000)}
      onchange={changeTimeout}
    />
  </label>

  <div class="test-row">
    <button
      class="button secondary"
      type="button"
      onclick={() => void runTest()}
      disabled={testing}
    >
      {t('localServerTestButton')}
    </button>
  </div>
  {#if permissionDenied}
    <p class="error" role="alert">{t('localServerPermissionDenied')}</p>
  {:else if testOk}
    <p class="muted" role="status">{testMessage(null)}</p>
  {:else if testError}
    <p class="error" role="alert">{testMessage(testError)}</p>
  {/if}
  <p class="muted help">{t('localServerHelp')}</p>
  <p class="muted help">{t('localServerLicenseNote')}</p>
{/if}

<style>
  .presets,
  .test-row {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    margin-bottom: var(--space-2);
  }

  .check {
    display: flex;
    align-items: flex-start;
    gap: var(--space-2);
    margin: var(--space-2) 0 var(--space-3);
    font-size: 13px;
  }

  .check input {
    width: auto;
    margin-top: 3px;
  }
</style>
