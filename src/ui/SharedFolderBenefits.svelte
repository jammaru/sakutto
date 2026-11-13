<script lang="ts">
  import { t, type MessageKey } from '@/shared/i18n';

  interface Props {
    leadKey: MessageKey;
    sizeLabel: string;
    compact?: boolean;
  }

  let { leadKey, sizeLabel, compact = false }: Props = $props();
</script>

<div class="benefits" class:compact>
  <p>{t(leadKey)}</p>
  <ul>
    <li>{t('modelFolderBenefitShare')}</li>
    <li>{t('modelFolderBenefitSpace', [sizeLabel])}</li>
    <li>{t('modelFolderBenefitKeep')}</li>
  </ul>
</div>

<style>
  .benefits {
    display: grid;
    gap: var(--space-1);
  }

  .benefits p {
    margin: 0;
  }

  ul {
    display: grid;
    gap: 2px;
    margin: 0;
    padding-left: 1.2em;
    list-style: disc;
  }

  .compact {
    font-size: 12px;
    line-height: 1.35;
  }

  .compact ul {
    gap: 1px;
  }
</style>
