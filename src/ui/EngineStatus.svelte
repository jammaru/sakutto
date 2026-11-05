<script lang="ts">
  import type { EngineCapabilities } from '@/shared/capabilities';
  import { t } from '@/shared/i18n';

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
{/if}
