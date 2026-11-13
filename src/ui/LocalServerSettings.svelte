<script lang="ts">
  import { testLocalServer, type LocalServerModel } from '@/engine/local-server/client';
  import {
    requestServerPermission,
    resolveEngineSourceSwitch,
  } from '@/engine/local-server/permissions';
  import {
    isRemoteServerUrl,
    LOCAL_SERVER_PRESETS,
    serverOriginKey,
  } from '@/engine/local-server/url';
  import { EngineError } from '@/engine/errors';
  import { t } from '@/shared/i18n';
  import type { EngineSource } from '@/shared/engine-status';
  import { PROJECT_LINKS } from '@/shared/plamo-license';
  import type { Settings, SettingsPatch } from '@/shared/settings';
  import type { Snippet } from 'svelte';

  interface Props {
    settings: Settings;
    onUpdate: (patch: SettingsPatch) => Promise<void>;
    builtin?: Snippet;
  }

  let { settings, onUpdate, builtin }: Props = $props();

  let models = $state<LocalServerModel[]>([]);
  let testing = $state(false);
  let testError = $state<EngineError | null>(null);
  let testOk = $state(false);
  let permissionDenied = $state(false);
  let confirmOpen = $state(false);
  let remote = $derived(isRemoteServerUrl(settings.localServerUrl));
  let local = $derived(settings.engineSource === 'local-server');

  async function grantIfNeeded(url: string): Promise<boolean> {
    const granted = await requestServerPermission(url);
    if (!granted) {
      permissionDenied = true;
      return false;
    }
    permissionDenied = false;
    return true;
  }

  async function applySource(source: EngineSource, ack = false): Promise<void> {
    const result = await resolveEngineSourceSwitch(source, settings, { ack });
    if (result.denied) {
      permissionDenied = true;
      return;
    }
    permissionDenied = false;
    await onUpdate(result.patch);
  }

  function chooseSource(source: EngineSource): void {
    if (source === settings.engineSource) return;
    testOk = false;
    testError = null;
    if (source === 'local-server' && !settings.localServerExperimentalAck) {
      confirmOpen = true;
      return;
    }
    void applySource(source);
  }

  function keepBuiltIn(): void {
    confirmOpen = false;
  }

  function useLocalServer(): void {
    confirmOpen = false;
    void applySource('local-server', true);
  }

  async function changeUrl(event: Event) {
    const url = (event.currentTarget as HTMLInputElement).value;
    testOk = false;
    testError = null;
    const originChanged = serverOriginKey(url) !== serverOriginKey(settings.localServerUrl);
    const remoteNext = isRemoteServerUrl(url);
    const patch: SettingsPatch = { localServerUrl: url };
    if (originChanged) patch.localServerAllowRemote = false;

    if (remoteNext) {
      permissionDenied = false;
      await onUpdate(patch);
      return;
    }

    if (settings.engineSource === 'local-server') {
      if (!(await grantIfNeeded(url))) return;
    }
    permissionDenied = false;
    await onUpdate(patch);
  }

  async function applyPreset(id: keyof typeof LOCAL_SERVER_PRESETS) {
    const url = LOCAL_SERVER_PRESETS[id].url;
    testOk = false;
    testError = null;
    const originChanged = serverOriginKey(url) !== serverOriginKey(settings.localServerUrl);
    const patch: SettingsPatch = { localServerUrl: url };
    if (originChanged) patch.localServerAllowRemote = false;
    if (settings.engineSource === 'local-server') {
      if (!(await grantIfNeeded(url))) return;
    }
    permissionDenied = false;
    await onUpdate(patch);
  }

  async function changeModel(event: Event) {
    const target = event.currentTarget as HTMLInputElement;
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

  async function changeParallel(event: Event) {
    const value = Number((event.currentTarget as HTMLInputElement).value);
    if (!Number.isFinite(value)) return;
    await onUpdate({ localServerParallel: value });
  }

  async function changeAllowRemote(event: Event) {
    const checked = (event.currentTarget as HTMLInputElement).checked;
    testOk = false;
    testError = null;
    if (checked && settings.engineSource === 'local-server') {
      if (!(await grantIfNeeded(settings.localServerUrl))) return;
    }
    permissionDenied = false;
    await onUpdate({ localServerAllowRemote: checked });
  }

  function testMessage(error: EngineError | null): string {
    if (!error) {
      return models.length > 0 ? t('localServerTestOk') : t('localServerTestOkUnlisted');
    }
    if (error.code === 'server-remote-unconfirmed') return t('localServerRemoteConfirmRequired');
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
    if (isRemoteServerUrl(settings.localServerUrl) && !settings.localServerAllowRemote) {
      testError = new EngineError(
        'server-remote-unconfirmed',
        'The local server URL is not on this machine. Confirm the warning in Settings to send text there.',
      );
      testing = false;
      return;
    }
    if (!(await grantIfNeeded(settings.localServerUrl))) {
      testing = false;
      return;
    }
    const result = await testLocalServer({
      baseUrl: settings.localServerUrl,
      model: settings.localServerModel,
      apiKey: settings.localServerApiKey,
      timeoutMs: settings.localServerTimeoutMs,
      allowRemote: settings.localServerAllowRemote,
      parallel: settings.localServerParallel,
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

<div class="engine-choice">
  <span class="label" id="engine-source-label">{t('engineSourceLabel')}</span>
  <div class="segments" role="radiogroup" aria-labelledby="engine-source-label">
    <label class:on={!local}>
      <input
        type="radio"
        name="sakutto-engine-source"
        value="in-browser"
        checked={!local}
        onchange={() => chooseSource('in-browser')}
      />
      <span>{t('engineSourceInBrowser')}</span>
    </label>
    <label class:on={local}>
      <input
        type="radio"
        name="sakutto-engine-source"
        value="local-server"
        checked={local}
        onchange={(event) => {
          if (!settings.localServerExperimentalAck && settings.engineSource !== 'local-server') {
            (event.currentTarget as HTMLInputElement).checked = false;
          }
          chooseSource('local-server');
        }}
      />
      <span>{t('engineSourceLocalServer')}</span>
    </label>
  </div>
  <p class="help">{t('engineSourceHelp')}</p>

  {#if confirmOpen}
    <div class="confirm" role="dialog" aria-labelledby="local-experimental-title">
      <p id="local-experimental-title">{t('localServerExperimentalConfirm')}</p>
      <div class="confirm-actions">
        <button class="button" type="button" onclick={useLocalServer}>
          {t('localServerExperimentalUse')}
        </button>
        <button class="button secondary" type="button" onclick={keepBuiltIn}>
          {t('localServerExperimentalKeep')}
        </button>
      </div>
    </div>
  {/if}

  {#if permissionDenied && !local}
    <p class="error" role="alert">{t('localServerPermissionDenied')}</p>
  {/if}

  {#if local}
    <div class="card">
      <p class="experimental">{t('localServerExperimental')}</p>
      <p class="help">
        {t('localServerHelp')}
        <a href={PROJECT_LINKS.localServerDocs} target="_blank" rel="noreferrer">
          {t('localServerDetails')}
        </a>
      </p>

      <div class="presets">
        <button class="button secondary" type="button" onclick={() => void applyPreset('mlx')}>
          {t('localServerPresetMlx')}
        </button>
        <button
          class="button secondary"
          type="button"
          onclick={() => void applyPreset('lm-studio')}
        >
          {t('localServerPresetLmStudio')}
        </button>
      </div>
      <p class="help">{t('localServerPresetHelp')}</p>

      <label class="field">
        <span>{t('localServerUrlLabel')}</span>
        <input
          type="url"
          value={settings.localServerUrl}
          onchange={changeUrl}
          autocomplete="off"
          spellcheck="false"
          aria-describedby="local-server-url-help"
        />
      </label>
      <p class="help" id="local-server-url-help">{t('localServerUrlHelp')}</p>

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
        <input
          type="text"
          list="sakutto-local-server-models"
          value={settings.localServerModel}
          onchange={changeModel}
          autocomplete="off"
          spellcheck="false"
          aria-describedby="local-server-model-help"
        />
        <datalist id="sakutto-local-server-models">
          {#each models as model (model.id)}
            <option value={model.id}>{model.id}</option>
          {/each}
        </datalist>
      </label>
      <p class="help" id="local-server-model-help">{t('localServerModelHelp')}</p>

      <details class="advanced">
        <summary>{t('localServerAdvanced')}</summary>
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
        <label class="field">
          <span>{t('localServerParallelLabel')}</span>
          <input
            type="number"
            min="1"
            max="16"
            step="1"
            value={settings.localServerParallel}
            onchange={changeParallel}
          />
        </label>
        <p class="help">{t('localServerParallelHelp')}</p>
      </details>

      <div class="test-row">
        <button
          class="button secondary"
          type="button"
          onclick={() => void runTest()}
          disabled={testing}
        >
          {testing ? t('statusChecking') : t('localServerTestButton')}
        </button>
        {#if permissionDenied}
          <span class="chip bad" role="alert">{t('localServerPermissionDenied')}</span>
        {:else if testOk}
          <span class="chip ok" role="status">{t('localServerTestOk')}</span>
        {:else if testError}
          <span class="chip bad" role="alert">{t('localServerTestFail')}</span>
        {/if}
      </div>
      {#if testOk && models.length === 0}
        <p class="help" role="status">{t('localServerTestOkUnlisted')}</p>
      {:else if testError}
        <p class="error" role="alert">{testMessage(testError)}</p>
      {/if}
      <p class="help">{t('localServerLicenseNote')}</p>
    </div>
  {:else if builtin}
    {@render builtin()}
  {/if}
</div>

<style>
  .engine-choice,
  .card,
  .field,
  .confirm {
    display: grid;
    gap: var(--space-2);
    min-width: 0;
  }

  .card {
    gap: var(--space-3);
    margin-top: var(--space-2);
    padding: var(--space-4);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--surface-muted);
  }

  .label {
    color: var(--muted);
    font-size: 11px;
    font-weight: 600;
  }

  .segments {
    display: grid;
    grid-template-columns: 1fr 1fr;
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface);
  }

  .segments label {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 36px;
    padding: 6px 10px;
    text-align: center;
    cursor: pointer;
  }

  .segments label + label {
    border-left: 1px solid var(--border);
  }

  .segments label.on {
    background: var(--accent);
    color: var(--accent-contrast);
    font-weight: 700;
  }

  .segments input {
    margin: 0 8px 0 0;
    accent-color: currentColor;
  }

  .help {
    margin: 0;
    color: var(--muted);
    font-size: 12px;
    font-weight: 400;
    line-height: 1.5;
  }

  .experimental {
    margin: 0;
    font-weight: 700;
    line-height: 1.45;
  }

  .presets,
  .test-row,
  .confirm-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
  }

  .field > span:first-child {
    color: var(--muted);
    font-size: 11px;
    font-weight: 600;
  }

  .field input {
    width: 100%;
    min-width: 0;
    padding: 7px 9px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface);
    color: var(--text);
  }

  .check {
    display: flex;
    align-items: flex-start;
    gap: var(--space-2);
    font-size: 13px;
    line-height: 1.45;
  }

  .check input {
    width: auto;
    margin-top: 3px;
  }

  .advanced {
    display: grid;
    gap: var(--space-3);
  }

  .advanced summary {
    cursor: pointer;
    color: var(--accent-strong);
    font-weight: 600;
  }

  .chip {
    display: inline-flex;
    align-items: center;
    max-width: 100%;
    padding: 4px 10px;
    border-radius: 999px;
    font-size: 12px;
    font-weight: 700;
    line-height: 1.4;
  }

  .chip.ok {
    background: color-mix(in srgb, var(--accent) 18%, var(--surface));
    color: var(--accent-strong);
  }

  .chip.bad {
    background: color-mix(in srgb, var(--danger) 18%, var(--surface));
    color: var(--danger);
  }

  .confirm {
    margin-top: var(--space-2);
    padding: var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--surface);
  }

  .confirm p {
    margin: 0;
    line-height: 1.5;
  }

  .error {
    margin: 0;
  }
</style>
