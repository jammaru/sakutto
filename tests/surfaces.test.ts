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
 * The browser decides which keys run a command and has no API for changing them, so the
 * only way to let a reader rebind one is to send them to its own editor. A settings screen
 * that showed a key it could not change, or offered an edit box of its own, would be lying.
 */
describe('shortcut settings', () => {
  const shortcuts = source('ui/ShortcutSettings.svelte');
  const options = source('entrypoints/options/App.svelte');
  const background = source('entrypoints/background.ts');

  it('reads the keys the browser has bound, and falls back only after an install conflict', () => {
    expect(shortcuts).toContain('requestShortcutSnapshot');
    expect(shortcuts).toContain('displayShortcut');
    expect(shortcuts).toContain('boundShortcut');
    expect(shortcuts).toContain('usesInPageFallback');
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
    expect(shortcuts).toContain('shortcutFallbackNote');
  });

  it('is on the settings page', () => {
    expect(options).toContain('ShortcutSettings');
    expect(options).toContain('shortcutHeading');
  });

  it('records the browser’s first command bindings so a later clear is not a conflict', () => {
    expect(background).toContain('resolveShortcutQuery');
    expect(background).toContain('onInstalled');
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
    expect(options).toContain("settings.engineSource !== 'local-server'");
    expect(options).toContain('tierLabel');
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
    expect(client).toContain('ensureSource');
    expect(background).toContain('client.setSource');
    expect(host).toContain('new JobScheduler(localRuntime.parallel, false)');
    expect(host).toContain('browser.storage?.local');
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
