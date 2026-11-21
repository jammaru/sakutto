<script lang="ts">
  import { ImageTranslationController, type ImageTranslationLabels } from '@/dom/image-translation';
  import { t } from '@/shared/i18n';
  import { saveSettings } from '@/shared/storage';
  import { tick } from 'svelte';
  import { imageTranslateEngine } from './engine';

  const labels: ImageTranslationLabels = {
    heading: t('imageTranslationHeading'),
    pending: t('imageTranslating'),
    failed: t('imageTranslationFailed'),
    empty: t('imageTranslationEmpty'),
    close: t('imageTranslationClose'),
    original: t('imageOriginalText'),
    permission: t('imageTranslationPermission'),
    copy: t('selectionCopy'),
    copied: t('selectionCopied'),
    copyFailed: t('selectionCopyFailed'),
    resize: t('selectionResizeHandle'),
    ocrMissing: t('ocrDownloadRequired'),
  };

  let controller: ImageTranslationController | null = null;
  let objectUrl: string | null = null;
  let imageElement: HTMLImageElement | null = null;
  let fileName = $state('');
  let busy = $state(false);

  /** The chosen file becomes an object URL in this extension page, which OCR can read directly. */
  async function chooseImage(event: Event): Promise<void> {
    const input = event.currentTarget;
    if (!(input instanceof HTMLInputElement)) return;
    const file = input.files?.[0];
    if (!file) return;

    controller?.close();
    if (imageElement) imageElement.remove();
    if (objectUrl) URL.revokeObjectURL(objectUrl);

    fileName = file.name;
    busy = true;
    objectUrl = URL.createObjectURL(file);
    // ImageTranslationController captures pixels from an <img> whose src is the URL it is
    // given. Keep that element alive for the duration of the translation.
    imageElement = document.createElement('img');
    imageElement.src = objectUrl;
    imageElement.hidden = true;
    imageElement.alt = '';
    imageElement.dataset.sakuttoLocalImage = '';
    document.body.append(imageElement);

    // The local image is hidden, so anchor the popup under the chosen-file label instead.
    await tick();
    const anchor = document.querySelector('[data-sakutto="chosen-file"]')?.getBoundingClientRect();
    controller = new ImageTranslationController({
      labels,
      translate: imageTranslateEngine,
      onWidthChange: (width) => void saveSettings({ imagePopupWidth: width }),
    });
    const url = objectUrl;
    await controller.start(url, anchor ?? null);
    if (objectUrl === url) busy = false;
  }
</script>

<main class="page">
  <div class="card">
    <h1>{t('imageFileAccessHeading')}</h1>
    <p class="body" data-sakutto="file-access-message">{t('imageFileAccessBody')}</p>
    <div class="picker">
      <label for="image-file">{t('imageFileAccessChoose')}</label>
      <input
        id="image-file"
        type="file"
        accept="image/*"
        data-sakutto="image-file"
        onchange={(event) => void chooseImage(event)}
      />
    </div>
    {#if fileName}
      <p class="file-name" data-sakutto="chosen-file">{fileName}</p>
    {/if}
    {#if busy}
      <p class="status" role="status" data-sakutto="image-translate-status">
        {t('imageTranslating')}
      </p>
    {/if}
  </div>
</main>

<style>
  :global(html),
  :global(body) {
    min-height: 100%;
  }

  :global(body) {
    margin: 0;
    background: #f4f6f9;
    color: #182230;
    font:
      14px/1.6 system-ui,
      -apple-system,
      'Segoe UI',
      sans-serif;
  }

  .page {
    box-sizing: border-box;
    min-height: 100vh;
    padding: 32px 16px;
    display: flex;
    justify-content: center;
    align-items: flex-start;
  }

  .card {
    box-sizing: border-box;
    width: min(560px, 100%);
    padding: 24px;
    border: 1px solid #d8dee7;
    border-radius: 12px;
    background: #fff;
    box-shadow: 0 12px 36px rgb(15 23 32 / 12%);
  }

  h1 {
    margin: 0 0 12px;
    font-size: 19px;
  }

  .body {
    margin: 0 0 20px;
  }

  .picker {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 12px;
  }

  .picker label {
    font-weight: 600;
  }

  input[type='file'] {
    max-width: 100%;
  }

  .file-name {
    margin: 12px 0 0;
    color: #536173;
    overflow-wrap: anywhere;
  }

  .status {
    margin: 12px 0 0;
    color: #3157c8;
  }
</style>
