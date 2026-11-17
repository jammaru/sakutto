<script lang="ts">
  import { isFirefoxBuild } from '@/shared/browser';
  import type { EngineCapabilities } from '@/shared/capabilities';
  import { t } from '@/shared/i18n';
  import { linuxWebGpuHintKey, linuxWebGpuHintVisible } from '@/shared/webgpu-hint';

  interface Props {
    capabilities: EngineCapabilities | null;
    failed: boolean;
    detailed?: boolean;
  }

  let { capabilities, failed, detailed = false }: Props = $props();

  function describeEngine(value: EngineCapabilities | null, unavailable: boolean): string {
    if (unavailable) return t('engineUnavailable');
    if (!value) return t('statusChecking');

    switch (value.webgpu) {
      case 'ready':
        return t('engineWebGpu');
      case 'unsupported':
        return t('engineCpuWebGpuUnsupported');
      case 'unavailable':
        return t('engineCpuAdapterUnavailable');
      case 'failed':
        return t('engineCpuProbeFailed');
    }
  }

  let engineLabel = $derived(describeEngine(capabilities, failed));
  let linuxHintKey = $derived(
    linuxWebGpuHintVisible(capabilities?.webgpu) ? linuxWebGpuHintKey(capabilities?.webgpu) : null,
  );
</script>

<div class="row">
  <span>{t('engineStatusLabel')}</span>
  <span class="value" aria-live="polite">{engineLabel}</span>
</div>

{#if detailed && capabilities}
  <div class="row">
    <span>{t('isolationLabel')}</span>
    <span class="value">
      {capabilities.crossOriginIsolated ? t('isolationOn') : t('isolationOff')}
    </span>
  </div>
  <div class="row">
    <span>{t('threadsLabel')}</span>
    <span class="value">{capabilities.hardwareConcurrency}</span>
  </div>
  {#if isFirefoxBuild() && !capabilities.crossOriginIsolated}
    <p class="help">{t('engineFirefoxSingleThread')}</p>
  {/if}
  {#if linuxHintKey}
    <p class="linux-webgpu-note">{t(linuxHintKey)}</p>
  {/if}
{/if}

<style>
  .help {
    color: var(--muted);
    font-size: 11px;
    font-weight: 400;
    line-height: 1.5;
  }

  .linux-webgpu-note {
    margin: var(--space-3) 0 0;
    padding: var(--space-3);
    border-radius: var(--radius-md);
    background: var(--surface-muted);
    color: var(--muted);
    font-size: 12px;
    font-weight: 400;
    line-height: 1.5;
  }
</style>
