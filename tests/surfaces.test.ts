import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function source(path: string): string {
  return readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');
}

const onboarding = source('entrypoints/onboarding/App.svelte');
const typed = source('entrypoints/typed/App.svelte');
const popup = source('entrypoints/popup/App.svelte');
const modelManager = source('ui/ModelManager.svelte');

/**
 * Every surface that can start a translation while the model is still downloading. A
 * control there either starts a request that cannot answer or opens a page that keeps its
 * source text, which reads as a broken feature rather than as a download in progress.
 */
describe('start controls while the model downloads', () => {
  it('renders no try control on the onboarding card before the model is ready', () => {
    // One conditional governs the sample button, and it is the phase rule rather than the
    // download state directly — `downloading`, `paused` and `error` all fail it.
    expect(onboarding).toContain('onboardingCanTry(phase)');
    expect(onboarding).toContain('{#if showTryButton}');
    expect(onboarding).not.toContain('onboardingTryNow');
    expect(onboarding).not.toMatch(
      /phase === 'downloading' \|\| phase === 'paused'[\s\S]{0,200}trySample/,
    );
  });

  it('keeps pause and close available during the download', () => {
    expect(onboarding).toContain("phase === 'downloading'}");
    expect(onboarding).toContain('onclick={pause}');
    expect(onboarding).toContain('onclick={close}');
  });

  it('does not prompt OPFS users to move to a shared folder from the popup', () => {
    expect(popup).not.toContain('SharedFolderOffer');
    expect(popup).not.toContain('shouldOfferSharedFolderMove');
    expect(popup).not.toContain('modelFolderOfferLead');
    expect(popup).not.toContain('modelFolderOfferOpenSettings');
    expect(popup).not.toContain('modelFolderOfferLater');
    expect(source('entrypoints/options/App.svelte')).not.toContain('SharedFolderOffer');
    expect(source('entrypoints/onboarding/App.svelte')).not.toContain('SharedFolderOffer');
    expect(source('entrypoints/options/App.svelte')).toContain('ModelFolderSettings');
  });

  it('records license consent before linking a folder or starting the engine', () => {
    const start = onboarding.slice(onboarding.indexOf('async function start()'));
    expect(onboarding).toContain('preparePickedSharedFolder');
    expect(start).not.toContain('adoptPickedSharedFolder');
    expect(start.indexOf('saveSettings')).toBeGreaterThan(-1);
    expect(start.indexOf('saveSettings')).toBeLessThan(start.indexOf('persistSharedFolderHandle'));
    expect(onboarding).toContain('copyFromFirefoxFolder');
    const chooseStoreBody = onboarding.slice(
      onboarding.indexOf('function chooseStore('),
      onboarding.indexOf('type FirefoxFolderPickOutcome'),
    );
    expect(chooseStoreBody).not.toContain('copyFromFirefoxFolder');
    const startBody = onboarding.slice(onboarding.indexOf('async function start()'));
    expect(startBody.indexOf('copyFromFirefoxFolder')).toBeGreaterThan(-1);
    expect(startBody.indexOf('copyFromFirefoxFolder')).toBeLessThan(
      startBody.indexOf('saveSettings'),
    );
    expect(onboarding).toContain('warm={consentSaved}');
    expect(onboarding).toContain('(showStartButton && !consentSaved) || Boolean(integrityAlert)');
    expect(source('ui/ModelFolderSettings.svelte')).toContain('hasLicenseConsent');
    expect(source('engine/offscreen/host.ts')).toContain('if (!snapshot?.consented)');
  });

  it('defaults to browser storage and puts browser-first choices above the actions', () => {
    const store = source('ui/onboarding-store.ts');
    expect(store).toContain("return 'browser'");
    expect(store).not.toContain("return 'folder'");
    expect(store).not.toContain("return 'copy'");
    const storageChoice = source('ui/ModelStorageChoice.svelte');
    expect(storageChoice).toContain('data-store-recommended');
    expect(storageChoice).toContain("t('storageOptionRecommended')");
    expect(storageChoice).not.toContain('.store-option.recommended');
    expect(storageChoice.indexOf('value="browser"')).toBeLessThan(
      storageChoice.indexOf('value={mode}'),
    );
    expect(onboarding).toContain('<ModelStorageChoice');
    expect(onboarding).toContain("recommended={pickerAvailable ? 'folder' : 'copy'}");
    expect(onboarding).toContain('onboardingStoreFolderHelp');
    expect(onboarding).toContain("storeChoice === (pickerAvailable ? 'folder' : 'copy')");
    const consent = onboarding.indexOf('<section class="panel consent"');
    const startNotice = onboarding.indexOf('<p id="start-notice"');
    const actions = onboarding.indexOf('<div class="action-row">');
    const choices = onboarding.indexOf('<ModelStorageChoice\n');
    expect(consent).toBeGreaterThan(-1);
    expect(choices).toBeGreaterThan(consent);
    expect(startNotice).toBeGreaterThan(choices);
    expect(actions).toBeGreaterThan(startNotice);
  });

  it('handles translator pack failures and skips unnecessary installs', () => {
    expect(onboarding).toContain('shouldPrepareTranslatorPack');
    expect(onboarding).toContain('void pack?.catch(() => undefined)');
    expect(onboarding).not.toContain('void pack;');
    expect(source('shared/translator-pack.ts')).toContain(
      'installPack(translator, pair, key, options).catch',
    );
  });

  it('does not offer a download when the shared folder needs permission again', () => {
    expect(modelManager).toContain('sharedFolderNeedsPermission');
    expect(typed).toContain('sharedFolderNeedsUserAction');
    expect(typed).not.toContain('folderBlocked');
    expect(typed).toContain('folderNeedsAction');
    expect(typed).toContain('FolderPermissionRestore');
    expect(popup).not.toContain('FolderPermissionRestore');
    expect(popup).toContain('shouldShowModelDownloadGate');
    expect(popup).toContain('showDownloadGate');
    expect(popup).not.toMatch(/\{#if !canStart\}/);
    expect(source('entrypoints/onboarding/App.svelte')).toContain('FolderPermissionRestore');
    expect(source('entrypoints/onboarding/App.svelte')).toContain('FOLDER_PERMISSION_ERROR');
    expect(source('ui/FolderPermissionRestore.svelte')).toContain('modelFolderPermissionGrant');
    expect(source('ui/FolderPermissionRestore.svelte')).toContain('modelFolderPermissionPresent');
    expect(source('ui/FolderPermissionRestore.svelte')).not.toContain(
      'canAttemptSilentFolderGrant',
    );
    expect(source('ui/FolderPermissionRestore.svelte')).toContain('checkingPermission');
    expect(source('ui/FolderPermissionRestore.svelte')).not.toContain('silentGrantFailed');
  });

  it('keeps the cancel control visible while verifying', () => {
    expect(modelManager).toMatch(/downloading \|\| verifying[\s\S]{0,800}downloadCancel/);
  });

  it('removes manual model file import and export from every surface', () => {
    for (const file of [
      'entrypoints/options/App.svelte',
      'entrypoints/onboarding/App.svelte',
      'entrypoints/popup/App.svelte',
    ]) {
      expect(source(file), file).not.toContain('ModelFileTools');
      expect(source(file), file).not.toContain('modelImport');
      expect(source(file), file).not.toContain('modelExport');
    }
    expect(source('ui/ModelFolderSettings.svelte')).not.toContain('modelFolderLocationHint');
    expect(source('ui/ModelFolderSettings.svelte')).toContain('ModelStorageChoice');
    expect(onboarding).toContain('webkitdirectory');
    expect(onboarding).toContain('copySharedFolderFilesToOpfs');
  });

  it('never asks for folder permission from the engine host or a content script', () => {
    expect(source('engine/offscreen/host.ts')).not.toContain('requestFolderPermission');
    expect(source('engine/offscreen/host.ts')).not.toContain('requestPermission');
    expect(source('entrypoints/content.ts')).not.toContain('requestPermission');
    expect(source('engine/model/folder-session.ts')).not.toContain('requestPermission(');
  });

  it('does not offer a download button for a model that is already loading', () => {
    // `loading` means the file is on disk and the runtime is reading it: a Download control
    // there is a start action for work that is already running.
    expect(modelManager).toContain("state === 'loading'");
    expect(modelManager).toMatch(/state === 'loading'[\s\S]{0,400}runtimeLoading/);
  });

  it('surfaces a fallback when the selected model is missing', () => {
    expect(modelManager).toContain('modelSelectionFallback');
    expect(modelManager).toContain('modelSelectionMissing');
    expect(modelManager).not.toMatch(/if \(activeId === id\) activeId = DEFAULT_MODEL_ID/);
  });

  it('gates the popup translate button on the model the same way', () => {
    expect(popup).toContain('translationStartBlocked');
    expect(popup).toMatch(/canStart[\s\S]{0,200}isChromeOnlyLanguage\(targetLanguage\)/);
    expect(popup).toMatch(/disabled=\{[^}]*!canStart[^}]*\}/);
  });

  it('uses the saved global target instead of flipping it from the page language', () => {
    expect(popup).toContain('effectivePageTarget');
    expect(popup).not.toContain('resolvePageTarget');
    expect(popup).toContain('changeTarget');
    expect(popup).toContain('saveSettings({ targetLanguage: language })');
  });

  it('exposes a compact video-caption switch on the same setting', () => {
    expect(popup).toContain('setVideoCaptions');
    expect(popup).toContain('resolveCaptionToggle');
    expect(popup).toContain("t('videoCaptionsSetting')");
    expect(popup).toContain('data-sakutto="video-captions"');
    expect(popup).toContain('videoCaptionsPermissionDenied');
    expect(popup).toContain('saveSettings({ translateVideoCaptions: result.on })');
    expect(popup).not.toContain('videoCaptionsSettingHelp');
    expect(popup).not.toContain('videoCaptionsSizeLabel');
    expect(popup).not.toContain('videoCaptionsPositionReset');
    expect(popup).not.toContain('videoCaptionsCustomSitesLabel');
    expect(popup).not.toContain('video-captions-size-slider');
    expect(popup).not.toContain('video-captions-position-reset');
    expect(popup).not.toMatch(/badge|notification/i);
  });

  it('calls permissions.request as the first await in the popup caption click', () => {
    const sites = source('captions/sites.ts');
    expect(sites).toContain('browser.permissions.request({ origins })');
    expect(sites).toContain('markCaptionEnableIntent');
    expect(sites).toContain('settleCaptionEnableIntent');
    const requestStart = sites.indexOf('export async function requestCaptionHostAccess');
    const requestEnd = sites.indexOf('export interface CaptionToggleDecision');
    const requestBody = sites.slice(requestStart, requestEnd);
    expect(requestBody).toContain('permissions.request');
    expect(requestBody).not.toMatch(/contains/);
    const toggleStart = sites.indexOf('export async function resolveCaptionToggle');
    const toggleBody = sites.slice(toggleStart);
    const beforeRequest = toggleBody.slice(0, toggleBody.indexOf('await requestAccess()'));
    expect(beforeRequest).toContain('markCaptionEnableIntent');
    expect(beforeRequest).not.toMatch(/\bawait\b/);
    const start = popup.indexOf('async function setVideoCaptions');
    const end = popup.indexOf('async function setAlways');
    const body = popup.slice(start, end);
    const before = body.slice(0, body.indexOf('await resolveCaptionToggle'));
    expect(before).toContain('captionPermissionError = false');
    expect(before).not.toMatch(/\bawait\b/);
    expect(popup).toContain('settleCaptionEnableIntent');
  });
});

/**
 * The typed box is a comparison, not a form with an output field. These assertions protect
 * the two things that make it one: two panes side by side, and a single column when the
 * window is too narrow to read both.
 */
describe('typed translation layout', () => {
  it('puts the source and the result in two named panes', () => {
    expect(typed).toContain('id="typed-source-title"');
    expect(typed).toContain('id="typed-result-title"');
    expect(typed).toMatch(/class="compare"[\s\S]*class="pane"[\s\S]*class="pane output"/);
  });

  it('lays the panes out side by side and stacks them on a narrow window', () => {
    expect(typed).toMatch(
      /\.compare\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) minmax\(0, 1fr\)/u,
    );
    expect(typed).toMatch(
      /@media \(max-width: 720px\)[\s\S]*?\.compare\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/u,
    );
  });

  it('keeps the language controls above the panes, with the swap beside them', () => {
    const direction = typed.indexOf('class="direction"');
    const compare = typed.indexOf('class="compare"');
    expect(direction).toBeGreaterThan(-1);
    expect(compare).toBeGreaterThan(direction);
    expect(typed).toContain('LanguageField');
    expect(typed).toContain('typedSwap');
  });

  it('never borrows the reference product’s furniture', () => {
    // No document drop target for PDFs, Word files, or slides; no dictionary panel; no
    // Google copy for the empty state.
    expect(typed).not.toMatch(/type="file"/u);
    expect(typed).not.toMatch(/drop|dragover|DataTransfer/u);
    expect(typed).not.toMatch(/\.pdf|\.docx|\.pptx/iu);
    expect(typed).not.toContain('dictionary');
    expect(typed).not.toContain('辞書');
  });

  it('keeps the PLaMo engine, consent gate and ready rule in place', () => {
    expect(typed).toContain("from './engine'");
    expect(typed).toContain('typedReadiness');
    expect(typed).toContain('hasLicenseConsent');
    expect(typed).toContain('requestModelDownload');
    // The result is copied, never written by a second engine.
    expect(typed).toContain('copyTranslation');
  });
});

/**
 * `wider` is the OCR-reading aid: the typed page marks each hard break in the source box
 * (↵ for breaks inside a sentence) so the reader can fix them before translating, and
 * the translation itself carries normal single breaks. The translation-side wide-gap CSS
 * is gone on every surface, so copy and manual selection hand over real newline bytes.
 */
describe('typed source break marks', () => {
  const marks = source('entrypoints/typed/SourceBreakMarks.svelte');

  it('gates the marks on the wider mode and keeps the textarea native', () => {
    expect(typed).toContain('SourceBreakMarks');
    expect(typed).toContain("settings?.plainTextLineBreaks === 'wider'");
    expect(typed).toContain('bind:value={sourceText}');
    expect(typed).toContain('bind:this={sourceEl}');
    // The marks are a decorative layer over the box, never a second editor.
    expect(typed).not.toContain('contenteditable');
    expect(marks).toContain('aria-hidden="true"');
    expect(marks).toContain('pointer-events: none');
    expect(marks).toContain('segmentSourceText');
    expect(marks).toContain('sourceBreakMarksFromSegments');
  });

  it('renders the result as one plain text node without per-line gap spans', () => {
    expect(typed).toMatch(/<output class="result"[\s\S]*?\{result\}<\/output/u);
    expect(typed).not.toContain('wide-gap');
    expect(typed).not.toContain('resultGaps');
    // A legend names the marks while the mode is on.
    expect(typed).toContain("t('typedSourceBreakLegend')");
  });
});

/**
 * The browser decides which keys run a command and has no API for changing them, so the
 * only way to let a reader rebind one is to send them to its own editor. A settings screen
 * that showed a key it could not change, or offered an edit box of its own, would be lying.
 */
const shortcutNotice = source('ui/ShortcutUnsetNotice.svelte');

describe('shortcut settings', () => {
  const shortcuts = source('ui/ShortcutSettings.svelte');
  const options = source('entrypoints/options/App.svelte');
  const background = source('entrypoints/background.ts');

  it('reads browser bindings without offering an in-page default', () => {
    expect(shortcuts).toContain('requestShortcutSnapshot');
    expect(shortcuts).toContain('displayShortcut');
    expect(shortcuts).toContain('boundShortcut');
    expect(shortcuts).toContain('ShortcutUnsetNotice');
    expect(shortcuts).not.toContain('usesInPageFallback');
    expect(shortcuts).not.toContain('shortcutFallbackKey');
    expect(shortcuts).not.toContain("'Alt+A'");
  });

  it('hands the reader to Chrome for the change itself', () => {
    expect(shortcuts).toContain('openShortcutEditor');
    expect(shortcuts).toContain('shortcutChange');
    // No key capture of its own: Chrome owns the bindings.
    expect(shortcuts).not.toMatch(/onkeydown|addEventListener\('keydown'/u);
  });

  it('names the effective key rather than showing an empty box', () => {
    expect(shortcuts).toContain('shortcutUnset');
    expect(shortcuts).toContain('shortcutOff');
    expect(shortcuts).toContain('shortcutUse');
    expect(shortcuts).not.toContain('shortcutFallbackNote');
  });

  it('shows a localized Chromium unset notice that opens the browser editor', () => {
    const editor = source('shared/shortcut-editor.ts');
    const rules = source('shared/shortcuts.ts');
    expect(shortcutNotice).toContain('showShortcutUnsetNotice');
    expect(rules).toContain('!isFirefoxBuild() && isTranslatePageShortcutUnset(snapshot)');
    expect(shortcutNotice).toContain('shortcutUnsetNotice');
    expect(shortcutNotice).toContain('shortcutOpenSettings');
    expect(shortcutNotice).toContain('data-sakutto="shortcut-unset-notice"');
    expect(shortcutNotice).toContain('data-sakutto="open-shortcut-settings"');
    expect(shortcutNotice).toContain('openShortcutEditor');
    expect(editor).toContain("browser.tabs.create({ url: 'chrome://extensions/shortcuts' })");
  });

  it('omits the redundant change control whenever the unset notice is shown', () => {
    for (const surface of [shortcuts, popup]) {
      expect(surface).toContain('showShortcutUnsetNotice');
      expect(surface).toContain('let showShortcutChange = $derived');
      expect(surface).toMatch(/\{#if showShortcutChange\}[\s\S]{0,250}t\('shortcutChange'\)/u);
    }
  });

  it('is on the settings page', () => {
    expect(options).toContain('ShortcutSettings');
    expect(options).toContain('shortcutHeading');
  });

  it('records the browser’s command bindings on install, update, and startup', () => {
    expect(background).toContain('resolveShortcutQuery');
    expect(background).toContain('restoreEmptyCommandShortcuts');
    expect(background).not.toContain('shortcutStateCache');
    expect(background).toContain('onInstalled');
    expect(background).toContain('onStartup');
    expect(background).toContain("reason === 'install' || reason === 'update'");
  });
});

describe('popup shortcut hints', () => {
  it('names live bindings and includes the same unset notice as options', () => {
    expect(popup).toContain('ShortcutUnsetNotice');
    expect(popup).toContain('requestShortcutSnapshot');
    expect(popup).toContain('defaultShortcuts');
    expect(popup).not.toContain('usesInPageFallback');
    expect(popup).not.toContain('shortcutFallbackNote');
    expect(popup).not.toContain("'Alt+A'");
    expect(shortcutNotice).toContain('showShortcutUnsetNotice');
  });
});

describe('onboarding shortcut hints', () => {
  it('names the keys this OS actually uses, then the keys Chrome reported', () => {
    expect(onboarding).toContain('defaultShortcuts');
    expect(onboarding).toContain('boundShortcut');
    expect(onboarding).toContain('displayShortcut');
    expect(onboarding).toContain('requestShortcutSnapshot');
    expect(onboarding).not.toContain("'Alt+A'");
  });
});

describe('WebGPU diagnostic on settings', () => {
  const options = source('entrypoints/options/App.svelte');
  const panel = source('ui/GpuDiagnostic.svelte');

  it('shows the adapter report under the engine status with a copy control', () => {
    expect(options).toContain('GpuDiagnosticView');
    expect(options).toContain('engine?.gpuDiagnostic');
    expect(panel).toContain('diagGpuCopy');
    expect(panel).toContain('formatGpuDiagnostic');
    expect(panel).toContain('navigator.clipboard.writeText');
  });
});

describe('local server settings', () => {
  const options = source('entrypoints/options/App.svelte');
  const panel = source('ui/LocalServerSettings.svelte');
  const typed = source('entrypoints/typed/App.svelte');

  it('hides the GPU/CPU tier picker while a local server is selected', () => {
    expect(panel).toContain('{:else if builtin}');
    expect(options).toContain('tierLabel');
    expect(options).toContain('idleLabel');
    expect(options).toContain('diagRuntime');
    expect(options).not.toContain('engine-line');
    expect(options).toContain("settings?.engineSource === 'local-server'");
    expect(options).toContain('diagConcurrent');
    expect(options).toContain('requestEngineStatus');
  });

  it('resets remote confirmation when the origin changes, and asks for permission after the checkbox', () => {
    expect(panel).toContain('serverOriginKey');
    expect(panel).toContain('patch.localServerAllowRemote = false');
    expect(panel).toContain('changeAllowRemote');
    expect(panel).toContain('grantIfNeeded');
    expect(panel).not.toContain('<select value={settings.localServerModel}');
  });

  it('passes engineSource into typed readiness so a GGUF download does not block local-server', () => {
    expect(typed).toContain('engineSource:');
    expect(typed).toContain('typedReadiness');
  });

  it('pushes engineSource from the service worker because Chrome offscreen has no chrome.storage', () => {
    const client = source('background/engine-client.ts');
    const host = source('engine/offscreen/host.ts');
    const background = source('entrypoints/background.ts');
    const firefox = source('background/firefox-engine-frame.ts');
    expect(client).toContain("type: 'source-set'");
    expect(client).toContain("type: 'model-set'");
    expect(client).toContain("type: 'runtime-set'");
    expect(client).toContain("message.type === 'model-persist'");
    expect(client).toContain('ensureSource');
    expect(client).toContain('syncStoredSettings');
    expect(background).toContain('client.syncStoredSettings');
    expect(host).toContain("new JobScheduler(localRuntime.parallel, 'pool')");
    expect(host).toContain('browser.storage?.local');
    expect(host).toContain("type: 'model-persist'");
    expect(host).toContain('preferredModelId');
    expect(firefox).toContain('source-set');
    expect(client).toContain('bootSource');
    expect(client).toContain('pushStoredSource');
    expect(background).toContain('client.bootSource');
  });

  it('exposes a concurrent-request limit for the local HTTP server', () => {
    expect(panel).toContain('localServerParallel');
    expect(panel).toContain('sakutto-local-server-models');
    expect(panel).toContain('role="radiogroup"');
    expect(panel).toContain('localServerExperimental');
    expect(panel).toContain('localServerRemoteConfirmRequired');
    expect(panel).toContain('localServerExperimentalAck');
    expect(panel).toContain('PROJECT_LINKS.localServerDocs');
    expect(source('dom/session.ts')).toContain('MAX_BATCH_SEGMENTS');
    expect(source('dom/session.ts')).not.toContain(
      "this.prefs.engineSource === 'local-server' ? 1",
    );
  });

  it('calls permissions.request as the first await when confirming the local server', () => {
    const permissions = source('engine/local-server/permissions.ts');
    const requestStart = permissions.indexOf('export async function requestServerPermission');
    const requestEnd = permissions.indexOf('export type EngineSourceSwitchResult');
    const requestBody = permissions.slice(requestStart, requestEnd);
    expect(requestBody).toContain('permissions.request({ origins: [origin] })');
    expect(requestBody).toContain('primaryOriginPattern');
    expect(requestBody).not.toMatch(/contains/);
    expect(requestBody).not.toContain('originPatternsFor');

    const switchStart = permissions.indexOf('export async function resolveEngineSourceSwitch');
    const switchBody = permissions.slice(switchStart);
    const beforeRequest = switchBody.slice(0, switchBody.indexOf('await request('));
    expect(beforeRequest).not.toMatch(/\bawait\b/);

    expect(panel).toContain('resolveEngineSourceSwitch');
    const applyStart = panel.indexOf('async function applySource');
    const applyEnd = panel.indexOf('function chooseSource');
    const applyBody = panel.slice(applyStart, applyEnd);
    const beforeSwitch = applyBody.slice(0, applyBody.indexOf('await resolveEngineSourceSwitch'));
    expect(beforeSwitch).not.toMatch(/\bawait\b/);
    expect(applyBody).toContain('result.denied');
    expect(applyBody).toContain('syncEngineSourceRadios(settings.engineSource');
    expect(panel).toContain('bind:this={builtinRadio}');
    expect(panel).toContain('bind:this={localRadio}');

    const confirmStart = panel.indexOf('function useLocalServer');
    const confirmEnd = panel.indexOf('async function changeUrl');
    const confirmBody = panel.slice(confirmStart, confirmEnd);
    expect(confirmBody).toContain("void applySource('local-server', true)");
    expect(confirmBody).not.toMatch(/\bawait\b/);
  });

  it('shows a permission denial on the engine radio when the switch did not stick', () => {
    expect(panel).toContain('permissionDenied && !local');
    expect(panel).toContain("t('localServerPermissionDenied')");
    expect(panel).toContain('role="alert"');
  });
});

describe('shared folder activation and recovery', () => {
  const options = source('entrypoints/options/App.svelte');
  const folderSettings = source('ui/ModelFolderSettings.svelte');
  const restore = source('ui/FolderPermissionRestore.svelte');
  const storageChoice = source('ui/ModelStorageChoice.svelte');
  const pageBridge = source('shared/page-bridge.ts');

  it('silently re-grants from the click before it starts slow work', () => {
    const translateStart = popup.indexOf('async function translatePage()');
    const translateEnd = popup.indexOf('/**', translateStart + 1);
    const translateBody = popup.slice(translateStart, translateEnd);
    expect(translateBody.indexOf('ensureFolderPermissionForAction')).toBeGreaterThan(-1);
    expect(translateBody.indexOf('ensureFolderPermissionForAction')).toBeLessThan(
      translateBody.indexOf('ensureContentScript'),
    );
    expect(folderSettings).not.toContain('ensureStoredFolderPermission');
    expect(onboarding).toContain('ensureStoredFolderPermission');
    expect(source('ui/ModelManager.svelte')).toContain('ensureStoredFolderPermission');
  });

  it('opens the folder picker before adopt and any slow host work on settings', () => {
    const chooseStart = folderSettings.indexOf('async function chooseChromiumFolder');
    const chooseBody = folderSettings.slice(
      chooseStart,
      folderSettings.indexOf('async function chooseBrowser', chooseStart),
    );
    expect(chooseBody.indexOf('loadSettings')).toBeLessThan(
      chooseBody.indexOf('adoptPickedSharedFolder'),
    );
    expect(chooseBody.indexOf('adoptPickedSharedFolder')).toBeLessThan(
      chooseBody.indexOf('requestModelFolderAdopt'),
    );
    expect(chooseBody.slice(0, chooseBody.indexOf('adoptPickedSharedFolder'))).not.toContain(
      'requestModelFolderReload',
    );
    expect(chooseBody.slice(0, chooseBody.indexOf('adoptPickedSharedFolder'))).not.toContain(
      'ensureStoredFolderPermission',
    );
    expect(chooseBody.indexOf('requestEngineWarm')).toBeGreaterThan(
      chooseBody.indexOf('requestModelFolderAdopt'),
    );
  });

  it('moves OPFS copies automatically instead of offering a manual delete', () => {
    expect(folderSettings).not.toContain('modelFolderDeleteOpfs');
    expect(folderSettings).toContain('requestModelFolderAdopt');
    expect(folderSettings).toContain('requestModelFolderToBrowser');
    expect(source('engine/model/manager.ts')).toContain('adoptPresentModelsAndRemoveOpfs');
    expect(source('engine/model/manager.ts')).toContain('copyPresentModelsToBrowser');
    expect(source('engine/model/folder-session.ts')).toContain('moveOpfs');
    expect(source('engine/offscreen/host.ts')).toContain('copyPresentModelsToBrowser');
  });

  it('uses one storage choice component in onboarding and settings', () => {
    expect(storageChoice).toContain('data-store-recommended');
    expect(storageChoice).toContain('SharedFolderBenefits');
    expect(onboarding).toContain('<ModelStorageChoice');
    expect(folderSettings).toMatch(/\{#if pickerAvailable\}[\s\S]*<ModelStorageChoice/);
  });

  it('explains browser-only storage when Chromium has no folder picker', () => {
    const branchStart = folderSettings.indexOf('{#if showBrowserOnly}');
    const branchEnd = folderSettings.indexOf('{:else if pickerAvailable ||', branchStart);
    expect(branchStart).toBeGreaterThan(-1);
    expect(branchEnd).toBeGreaterThan(branchStart);
    const branch = folderSettings.slice(branchStart, branchEnd);

    expect(folderSettings).toMatch(
      /showBrowserOnly = \$derived\([\s\S]*!firefoxBuild[\s\S]*sharedFolderSupported\(\)[\s\S]*!pickerAvailable/,
    );
    expect(branch).toMatch(/<h3[^>]*>\{t\('modelStorageLegend'\)\}<\/h3>/);
    expect(branch).toContain('<p class="muted">{t(\'modelStorageBrowserOnlyHint\')}</p>');
    expect(branch).not.toContain('<ModelStorageChoice');
    expect(branch).not.toContain('<input');
    expect(branch).not.toContain('showFirefoxImportUi');
    expect(branch).not.toContain('FolderPermissionRestore');
  });

  it('shows the Brave FSA hint only in browser-only branches, not in feature detection', () => {
    for (const [surface, branchEndMarker] of [
      [folderSettings, '{:else if pickerAvailable ||'],
      [onboarding, '{:else if pickerAvailable || !sharedFolderSupported()}'],
    ] as const) {
      const branchStart = surface.indexOf('{#if showBrowserOnly}');
      const branchEnd = surface.indexOf(branchEndMarker, branchStart);
      expect(branchStart).toBeGreaterThan(-1);
      expect(branchEnd).toBeGreaterThan(branchStart);
      const branch = surface.slice(branchStart, branchEnd);

      expect(branch).toContain("t('modelStorageBrowserOnlyHint')");
      expect(branch).toContain('{#if braveBrowser}');
      expect(branch).toContain("t('modelStorageBraveEnableFsaHint')");
      expect(branch).not.toContain('<ModelStorageChoice');
      expect(branch).not.toContain('<input');
      const gate = surface.split('\n').find((line) => line.includes('let showBrowserOnly ='));
      expect(gate).toContain('!pickerAvailable');
      expect(gate).not.toMatch(/brave|userAgent/i);
    }

    const sharedFolder = source('engine/model/shared-folder.ts');
    const pickerCheck = sharedFolder.slice(
      sharedFolder.indexOf('export function sharedFolderPickerAvailable'),
      sharedFolder.indexOf('export function lookupDirectoryPicker'),
    );
    expect(pickerCheck).toContain("typeof picker === 'function'");
    expect(pickerCheck).not.toMatch(/brave|userAgent|navigator/i);
    for (const path of [
      'entrypoints/folder-enable/App.svelte',
      'entrypoints/offscreen/main.ts',
      'engine/offscreen/host.ts',
      'engine/model/folder-session.ts',
    ]) {
      expect(source(path), path).not.toMatch(/brave|userAgent/i);
    }
  });

  it('replaces Firefox settings storage radios with a single import control', () => {
    expect(folderSettings).toContain('showFirefoxImport');
    expect(folderSettings).toContain('refreshCatalogReady');
    expect(folderSettings).toContain('modelStorageFirefoxImport');
    expect(folderSettings).not.toMatch(
      /\{:else if showFirefoxImportUi\}[\s\S]*<ModelStorageChoice/,
    );
    expect(folderSettings).not.toMatch(/\{:else if showFirefoxImportUi\}[\s\S]*modelStorageIntro/);
    expect(folderSettings).not.toContain('firefoxNotes');
    expect(onboarding).toContain('modelStorageCopyFolder');
  });

  it('copies stored folder models before onboarding switches to browser storage', () => {
    const start = onboarding.slice(onboarding.indexOf('async function start()'));
    const branchStart = start.indexOf("storeChoice === 'browser'");
    expect(branchStart).toBeGreaterThan(-1);
    const branch = start.slice(branchStart, start.indexOf('if (pendingFolder)', branchStart));
    expect(branch).toContain('requestModelFolderToBrowser');
    expect(branch).not.toContain('clearStoredSharedFolder');
  });

  it('disables the onboarding start control while a folder copy is running', () => {
    expect(onboarding).toContain('copyingFolder || readingFolder');
    expect(onboarding).toContain('disabled={closing || copyingFolder');
  });

  it('reports an empty folder instead of a completed copy when nothing moved', () => {
    const chooseStart = folderSettings.indexOf('async function chooseBrowser');
    const chooseBody = folderSettings.slice(
      chooseStart,
      folderSettings.indexOf('async function importFromSharedFolder', chooseStart),
    );
    expect(chooseBody).toContain('result.copied.length');
    expect(chooseBody).toContain("t('modelStorageCopyDone')");
    expect(chooseBody).toContain("t('modelStorageNoModels')");
    expect(chooseBody.indexOf("t('modelStorageNoModels')")).toBeGreaterThan(
      chooseBody.indexOf('result.copied.length'),
    );
  });

  it('promotes storage move successes and failures to callouts', () => {
    expect(folderSettings).toContain("let noticeKind = $state<'success' | 'info' | null>(null);");
    expect(folderSettings).toContain('function showSuccess');
    expect(folderSettings).toContain('function showInfo');
    expect(folderSettings).toContain('data-notice="success"');
    expect(folderSettings).toContain('aria-live="polite"');
    expect(folderSettings).toContain('scrollIntoView');
    expect(folderSettings).toContain('class="callout bad"');
    expect(folderSettings).toContain('role="alert"');

    const chooseStart = folderSettings.indexOf('async function chooseChromiumFolder');
    const chooseBody = folderSettings.slice(
      chooseStart,
      folderSettings.indexOf('async function chooseBrowser', chooseStart),
    );
    expect(chooseBody).toContain("showSuccess(t('modelStorageMoveDone'))");
    expect(chooseBody).not.toContain("notice = t('modelStorageMoveDone')");

    const browserStart = folderSettings.indexOf('async function chooseBrowser');
    const browserBody = folderSettings.slice(
      browserStart,
      folderSettings.indexOf('async function importFromSharedFolder', browserStart),
    );
    expect(browserBody).toContain("showSuccess(t('modelStorageCopyDone'))");
    expect(browserBody).toContain("showInfo(t('modelStorageNoModels'))");
    expect(browserBody).not.toContain("notice = t('modelStorageCopyDone')");

    const importStart = folderSettings.indexOf('async function importFromSharedFolder');
    const importBody = folderSettings.slice(importStart);
    expect(importBody).toContain("showSuccess(t('modelStorageCopyDone'))");
    expect(importBody).toContain("showInfo(t('modelStorageNoModels'))");
    expect(importBody).not.toContain("notice = t('modelStorageCopyDone')");
  });

  it('does not drop a folder handle when the grant lapsed before switching to browser', () => {
    const host = source('engine/offscreen/host.ts');
    const body = host.slice(
      host.indexOf('private async handleFolderToBrowser'),
      host.indexOf('private async handleFolderDeleteOpfs'),
    );
    expect(body).toContain('folderSession.apply()');
    expect(body).toContain("current.permission !== 'granted'");
    expect(body).toContain('{ folder: current, copied: [] }');
    expect(
      body.indexOf('const copied = await services.manager.copyPresentModelsToBrowser'),
    ).toBeGreaterThan(body.indexOf("current.permission !== 'granted'"));
  });

  it('keeps the cache clear outside the storage choice', () => {
    expect(options).toContain('cache-row');
    expect(options.indexOf('<ModelFolderSettings')).toBeLessThan(
      options.indexOf('onclick={clearCache}'),
    );
    expect(folderSettings).not.toContain('cacheClear');
  });

  it('does not render a restore card in the toolbar popup', () => {
    expect(popup).toContain('refreshEngineOnOpen');
    expect(popup).not.toContain('settleFolderPermissionOnOpen');
    expect(popup).not.toContain('FolderPermissionRestore');
    expect(popup).not.toContain('autoSettle={false}');
    expect(popup).not.toContain('ensureStoredFolderPermission');
    expect(popup).toContain('ensureFolderPermissionForAction');
  });

  it('restore cards only query and open the grant tab', () => {
    expect(restore).toContain('autoSettle');
    expect(restore).toContain('activationFailed');
    expect(restore).toContain('queryStoredFolderPermission');
    expect(restore).not.toContain('canAttemptSilentFolderGrant');
    expect(restore).not.toContain('ensureStoredFolderPermission');
    expect(restore).toContain("type: 'folder:open-enable'");
    expect(restore).toContain('probeStoredFolderReadable');
    expect(restore).toContain('isFolderStorageRefreshedMessage');
    expect(modelManager).toContain('shouldOfferRecordedFolderModel');
    expect(modelManager).toContain('modelDeleteSharedFolder');
    expect(modelManager).toContain('requestModelFolderDeleteOpfs');
    expect(modelManager).toContain('opfsCopies');
    expect(source('entrypoints/background.ts')).toContain('folder:storage-refreshed');
  });

  it('does not toast for a folder grant when OPFS can still answer', () => {
    const content = source('content/main.ts');
    const arm = source('content/folder-arm-gate.ts');
    expect(content).toContain('armFolderCommand');
    expect(content).not.toContain('browser.tabs');
    expect(content).not.toContain('getCurrent');
    expect(arm).toContain("type: 'folder:arm-command'");
    expect(arm).not.toContain('tabId');
    expect(content).toContain('isFolderGrantCompleteMessage');
    expect(content).not.toContain('folder-enable.html');
    expect(content).not.toContain('requestPermission');
    expect(content).not.toContain('sakutto-folder-granted');
    expect(content).not.toContain('folderNeedsPermission = sharedFolderNeedsPermission');
    expect(source('background/folder-grant.ts')).toContain('sharedFolderNeedsUserAction');
    expect(source('entrypoints/sample/main.ts')).toContain('sharedFolderNeedsUserAction');
  });

  it('keeps translate available for OPFS installs without a configured folder', () => {
    const start = popup.indexOf('async function ensureFolderPermissionForAction');
    const body = popup.slice(start, popup.indexOf('async function translatePage', start));
    expect(body).toContain('queryStoredFolderPermission');
    expect(body).toContain('allowed: true');
    expect(body).toContain('requestResumeFolderGrantPending');
    expect(body).not.toContain('ensureStoredFolderPermission');
    expect(popup).toContain('access.resumed');
  });

  it('does not repeat the picker hint after a cancelled folder pick', () => {
    const chooseStart = folderSettings.indexOf('async function chooseChromiumFolder');
    const chooseBody = folderSettings.slice(
      chooseStart,
      folderSettings.indexOf('async function chooseBrowser', chooseStart),
    );
    expect(chooseBody).toContain("if (picked.status === 'cancelled')");
    expect(folderSettings).not.toContain('data-folder-picker-hint');
    const start = onboarding.indexOf('async function start()');
    const startBody = onboarding.slice(start, onboarding.indexOf('async function pause', start));
    expect(startBody).toContain("if (prepared.status === 'cancelled') return;");
    expect(onboarding).not.toContain('data-folder-picker-hint');
  });

  it('reuses one onboarding tab instead of adding one per settings click', () => {
    expect(folderSettings).toContain('openOrFocusExtensionTab');
    expect(folderSettings).not.toContain('browser.tabs.create');
    expect(source('ui/ModelManager.svelte')).toContain('openOrFocusExtensionTab');
    expect(options).toContain('openOrFocusExtensionTab');
  });

  it('offers download and a folder settings link after the shared folder is stopped', () => {
    expect(popup).toContain('modelNeedsDownload');
    expect(popup).toContain('sharedFolderSettingsHref');
    expect(popup).toContain('popup-model-download');
    expect(popup).not.toContain('popup-model-import');
    expect(popup).toContain('popup-model-folder');
    expect(popup).toContain("t('modelDownload')");
    expect(popup).not.toContain("t('modelImportChoose')");
    expect(popup).toContain("t('modelFolderChoose')");
    expect(popup).toMatch(/!folderNeedsPermission && !modelNeedsInstall/);
  });

  it('copies a Firefox folder selection into OPFS without manual import or export', () => {
    const folderImport = source('engine/model/folder-import.ts');
    expect(folderImport).toContain('discoverSharedModelFiles');
    expect(folderImport).toContain('importModelFile');
    expect(folderImport).toContain('SHARED_MODELS_DIRECTORY');
    expect(folderSettings).toContain('webkitdirectory');
    expect(folderSettings).toContain('copySharedFolderFilesToOpfs');
    expect(onboarding).toContain('copySharedFolderFilesToOpfs');
    expect(source('engine/model/import-export.ts')).not.toContain('exportModelFile');
  });

  it('retries content injection for a tab that has just reloaded', () => {
    expect(pageBridge).toContain('CONTENT_SCRIPT_RETRY_DELAYS_MS');
    expect(pageBridge).toContain('injectContentScript');
  });
});

describe('live bench local-server flags', () => {
  const cli = readFileSync(new URL('../scripts/bench/pages-run.ts', import.meta.url), 'utf8');
  const runner = readFileSync(new URL('../scripts/bench/pages-runner.ts', import.meta.url), 'utf8');
  const host = readFileSync(new URL('../scripts/bench/host.ts', import.meta.url), 'utf8');

  it('accepts --local-server-parallel and exits the process after a failed verification', () => {
    expect(cli).toContain('--local-server-parallel');
    expect(cli).toContain('process.exit(1)');
    expect(host).toContain('closeAllConnections');
    expect(runner).toContain('return abort(error)');
    expect(host).toContain('probeLocalServer');
    expect(host).toContain('isSuccessfulStatus');
    expect(runner).toContain('history not written');
  });
});

describe('offscreen debug profile wiring', () => {
  it('applies the URL param without reading chrome.storage', () => {
    const offscreen = source('entrypoints/offscreen/main.ts');
    expect(offscreen).toContain('applyWebGpuDebugProfileFromHref');
    expect(offscreen).not.toContain('chrome.storage');
    expect(offscreen).not.toContain('browser.storage');
  });
});
