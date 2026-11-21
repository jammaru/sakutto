<script lang="ts">
  import { onMount } from 'svelte';
  import { browser } from 'wxt/browser';
  import {
    HIGH_QUALITY_MODEL_ID,
    SELECTABLE_MODEL_IDS,
    getModel,
    type ModelId,
  } from '@/engine/model/catalog';
  import { FOLDER_PERMISSION_ERROR } from '@/engine/model/folder-permission';
  import {
    canDeleteBrowserCopy,
    folderRecordsModel,
    sharedFolderNeedsPermission,
    sharedFolderStorageActive,
    shouldOfferRecordedFolderModel,
    type SharedFolderStatus,
  } from '@/engine/model/folder-status';
  import { SHARED_FOLDER_CHANGED_EVENT } from '@/engine/model/folder-offer';
  import { isFolderStorageRefreshedMessage } from '@/shared/folder-grant-messages';
  import { isModelIntegrityError } from '@/engine/model/manager';
  import { ensureStoredFolderPermission } from '@/engine/model/shared-folder';
  import { modelCanTranslate, type ModelStatus } from '@/shared/engine-status';
  import { hasLicenseConsent } from '@/shared/agreement';
  import { openOrFocusExtensionTab } from '@/shared/extension-tabs';
  import { integrityMessageKey, t } from '@/shared/i18n';
  import {
    isModelProgressMessage,
    requestEngineStatus,
    requestModelCancel,
    requestModelDelete,
    requestModelFolderDeleteOpfs,
    requestModelDownload,
    requestModelFolderReload,
    requestModelAttach,
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
  let sharedFolder = $state<SharedFolderStatus | null>(null);
  let sharedFolderDelete = $derived(sharedFolderStorageActive(sharedFolder));
  let anyRecordedInFolder = $derived(models.some((id) => folderRecordsModel(sharedFolder, id)));
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
    if (status.error === FOLDER_PERMISSION_ERROR) folderBlocked = true;
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
    sharedFolder = engine?.sharedFolder ?? null;
    statuses = { ...statuses, [status.id]: status };
    if (engine) activeId = engine.model.id;
  }

  async function syncActive() {
    const engine = await requestEngineStatus();
    if (engine) activeId = engine.model.id;
  }

  function errorText(id: ModelId, error: string): string | null {
    if (error === FOLDER_PERMISSION_ERROR) return null;
    if (isModelIntegrityError(error)) {
      // Shared-folder failures are shown once under the folder settings.
      if (folderIntegrity.has(id)) return null;
      return t(integrityMessageKey(error), [getModel(id).file]);
    }
    return error;
  }

  async function refresh() {
    const next: Partial<Record<ModelId, ModelStatus>> = { ...statuses };
    for (const id of models) {
      const status = await requestModelAttach(id);
      if (status) next[id] = status;
    }
    const engine = await requestEngineStatus();
    if (engine) {
      activeId = engine.model.id;
      fallback = engine.modelFallback === true;
      sharedFolder = engine.sharedFolder ?? null;
      folderIntegrity = new Set(
        engine.sharedFolder?.integrityIssues.map((issue) => issue.modelId) ?? [],
      );
      folderBlocked = sharedFolderNeedsPermission(engine.sharedFolder);
    }
    statuses = next;
  }

  async function ensureFolderPermissionForAction(): Promise<void> {
    const access = await ensureStoredFolderPermission().catch(() => null);
    if (access?.status !== 'granted' || !access.changed) return;
    await requestModelFolderReload();
    await refresh();
  }

  async function download(id: ModelId) {
    const stored = await loadSettings().catch(() => null);
    if (!hasLicenseConsent(stored)) {
      void openOrFocusExtensionTab('/onboarding.html');
      return;
    }
    busy = id;
    await ensureFolderPermissionForAction();
    await requestModelDownload(id);
    busy = null;
  }

  async function use(id: ModelId) {
    busy = id;
    await ensureFolderPermissionForAction();
    const status = await requestModelUse(id);
    if (status) {
      apply(status);
      if (modelCanTranslate(status) || status.state === 'loading') activeId = id;
    }
    busy = null;
  }

  async function remove(id: ModelId) {
    busy = id;
    if (sharedFolderStorageActive(sharedFolder)) {
      const folder = await requestModelFolderDeleteOpfs(id);
      if (folder) sharedFolder = folder;
      await refresh();
    } else {
      const status = await requestModelDelete(id);
      if (status) apply(status);
      await refresh();
    }
    busy = null;
  }

  onMount(() => {
    const listener = (message: unknown) => {
      if (isFolderStorageRefreshedMessage(message)) {
        void refresh();
        return;
      }
      if (!isModelProgressMessage(message)) return;
      apply(message.status);
    };
    const onFolderChanged = (): void => {
      void refresh();
    };
    const onFocus = (): void => {
      void refresh();
    };
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') void refresh();
    };
    browser.runtime.onMessage.addListener(listener);
    window.addEventListener(SHARED_FOLDER_CHANGED_EVENT, onFolderChanged);
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);
    void refresh();
    return () => {
      browser.runtime.onMessage.removeListener(listener);
      window.removeEventListener(SHARED_FOLDER_CHANGED_EVENT, onFolderChanged);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  });
</script>

{#if fallback}
  <p class="muted" role="status">{t('modelSelectionFallback')}</p>
{:else if !folderBlocked && !anyInstalled && !anyRecordedInFolder && Object.keys(statuses).length > 0}
  <p class="error" role="alert">{t('modelSelectionMissing')}</p>
{/if}
{#if sharedFolderDelete}
  <p class="muted delete-note">{t('modelDeleteSharedFolderHint')}</p>
{/if}

<ul class="models">
  {#each models as id (id)}
    {@const status = statuses[id]}
    {@const state = status?.state ?? 'absent'}
    {@const downloading = state === 'downloading'}
    {@const verifying = state === 'verifying'}
    {@const offerRecorded =
      shouldOfferRecordedFolderModel(sharedFolder, id, state) && activeId !== id}
    {@const deleteLabel = sharedFolderDelete ? t('modelDeleteSharedFolder') : t('modelDelete')}
    {@const hasBrowserCopy =
      state !== 'absent' || (sharedFolder?.opfsCopies?.includes(id) ?? false)}
    {@const showDelete =
      hasBrowserCopy && (!sharedFolderDelete || canDeleteBrowserCopy(sharedFolder, id))}
    <li>
      <div class="summary">
        <strong>{label(id)}</strong>
        <span class="muted">{formatByteSize(getModel(id).size)}</span>
        {#if activeId === id && (state === 'ready' || state === 'loaded')}
          <span class="badge">{t('modelInUse')}</span>
        {/if}
      </div>
      {#if status && (downloading || verifying || state === 'partial' || state === 'loading')}
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
        {#if downloading || verifying}
          {#if verifying}
            <p class="muted" role="status">{t('modelVerifying')}</p>
          {/if}
          <!-- Verification still reads local bytes and can be cancelled. Keep the same control
               visible instead of replacing it with a status label. -->
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
        {:else if offerRecorded}
          <button
            class="button"
            type="button"
            aria-label={`${label(id)} ${t('modelUse')}`}
            disabled={busy === id}
            onclick={() => use(id)}
          >
            {t('modelUse')}
          </button>
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
        {#if showDelete}
          <button
            class="button secondary"
            type="button"
            aria-label={`${label(id)} ${deleteLabel}`}
            disabled={busy === id}
            onclick={() => remove(id)}
          >
            {deleteLabel}
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

  .delete-note {
    margin: 0 0 var(--space-2);
  }
</style>
