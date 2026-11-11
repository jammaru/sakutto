<script lang="ts">
  import { onMount } from 'svelte';
  import { browser } from 'wxt/browser';
  import {
    HIGH_QUALITY_MODEL_ID,
    SELECTABLE_MODEL_IDS,
    getModel,
    type ModelId,
  } from '@/engine/model/catalog';
  import { sharedFolderNeedsPermission } from '@/engine/model/folder-status';
  import { isModelIntegrityError } from '@/engine/model/manager';
  import { modelCanTranslate, type ModelStatus } from '@/shared/engine-status';
  import { hasLicenseConsent } from '@/shared/agreement';
  import { t } from '@/shared/i18n';
  import {
    isModelProgressMessage,
    requestEngineStatus,
    requestModelCancel,
    requestModelDelete,
    requestModelDownload,
    requestModelInspect,
    requestModelUse,
  } from '@/shared/messages';
  import { loadSettings } from '@/shared/storage';
  import { formatByteSize } from './format';

  const models: readonly ModelId[] = SELECTABLE_MODEL_IDS;

  let statuses = $state<Partial<Record<ModelId, ModelStatus>>>({});
  let activeId = $state<ModelId | null>(null);
  let fallback = $state(false);
  let busy = $state<ModelId | null>(null);
  let folderIntegrity = $state<ReadonlySet<ModelId>>(new Set());
  let folderBlocked = $state(false);
  let anyInstalled = $derived(
    models.some((id) => {
      const state = statuses[id]?.state;
      return state !== undefined && (modelCanTranslate({ state }) || state === 'loading');
    }),
  );

  function label(id: ModelId): string {
    return id === HIGH_QUALITY_MODEL_ID ? t('modelHigh') : t('modelStandard');
  }

  function apply(status: ModelStatus) {
    if (isModelIntegrityError(status.error)) {
      void applyIntegrityStatus(status);
      return;
    }
    statuses = { ...statuses, [status.id]: status };
    if (status.state === 'loaded') void syncActive();
  }

  async function applyIntegrityStatus(status: ModelStatus) {
    const engine = await requestEngineStatus();
    folderIntegrity = new Set(
      engine?.sharedFolder?.integrityIssues.map((issue) => issue.modelId) ?? [],
    );
    folderBlocked = sharedFolderNeedsPermission(engine?.sharedFolder);
    statuses = { ...statuses, [status.id]: status };
    if (engine) activeId = engine.model.id;
  }

  async function syncActive() {
    const engine = await requestEngineStatus();
    if (engine) activeId = engine.model.id;
  }

  function errorText(id: ModelId, error: string): string | null {
    if (isModelIntegrityError(error)) {
      // Shared-folder failures are shown once under the folder settings.
      if (folderIntegrity.has(id)) return null;
      return t('modelFolderIntegrityFailed', [getModel(id).file]);
    }
    return error;
  }

  async function refresh() {
    const next: Partial<Record<ModelId, ModelStatus>> = { ...statuses };
    for (const id of models) {
      const status = await requestModelInspect(id);
      if (status) next[id] = status;
    }
    const engine = await requestEngineStatus();
    if (engine) {
      activeId = engine.model.id;
      fallback = engine.modelFallback === true;
      folderIntegrity = new Set(
        engine.sharedFolder?.integrityIssues.map((issue) => issue.modelId) ?? [],
      );
      folderBlocked = sharedFolderNeedsPermission(engine.sharedFolder);
    }
    statuses = next;
  }

  async function download(id: ModelId) {
    const stored = await loadSettings().catch(() => null);
    if (!hasLicenseConsent(stored)) {
      await browser.tabs
        .create({ url: browser.runtime.getURL('/onboarding.html') })
        .catch(() => undefined);
      return;
    }
    busy = id;
    await requestModelDownload(id);
    busy = null;
  }

  async function use(id: ModelId) {
    busy = id;
    const status = await requestModelUse(id);
    if (status) apply(status);
    activeId = id;
    busy = null;
  }

  async function remove(id: ModelId) {
    busy = id;
    const status = await requestModelDelete(id);
    if (status) apply(status);
    await refresh();
    busy = null;
  }

  onMount(() => {
    const listener = (message: unknown) => {
      if (!isModelProgressMessage(message)) return;
      apply(message.status);
    };
    browser.runtime.onMessage.addListener(listener);
    void refresh();
    return () => browser.runtime.onMessage.removeListener(listener);
  });
</script>

{#if fallback}
  <p class="muted" role="status">{t('modelSelectionFallback')}</p>
{:else if !folderBlocked && !anyInstalled && Object.keys(statuses).length > 0}
  <p class="error" role="alert">{t('modelSelectionMissing')}</p>
{/if}

<ul class="models">
  {#each models as id (id)}
    {@const status = statuses[id]}
    {@const state = status?.state ?? 'absent'}
    {@const downloading = state === 'downloading' || state === 'verifying'}
    <li>
      <div class="summary">
        <strong>{label(id)}</strong>
        <span class="muted">{formatByteSize(getModel(id).size)}</span>
        {#if activeId === id && (state === 'ready' || state === 'loaded')}
          <span class="badge">{t('modelInUse')}</span>
        {/if}
      </div>
      {#if status && (downloading || state === 'partial' || state === 'loading')}
        <p class="muted">
          {formatByteSize(status.received)} / {formatByteSize(status.total)}
        </p>
      {/if}
      {#if status?.error}
        {@const message = errorText(id, status.error)}
        {#if message}
          <p class="error" role="alert">{message}</p>
        {/if}
      {/if}
      <div class="actions">
        {#if downloading}
          <button
            class="button secondary"
            type="button"
            aria-label={`${label(id)} ${t('downloadCancel')}`}
            onclick={() => requestModelCancel(id)}
          >
            {t('downloadCancel')}
          </button>
        {:else if state === 'ready' || state === 'loaded'}
          {#if activeId !== id}
            <button
              class="button"
              type="button"
              aria-label={`${label(id)} ${t('modelUse')}`}
              disabled={busy === id}
              onclick={() => use(id)}
            >
              {t('modelUse')}
            </button>
          {/if}
        {:else if state === 'loading'}
          <!-- The file is here and the runtime is reading it. A Download button in this
               state is a start control for something that is already under way. -->
          <p class="muted">{t('runtimeLoading')}</p>
        {:else if !folderBlocked}
          <button
            class="button"
            type="button"
            aria-label={`${label(id)} ${state === 'partial' ? t('downloadResume') : t('modelDownload')}`}
            disabled={busy === id}
            onclick={() => download(id)}
          >
            {state === 'partial' ? t('downloadResume') : t('modelDownload')}
          </button>
        {/if}
        {#if state !== 'absent'}
          <button
            class="button secondary"
            type="button"
            aria-label={`${label(id)} ${t('modelDelete')}`}
            disabled={busy === id}
            onclick={() => remove(id)}
          >
            {t('modelDelete')}
          </button>
        {/if}
      </div>
    </li>
  {/each}
</ul>

<style>
  .models {
    display: grid;
    gap: var(--space-3);
  }

  li {
    display: grid;
    gap: var(--space-2);
  }

  .summary {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: var(--space-2);
  }

  .badge {
    color: var(--accent-strong);
    font-size: 11px;
    font-weight: 700;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
  }
</style>
