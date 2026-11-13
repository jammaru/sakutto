<script lang="ts">
  import { t, tForBrowser } from '@/shared/i18n';
  import {
    JA_EASY_TARGET,
    isTargetLanguage,
    SUPPORTED_LANGUAGES,
    type TargetLanguage,
  } from '@/shared/languages';
  import {
    COMPOSE_PLACEMENTS,
    TRANSLATION_POPUP_SIZE_MAX,
    TRANSLATION_POPUP_SIZE_MIN,
    VIDEO_CAPTION_SIZE_MAX,
    VIDEO_CAPTION_SIZE_MIN,
    isComposePlacement,
    normalizeTranslationPopupSize,
    normalizeVideoCaptionSize,
    type Settings,
    type SettingsPatch,
  } from '@/shared/settings';
  import { parseCaptionCustomHost } from '@/captions/custom-hosts';
  import { CAPTION_PREVIEW_PLAYER_PX, captionOverlayFontPx } from '@/captions/overlay';
  import {
    requestCaptionCustomHostAccess,
    revokeCaptionCustomHostAccess,
  } from '@/captions/register-custom';
  import { resolveCaptionToggle } from '@/captions/sites';
  import LanguageField from './LanguageField.svelte';
  import { displayTargetLanguage } from './language-label';

  let captionDenied = $state(false);
  let customHostInput = $state('');
  let customHostWildcard = $state(false);
  let customHostError = $state<'invalid' | 'denied' | null>(null);

  interface Props {
    settings: Settings;
    uiLanguage: string;
    onChange: (patch: SettingsPatch) => void;
    onPermissionDenied?: () => void;
  }

  let { settings, uiLanguage, onChange, onPermissionDenied }: Props = $props();

  let previewSize = $derived(settings.videoCaptionSize);
  const previewFontPx = $derived(
    captionOverlayFontPx(CAPTION_PREVIEW_PLAYER_PX, undefined, previewSize),
  );
  let popupPreviewSize = $derived(settings.translationPopupSize);
  const popupPreviewFontPx = $derived((popupPreviewSize / 100) * 12);

  function updateForm(event: Event) {
    const select = event.currentTarget as HTMLSelectElement;
    onChange({ form: select.value === 'plain' ? 'plain' : 'polite' });
  }

  function updateDisplay(event: Event) {
    const select = event.currentTarget as HTMLSelectElement;
    onChange({ display: select.value === 'bilingual' ? 'bilingual' : 'replace' });
  }

  function updateVideoCaptionSize(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const size = normalizeVideoCaptionSize(input.value);
    previewSize = size;
    onChange({ videoCaptionSize: size });
  }

  function updateTranslationPopupSize(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const size = normalizeTranslationPopupSize(input.value);
    popupPreviewSize = size;
    onChange({ translationPopupSize: size });
  }

  function addCustomHost(): void {
    customHostError = null;
    const raw = customHostInput.trim();
    const withWildcard =
      customHostWildcard && !raw.startsWith('*.') ? `*.${raw.replace(/^www\./, '')}` : raw;
    const parsed = parseCaptionCustomHost(withWildcard);
    if (!parsed) {
      customHostError = 'invalid';
      return;
    }
    if (settings.captionCustomHosts.includes(parsed)) {
      customHostInput = '';
      return;
    }
    void (async () => {
      // User gesture: permissions.request must be the first extension call.
      const granted = await requestCaptionCustomHostAccess(parsed);
      if (!granted) {
        customHostError = 'denied';
        return;
      }
      onChange({ captionCustomHosts: [...settings.captionCustomHosts, parsed] });
      customHostInput = '';
    })();
  }

  function removeCustomHost(entry: string): void {
    void (async () => {
      await revokeCaptionCustomHostAccess(entry);
      onChange({
        captionCustomHosts: settings.captionCustomHosts.filter((host) => host !== entry),
      });
    })();
  }

  function updatePace(event: Event) {
    const select = event.currentTarget as HTMLSelectElement;
    onChange({ pace: select.value === 'quality' ? 'quality' : 'fast' });
  }

  function updateComposeTarget(event: Event) {
    const select = event.currentTarget as HTMLSelectElement;
    if (select.value.length === 0) {
      onChange({ composeTargetLanguage: null });
      return;
    }
    if (!isTargetLanguage(select.value)) return;
    onChange({ composeTargetLanguage: select.value as TargetLanguage });
  }

  function updateComposePlacement(event: Event) {
    const select = event.currentTarget as HTMLSelectElement;
    if (!isComposePlacement(select.value)) return;
    onChange({ composePlacement: select.value });
  }

  const placementLabels = {
    above: 'composePlacementAbove',
    below: 'composePlacementBelow',
    corner: 'composePlacementCorner',
    free: 'composePlacementFree',
  } as const;
</script>

<div class="fields">
  <LanguageField
    value={settings.targetLanguage}
    {uiLanguage}
    onChange={(targetLanguage) => onChange({ targetLanguage })}
  />

  {#if settings.targetLanguage === 'ja' || settings.targetLanguage === JA_EASY_TARGET}
    <label class="field">
      <span>{t('formalityLabel')}</span>
      <select value={settings.form} onchange={updateForm}>
        <option value="polite">{t('formalityPolite')}</option>
        <option value="plain">{t('formalityPlain')}</option>
      </select>
    </label>
  {/if}

  <label class="field">
    <span>{t('displayLabel')}</span>
    <select value={settings.display} onchange={updateDisplay}>
      <option value="replace">{t('displayReplace')}</option>
      <option value="bilingual">{t('displayBilingual')}</option>
    </select>
  </label>

  <label class="field">
    <span>{t('paceLabel')}</span>
    <select value={settings.pace} onchange={updatePace}>
      <option value="quality">{t('paceQuality')}</option>
      <option value="fast">{t('paceFast')}</option>
    </select>
  </label>
  <p class="muted help">{tForBrowser('paceHelp', 'paceHelpFirefox')}</p>

  <div class="field popup-size" data-sakutto="translation-popup-size">
    <div class="field-heading">
      <span>{t('translationPopupSizeLabel')}</span>
      <span class="popup-size-value" aria-hidden="true">{popupPreviewSize}%</span>
    </div>
    <div class="popup-preview" aria-hidden="true">
      <div class="popup-preview-card" style:font-size="{popupPreviewFontPx}px">
        <p class="popup-preview-kicker">翻訳</p>
        <p class="popup-preview-body">これは翻訳ポップアップのプレビューです。</p>
        <p class="popup-preview-note">PLaMo</p>
      </div>
    </div>
    <input
      id="translation-popup-size-slider"
      type="range"
      min={TRANSLATION_POPUP_SIZE_MIN}
      max={TRANSLATION_POPUP_SIZE_MAX}
      step="1"
      value={settings.translationPopupSize}
      aria-label={t('translationPopupSizeLabel')}
      data-sakutto="translation-popup-size-slider"
      oninput={updateTranslationPopupSize}
    />
    <p class="muted help">{t('translationPopupSizeHelp')}</p>
  </div>

  <label class="check">
    <input
      type="checkbox"
      checked={settings.composeIcon}
      onchange={(event) => {
        const input = event.currentTarget as HTMLInputElement;
        onChange({ composeIcon: input.checked });
      }}
    />
    <span>{t('composeIconSetting')}</span>
  </label>
  <p class="muted help">{t('composeIconSettingHelp')}</p>

  <label class="field">
    <span>{t('composeTargetSetting')}</span>
    <select value={settings.composeTargetLanguage ?? ''} onchange={updateComposeTarget}>
      <option value="">{t('composeTargetAuto')}</option>
      {#each [...SUPPORTED_LANGUAGES.slice(0, 1), JA_EASY_TARGET, ...SUPPORTED_LANGUAGES.slice(1)] as language (language)}
        <option value={language}>{displayTargetLanguage(language, uiLanguage)}</option>
      {/each}
    </select>
  </label>
  <p class="muted help">{t('composeTargetSettingHelp')}</p>

  <label class="check">
    <input
      type="checkbox"
      checked={settings.composeInstantReplace}
      onchange={(event) => {
        const input = event.currentTarget as HTMLInputElement;
        onChange({ composeInstantReplace: input.checked });
      }}
    />
    <span>{t('composeInstantSetting')}</span>
  </label>
  <p class="muted help">{t('composeInstantSettingHelp')}</p>

  <label class="field">
    <span>{t('composePlacementSetting')}</span>
    <select value={settings.composePlacement} onchange={updateComposePlacement}>
      {#each COMPOSE_PLACEMENTS as placement (placement)}
        <option value={placement}>{t(placementLabels[placement])}</option>
      {/each}
    </select>
  </label>
  <p class="muted help">{t('composePlacementSettingHelp')}</p>

  <label class="check">
    <input
      type="checkbox"
      data-sakutto="video-captions"
      checked={settings.translateVideoCaptions}
      onchange={(event) => {
        const input = event.currentTarget as HTMLInputElement;
        captionDenied = false;
        void (async () => {
          // User gesture: resolveCaptionToggle must call permissions.request with no prior pause.
          const result = await resolveCaptionToggle(input.checked);
          input.checked = result.on;
          if (result.denied) {
            captionDenied = true;
            onPermissionDenied?.();
            return;
          }
          onChange({ translateVideoCaptions: result.on });
        })();
      }}
    />
    <span>{t('videoCaptionsSetting')}</span>
  </label>
  {#if captionDenied}
    <p class="error" role="alert" data-sakutto="video-captions-denied">
      {t('videoCaptionsPermissionDenied')}
    </p>
  {/if}
  <p class="muted help">{t('videoCaptionsSettingHelp')}</p>

  {#if settings.translateVideoCaptions}
    <label class="check">
      <input
        type="checkbox"
        data-sakutto="video-captions-original"
        checked={settings.videoCaptionDisplay === 'bilingual'}
        onchange={(event) => {
          const input = event.currentTarget as HTMLInputElement;
          onChange({ videoCaptionDisplay: input.checked ? 'bilingual' : 'replace' });
        }}
      />
      <span>{t('videoCaptionsShowOriginalSetting')}</span>
    </label>
    <p class="muted help">{t('videoCaptionsDisplayHelp')}</p>

    <label class="check">
      <input
        type="checkbox"
        data-sakutto="video-captions-original-toggle"
        checked={settings.videoCaptionOriginalToggle}
        onchange={(event) => {
          const input = event.currentTarget as HTMLInputElement;
          onChange({ videoCaptionOriginalToggle: input.checked });
        }}
      />
      <span>{t('videoCaptionsOriginalToggleSetting')}</span>
    </label>
    <p class="muted help">{t('videoCaptionsOriginalToggleHelp')}</p>

    <div class="field caption-size" data-sakutto="video-captions-size">
      <span>{t('videoCaptionsSizeLabel')}</span>
      <div class="caption-preview" aria-hidden="true">
        <div class="caption-preview-player">
          <div class="caption-preview-lines" style:font-size="{previewFontPx}px">
            <div class="caption-preview-original">The north window sells tickets.</div>
            <div class="caption-preview-translation">北側窓口では切符を売っています。</div>
          </div>
        </div>
      </div>
      <input
        type="range"
        min={VIDEO_CAPTION_SIZE_MIN}
        max={VIDEO_CAPTION_SIZE_MAX}
        step="1"
        value={settings.videoCaptionSize}
        aria-label={t('videoCaptionsSizeLabel')}
        data-sakutto="video-captions-size-slider"
        oninput={updateVideoCaptionSize}
      />
      <p class="muted help">{t('videoCaptionsSizeHelp')}</p>
    </div>

    <div class="field caption-position" data-sakutto="video-captions-position">
      <button
        type="button"
        data-sakutto="video-captions-position-reset"
        onclick={() => onChange({ videoCaptionPositions: {} })}
      >
        {t('videoCaptionsPositionReset')}
      </button>
      <p class="muted help">{t('videoCaptionsPositionHelp')}</p>
    </div>

    <div class="field custom-hosts" data-sakutto="caption-custom-hosts">
      <span>{t('videoCaptionsCustomSitesLabel')}</span>
      <p class="muted help">{t('videoCaptionsCustomSitesHelp')}</p>
      <label class="check">
        <input
          type="checkbox"
          data-sakutto="caption-custom-host-subdomains"
          checked={customHostWildcard}
          onchange={(event) => {
            customHostWildcard = (event.currentTarget as HTMLInputElement).checked;
          }}
        />
        <span>{t('videoCaptionsCustomHostSubdomains')}</span>
      </label>
      <div class="custom-host-row">
        <input
          type="text"
          value={customHostInput}
          placeholder={t('videoCaptionsCustomHostPlaceholder')}
          data-sakutto="caption-custom-host"
          autocomplete="off"
          spellcheck="false"
          oninput={(event) => {
            customHostInput = (event.currentTarget as HTMLInputElement).value;
            customHostError = null;
          }}
          onkeydown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              addCustomHost();
            }
          }}
        />
        <button type="button" data-sakutto="caption-custom-host-add" onclick={addCustomHost}>
          {t('videoCaptionsCustomHostAdd')}
        </button>
      </div>
      {#if customHostError === 'invalid'}
        <p class="error" role="alert" data-sakutto="caption-custom-host-invalid">
          {t('videoCaptionsCustomHostInvalid')}
        </p>
      {/if}
      {#if customHostError === 'denied'}
        <p class="error" role="alert" data-sakutto="caption-custom-host-denied">
          {t('videoCaptionsCustomHostDenied')}
        </p>
      {/if}
      {#if settings.captionCustomHosts.length > 0}
        <ul class="custom-host-list">
          {#each settings.captionCustomHosts as host (host)}
            <li>
              <span>{host}</span>
              <button
                type="button"
                data-sakutto="caption-custom-host-remove"
                onclick={() => removeCustomHost(host)}
              >
                {t('videoCaptionsCustomHostRemove')}
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  {/if}
</div>

<style>
  .fields {
    display: grid;
    gap: var(--space-3);
  }

  .field {
    display: grid;
    gap: var(--space-1);
  }

  .field > span,
  .field-heading > span,
  .help {
    color: var(--muted);
    font-size: 11px;
    font-weight: 600;
  }

  .field-heading {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-2);
  }

  .field-heading output {
    color: var(--muted);
    font-size: 11px;
    font-variant-numeric: tabular-nums;
  }

  .popup-preview {
    display: flex;
    padding: 8px;
    border-radius: var(--radius-sm);
    background: var(--surface-muted);
  }

  .popup-preview-card {
    box-sizing: border-box;
    max-width: 100%;
    padding: 8px 10px;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--surface);
    color: var(--text);
    font-family: 'Segoe UI', 'Hiragino Sans', 'Noto Sans JP', sans-serif;
    line-height: 1.45;
    box-shadow: 0 8px 24px rgb(15 23 32 / 12%);
  }

  .popup-preview-kicker,
  .popup-preview-body,
  .popup-preview-note {
    margin: 0;
  }

  .popup-preview-kicker,
  .popup-preview-note {
    color: var(--muted);
    font-size: 0.8333em;
  }

  .popup-preview-kicker {
    margin-bottom: 4px;
    font-weight: 700;
    letter-spacing: 0.04em;
  }

  .popup-preview-note {
    margin-top: 6px;
  }

  .help {
    font-weight: 400;
    line-height: 1.5;
  }

  select {
    width: 100%;
    padding: 7px 9px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface);
    color: var(--text);
  }

  .check {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    color: var(--text);
    font-size: 13px;
  }

  .error {
    margin: 0;
    color: var(--danger, #b91c1c);
    font-size: 12px;
  }

  .caption-preview-player {
    box-sizing: border-box;
    display: grid;
    align-items: end;
    justify-items: center;
    min-height: 132px;
    padding: 12px 10px 18px;
    border-radius: var(--radius-sm);
    background: linear-gradient(180deg, #1e293b 0%, #0f172a 100%);
    color: #fff;
  }

  .caption-preview-lines {
    display: grid;
    gap: 6px;
    justify-items: center;
    text-align: center;
    line-height: 1.35;
    font-family: 'Segoe UI', 'Hiragino Sans', 'Noto Sans JP', sans-serif;
  }

  .caption-preview-original,
  .caption-preview-translation {
    max-width: 100%;
    padding: 0.18em 0.55em;
    border-radius: 0.28em;
    background: rgb(8 8 8 / 92%);
  }

  .caption-preview-original {
    font-size: 0.68em;
    font-weight: 400;
    background: rgb(8 8 8 / 82%);
  }

  .caption-preview-translation {
    font-weight: 500;
  }

  input[type='range'] {
    width: 100%;
  }

  .caption-position button {
    justify-self: start;
    padding: 7px 10px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface);
    color: var(--text);
    cursor: pointer;
  }

  .custom-host-row {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: var(--space-2);
  }

  .custom-host-row input {
    width: 100%;
    padding: 7px 9px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface);
    color: var(--text);
  }

  .custom-host-row button,
  .custom-host-list button {
    padding: 7px 10px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface);
    color: var(--text);
    cursor: pointer;
  }

  .custom-host-list {
    display: grid;
    gap: var(--space-1);
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .custom-host-list li {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
    font-size: 13px;
  }
</style>
