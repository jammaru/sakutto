<script lang="ts">
  import {
    formatGpuDiagnostic,
    gpuDiagnosticIsEmpty,
    type GpuDiagnostic,
  } from '@/shared/gpu-diagnostic';
  import { t } from '@/shared/i18n';

  interface Props {
    diagnostic: GpuDiagnostic | null | undefined;
  }

  let { diagnostic }: Props = $props();

  let copied = $state(false);
  let copyFailed = $state(false);

  let text = $derived(diagnostic ? formatGpuDiagnostic(diagnostic) : '');
  let empty = $derived(gpuDiagnosticIsEmpty(diagnostic));

  async function copy(): Promise<void> {
    copied = false;
    copyFailed = false;
    if (text.length === 0) {
      copyFailed = true;
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
    } catch {
      copyFailed = true;
    }
  }
</script>

<div class="gpu-diag">
  <div class="gpu-diag-head">
    <h3>{t('diagGpuHeading')}</h3>
    <button class="button secondary" type="button" onclick={() => void copy()} disabled={empty}>
      {t('diagGpuCopy')}
    </button>
  </div>
  <p class="muted help">{t('diagGpuHelp')}</p>
  {#if empty}
    <p class="muted">{t('diagGpuEmpty')}</p>
  {:else}
    <pre class="gpu-diag-body">{text}</pre>
  {/if}
  {#if copied}
    <p class="muted" role="status">{t('diagGpuCopied')}</p>
  {:else if copyFailed}
    <p class="error" role="alert">{t('diagGpuCopyFailed')}</p>
  {/if}
</div>

<style>
  .gpu-diag {
    margin-top: var(--space-3);
  }

  .gpu-diag-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
  }

  .gpu-diag-head h3 {
    margin: 0;
  }

  .gpu-diag-body {
    margin: 0;
    padding: var(--space-3);
    overflow: auto;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface-muted);
    font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
    font-size: 11px;
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
  }
</style>
