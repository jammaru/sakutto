<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { browser } from 'wxt/browser';
  import { DEFAULT_MODEL_ID } from '@/engine/model/catalog';
  import { readerEngine } from './engine';
  import { loadPdfjs, resolvePdfjsAssetUrls } from '@/pdf/assets';
  import type { PdfDocument } from '@/pdf/extract';
  import { PdfReader, type PageGeometry, type ReaderProgress } from '@/pdf/reader';
  import { pdfConcurrencyFor } from '@/pdf/session';
  import { hasLicenseConsent } from '@/shared/agreement';
  import { currentUiLanguage, t } from '@/shared/i18n';
  import { displayLanguage, type TargetLanguage } from '@/shared/languages';
  import {
    isModelProgressMessage,
    requestEngineStatus,
    requestEngineWarm,
    requestModelDownload,
  } from '@/shared/messages';
  import { MAX_PDF_BYTES, PDF_ID_PARAM } from '@/shared/pdf';
  import type { Settings } from '@/shared/settings';
  import { loadSettings, saveSettings, subscribeSettings } from '@/shared/storage';
  import { readStoredPdf, storedPdfName } from '@/background/pdf-store';
  import LanguageField from '@/ui/LanguageField.svelte';

  type Phase =
    | 'loading'
    | 'ready'
    | 'missing'
    | 'broken'
    | 'too-large'
    | 'no-consent'
    | 'model-missing'
    | 'model-error';

  let settings = $state<Settings | null>(null);
  let uiLanguage = $state(currentUiLanguage());
  let phase = $state<Phase>('loading');
  let fileName = $state('');
  let progress = $state<ReaderProgress | null>(null);
  let reader: PdfReader | null = null;
  let downloadBusy = $state(false);
  let downloadFailed = $state(false);
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  /** The toolbar's own height, so the progress hairline sits directly under it. */
  let toolbarHeight = $state(41);

  const id = new URL(location.href).searchParams.get(PDF_ID_PARAM) ?? '';
  /**
   * Pages to translate, from the URL. The bench uses it to read a representative slice of a
   * long survey; the reader opened from the popup has no limit and works through the document.
   */
  const pageLimit = Number(new URL(location.href).searchParams.get('pages') ?? '0');
  let targetLanguage = $derived<TargetLanguage>(settings?.targetLanguage ?? 'ja');
  let targetLabel = $derived(displayLanguage(targetLanguage, uiLanguage));
  let percent = $derived.by(() =>
    progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0,
  );
  let statusText = $derived.by(() => {
    if (!progress) return t('pdfPreparing');
    // Pages still being read are work in progress even though no block is queued for them
    // yet. Without this the toolbar said "Translated" as soon as the first page's blocks were
    // done, while the rest of the document had not been looked at — a reader took that as the
    // document being finished.
    const readingMore = progress.parsed < progress.pages;
    if (progress.total === 0) {
      // Every page has been read and none of them had a text layer: a scanned document.
      if (!readingMore && progress.pages > 0) return t('pdfNoText');
      return t('pdfReading', [String(progress.parsed), String(progress.pages)]);
    }
    if (progress.pending > 0 || readingMore) {
      return t('pageProgress', [String(progress.done), String(progress.total)]);
    }
    return t('pdfTranslated');
  });
  /**
   * The rate line, in the same words the page translator uses. A reader watching a long paper
   * wants to know whether it is still working and how fast, and the page feature already
   * answers both — a PDF should not be the one place with no numbers.
   */
  let rateText = $derived.by(() => {
    const tokens = progress?.tokensPerSecond ?? null;
    const segments = progress?.segmentsPerSecond ?? null;
    if (tokens === null || segments === null) return '';
    return t('pageRate', [tokens.toFixed(1), segments.toFixed(1)]);
  });
  /**
   * How much of the document the reader left in its own typesetting: equations and the text
   * inside figures. Saying the number is the honest answer to "why is this part still in
   * English?" — it is deliberate, and the paper's own setting is better than a translation.
   */
  let keptText = $derived(
    (progress?.keptAsIs ?? 0) > 0 ? t('pdfKeptAsIs', [String(progress?.keptAsIs ?? 0)]) : '',
  );
  let overflowText = $derived(
    (progress?.overflowed ?? 0) > 0 ? t('pdfOverflow', [String(progress?.overflowed ?? 0)]) : '',
  );
  let failedText = $derived(
    (progress?.failed ?? 0) > 0 ? t('pdfFailedCount', [String(progress?.failed ?? 0)]) : '',
  );

  async function changeTarget(language: TargetLanguage) {
    try {
      settings = await saveSettings({ targetLanguage: language });
    } catch {
      return;
    }
    reader?.setTargetLanguage(language, settings?.form ?? 'polite');
  }

  /** True when the reader has a non-empty selection, which decides the toolbar button. */
  let selectionReady = $state(false);
  let selectionBusy = $state(false);
  /**
   * The engine's tier and source, read once before the document opens. They decide how many
   * blocks may be translated at once, which is the difference between a paper finishing and
   * being cut off partway.
   */
  let engineTier = $state<'g' | 'c8' | 'c4' | 'c1' | null>(null);
  let engineSource = $state<'in-browser' | 'local-server' | undefined>(undefined);

  /**
   * Translates what the reader has selected.
   *
   * The reader does this itself, through the same engine the page translation uses, so the
   * selection is translated with the current target language, formality and glossary rather
   * than through a second path that could drift from them.
   */
  async function translateSelection() {
    if (!reader || selectionBusy) return;
    selectionBusy = true;
    try {
      await reader.translateSelection();
    } finally {
      selectionBusy = false;
    }
  }

  async function startDownload() {
    if (downloadBusy) return;
    downloadBusy = true;
    downloadFailed = false;
    try {
      const started = await requestModelDownload(DEFAULT_MODEL_ID);
      if (!started) downloadFailed = true;
      else await requestEngineWarm();
    } catch {
      downloadFailed = true;
    } finally {
      downloadBusy = false;
    }
  }

  function openOnboarding() {
    void browser.tabs
      .create({ url: browser.runtime.getURL('/onboarding.html') })
      .catch(() => undefined);
  }

  /**
   * Opens the stored document and builds the reader.
   *
   * The page sizes come from the document's own page tree, so the reader can reserve the right
   * space for every page before any text is parsed. Only then is the reader handed the
   * document: it draws and translates lazily from that point.
   */
  async function boot(stored?: Uint8Array, name?: string): Promise<void> {
    const bytes = stored ?? (id.length > 0 ? await readStoredPdf(id) : null);
    if (!bytes) {
      phase = 'missing';
      return;
    }

    const assets = resolvePdfjsAssetUrls((path) => browser.runtime.getURL(path as never));
    let document_: PdfDocument;
    // pdf.js's operator codes, which let the reader tell a figure's labels from the prose
    // around it. Empty when the module does not expose them; the reader then translates the
    // page as it did before that rule existed.
    const ops: Record<string, number> = {};
    try {
      const pdfjs = await loadPdfjs(assets);
      Object.assign(ops, pdfjs.OPS ?? {});
      const opened = await pdfjs.getDocument({
        data: bytes,
        cMapUrl: assets.cmaps,
        cMapPacked: true,
        standardFontDataUrl: assets.standardFonts,
        // Extension pages forbid `eval`, and the fallback path is the only one a Manifest V3
        // page can take anyway.
        isEvalSupported: false,
        useSystemFonts: false,
      }).promise;
      document_ = opened as unknown as PdfDocument;
    } catch {
      phase = 'broken';
      return;
    }

    const geometries: PageGeometry[] = [];
    for (let index = 0; index < document_.numPages; index += 1) {
      const page = await document_.getPage(index + 1);
      const viewport = page.getViewport({ scale: 1 });
      geometries.push({ index, width: viewport.width, height: viewport.height });
    }

    fileName =
      name ?? (id.length > 0 ? ((await storedPdfName(id)) ?? t('pdfUntitled')) : t('pdfUntitled'));
    phase = 'ready';
    await tick();

    reader?.destroy();
    reader = null;
    const root = document.getElementById('pages');
    if (!root) return;
    root.replaceChildren();

    reader = new PdfReader(root, geometries, {
      document: document_,
      engine: readerEngine,
      targetLanguage,
      form: settings?.form ?? 'polite',
      ops,
      ...(engineTier !== null ? { concurrency: pdfConcurrencyFor(engineTier, engineSource) } : {}),
      ...(settings && settings.glossary.length > 0 ? { glossary: settings.glossary } : {}),
      labels: {
        translate: t('translateThisPage'),
        restore: t('restoreThisPage'),
        translating: t('pageTranslating'),
        translated: t('pageTranslated'),
        progress: (done, total) => t('pageProgress', [String(done), String(total)]),
        emptyPage: t('pdfPageNoText'),
        renderFailed: t('pdfRenderFailed'),
        noText: t('pdfNoText'),
        scanning: (page, of) => t('pdfReading', [String(page), String(of)]),
        failed: t('pdfTranslateFailed'),
        selectionTranslating: t('selectionPending'),
        selectionFailed: t('pdfSelectFailed'),
        overflowOpen: t('pdfOverflowOpen'),
      },
      onProgress: (state) => {
        progress = state;
      },
      pageLimit,
    });
    reader.start();
    // The bench and the end-to-end tests read the reader through this hook, the way the page
    // session exposes `sakutto-perf`: it is the only way to see fitted sizes and source boxes
    // without re-running the parser.
    (globalThis as { __sakuttoPdf?: PdfReader }).__sakuttoPdf = reader;
  }

  /**
   * An explicit file, for the case where the background cannot read the open tab: a PDF that
   * was downloaded and opened from disk, or a document behind a login the extension cannot
   * replay. The reader can always translate a file the user hands it.
   */
  async function openLocalFile(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    if (file.size > MAX_PDF_BYTES) {
      phase = 'too-large';
      return;
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.byteLength > MAX_PDF_BYTES) {
      phase = 'too-large';
      return;
    }
    phase = 'loading';
    await boot(bytes, file.name);
  }

  function pickFile() {
    document.getElementById('pdf-file')?.click();
  }

  /**
   * Boots the reader once the engine is usable.
   *
   * A PDF can be read before the model is loaded, so the document is opened either way; only
   * the translation waits. Showing the pages first is what makes the feature feel like a
   * viewer rather than a progress dialog.
   */
  async function startWithEngine(): Promise<void> {
    const status = await requestEngineStatus().catch(() => null);
    if (status === null) {
      phase = 'broken';
      return;
    }
    // Which engine this reader will talk to decides how many blocks may be in flight. The
    // page translator asks the same question and uses the same answer; a PDF that kept two in
    // flight on a GPU took six times as long as the same work on a web page.
    engineTier = status.tier ?? null;
    engineSource = status.engineSource;
    if (!status.plamoReady) {
      phase = 'model-missing';
      void boot();
      return;
    }
    void boot();
    void requestEngineWarm().catch(() => undefined);
  }

  onMount(() => {
    // The toolbar wraps on a narrow window, so its height is measured rather than assumed.
    const header = document.querySelector('.toolbar');
    if (header) {
      const measure = () => {
        toolbarHeight = Math.round(header.getBoundingClientRect().height);
      };
      measure();
      const observer = new ResizeObserver(measure);
      observer.observe(header);
    }

    const unsubscribe = subscribeSettings((next) => {
      settings = next;
      reader?.setGlossary(next.glossary);
      reader?.setTargetLanguage(next.targetLanguage, next.form);
    });

    const onMessage = (message: unknown) => {
      if (!isModelProgressMessage(message)) return;
      if (message.status.state !== 'loaded') return;
      reader?.retryFailed();
      reader?.retryUntranslated();
      if (phase === 'model-missing') phase = 'loading';
    };
    browser.runtime.onMessage.addListener(onMessage);

    const onVisibility = () => reader?.setVisible(!document.hidden);
    document.addEventListener('visibilitychange', onVisibility);

    // A selection is cleared by clicking anywhere else, so the toolbar button follows whether
    // there is one rather than remembering the last one.
    const onSelectionChange = () => {
      const text = globalThis.getSelection?.()?.toString() ?? '';
      selectionReady = text.trim().length > 0;
      if (!selectionReady) reader?.clearSelectionTranslation();
    };
    document.addEventListener('selectionchange', onSelectionChange);

    void loadSettings()
      .then((loaded) => {
        settings = loaded;
        if (!hasLicenseConsent(loaded)) {
          phase = 'no-consent';
          return;
        }
        return startWithEngine();
      })
      .catch(() => {
        phase = 'broken';
      });

    // Drop the stored copy when this tab goes away. A reload is a close-and-open of the
    // reader page, so the original PDF tab (or a file pick) is needed again; leftovers that
    // never get this event are swept after a day.
    const onUnload = () => {
      if (retryTimer !== null) clearTimeout(retryTimer);
      if (id) void browser.runtime.sendMessage({ type: 'pdf:forget', id });
      reader?.destroy();
      reader = null;
    };
    window.addEventListener('pagehide', onUnload);

    return () => {
      unsubscribe();
      browser.runtime.onMessage.removeListener(onMessage);
      document.removeEventListener('visibilitychange', onVisibility);
      document.removeEventListener('selectionchange', onSelectionChange);
      window.removeEventListener('pagehide', onUnload);
      if (retryTimer !== null) clearTimeout(retryTimer);
      reader?.destroy();
      reader = null;
    };
  });
</script>

<main class="reader">
  <header class="toolbar">
    <div class="title" title={fileName}>
      <img src="/icon/32.png" alt="" width="20" height="20" />
      <span>{fileName.length > 0 ? fileName : t('pdfReaderTitle')}</span>
    </div>

    {#if progress && progress.pages > 0}
      <span class="count" role="status">{statusText}</span>
    {/if}
    {#if rateText.length > 0}
      <span class="count rate" aria-live="polite">{rateText}</span>
    {/if}

    <div class="actions">
      {#if selectionReady}
        <button
          class="button secondary"
          type="button"
          aria-busy={selectionBusy ? 'true' : 'false'}
          disabled={selectionBusy}
          onclick={translateSelection}
        >
          {t('pdfSelectTranslate')}
        </button>
      {/if}
      <div class="language">
        <LanguageField value={targetLanguage} {uiLanguage} onChange={changeTarget} />
      </div>
      <span class="target">{targetLabel}</span>
    </div>
  </header>

  {#if phase === 'no-consent'}
    <div class="notice-panel">
      <p>{t('typedNeedsConsent')}</p>
      <button class="button" type="button" onclick={openOnboarding}
        >{t('typedOpenOnboarding')}</button
      >
    </div>
  {:else if phase === 'model-missing'}
    <div class="notice-panel">
      <p>{t('pdfModelMissing')}</p>
      <button class="button" type="button" onclick={startDownload} disabled={downloadBusy}>
        {t('typedDownloadModel')}
      </button>
      {#if downloadFailed}
        <p class="error" role="alert">{t('errorAction')}</p>
      {/if}
    </div>
  {:else if phase === 'missing'}
    <div class="notice-panel">
      <p>{t('pdfMissing')}</p>
      <input
        id="pdf-file"
        class="visually-hidden"
        type="file"
        accept="application/pdf,.pdf"
        onchange={openLocalFile}
      />
      <button class="button" type="button" onclick={pickFile}>{t('pdfChooseFile')}</button>
    </div>
  {:else if phase === 'broken'}
    <div class="notice-panel">
      <p>{t('pdfBroken')}</p>
      <button class="button" type="button" onclick={pickFile}>{t('pdfChooseFile')}</button>
    </div>
  {:else if phase === 'too-large'}
    <div class="notice-panel">
      <p>{t('pdfTooLarge')}</p>
      <input
        id="pdf-file"
        class="visually-hidden"
        type="file"
        accept="application/pdf,.pdf"
        onchange={openLocalFile}
      />
      <button class="button" type="button" onclick={pickFile}>{t('pdfChooseFile')}</button>
    </div>
  {:else if phase === 'loading'}
    <div class="notice-panel">
      <p>{t('pdfPreparing')}</p>
    </div>
  {/if}

  <div id="pages" class="pages" data-phase={phase}></div>

  {#if keptText.length > 0}
    <p class="kept">{keptText}</p>
  {/if}
  {#if overflowText.length > 0}
    <p class="kept">{overflowText}</p>
  {/if}
  {#if failedText.length > 0}
    <p class="kept">{failedText}</p>
  {/if}

  {#if progress && progress.total > 0}
    <!--
      The progress sits under the toolbar as a hairline, not as a chip over the page. A paper's
      last lines are content, and a floating status pill covered them for the whole of a long
      translation; a line under the toolbar is visible without ever covering text.
    -->
    <div
      class="progress"
      role="progressbar"
      aria-valuemin="0"
      aria-valuemax={progress.total}
      aria-valuenow={progress.done}
      aria-label={t('pageProgressLabel')}
      style="top: {toolbarHeight}px"
    >
      <span style="width: {percent}%"></span>
    </div>
  {/if}
</main>

<style>
  .reader {
    --rule: color-mix(in srgb, var(--border) 34%, transparent);
    display: grid;
    grid-template-rows: auto 1fr;
    min-height: 100vh;
  }

  .toolbar {
    position: sticky;
    z-index: 20;
    top: 0;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2) var(--space-3);
    padding: 10px var(--space-4);
    border-bottom: 1px solid var(--rule);
    background: color-mix(in srgb, var(--surface) 92%, transparent);
    backdrop-filter: blur(8px);
  }

  .title {
    display: flex;
    flex: 1 1 260px;
    align-items: center;
    gap: var(--space-2);
    min-width: 0;
    font-weight: 600;
  }

  .title img {
    flex: none;
    border-radius: 4px;
  }

  .title span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .count {
    color: var(--muted);
    font-size: 12px;
    font-variant-numeric: tabular-nums;
  }

  .actions {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin-left: auto;
  }

  .language {
    min-width: 170px;
  }

  .language :global(.field > span) {
    display: none;
  }

  .target {
    color: var(--muted);
    font-size: 11px;
  }

  .notice-panel {
    display: grid;
    gap: var(--space-2);
    justify-items: start;
    max-width: 620px;
    margin: var(--space-4) auto 0;
    padding: var(--space-3) var(--space-4);
    border: 1px solid var(--rule);
    border-radius: var(--radius-sm);
    font-size: 12px;
    line-height: 1.6;
  }

  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    padding: 0;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }

  .pages {
    position: relative;
    min-height: 60vh;
  }

  /* A hairline under the toolbar: the only progress indicator that cannot cover the page. */
  .progress {
    position: fixed;
    z-index: 25;
    top: var(--toolbar-height, 41px);
    left: 0;
    right: 0;
    height: 2px;
    background: color-mix(in srgb, var(--rule) 50%, transparent);
  }

  .progress > span {
    display: block;
    height: 100%;
    background: var(--accent);
    transition: width 240ms ease-out;
  }

  @media (prefers-reduced-motion: reduce) {
    .progress > span {
      transition: none;
    }
  }

  /* The rate is quieter than the page count: it changes constantly while translating. */
  .rate {
    font-variant-numeric: tabular-nums;
    opacity: 0.8;
  }

  /* A note under the page list, saying how much was deliberately left untranslated. */
  .kept {
    max-width: 760px;
    margin: var(--space-3) auto var(--space-5);
    padding: 0 var(--space-4);
    color: var(--muted);
    font-size: 12px;
    line-height: 1.6;
    text-align: center;
  }
</style>
