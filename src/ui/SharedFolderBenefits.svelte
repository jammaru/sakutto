<script lang="ts">
  import { t, type MessageKey } from '@/shared/i18n';

  interface Props {
    leadKey: MessageKey;
    sizeLabel: string;
  }

  let { leadKey, sizeLabel }: Props = $props();
</script>

<div class="benefits">
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
</style>
