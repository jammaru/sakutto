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

  it('gates the popup translate button on the model the same way', () => {
    expect(popup).toContain('modelStartBlocked');
    expect(popup).toMatch(/canStart[\s\S]{0,200}isChromeOnlyLanguage\(targetLanguage\)/);
    expect(popup).toMatch(/disabled=\{[^}]*!canStart[^}]*\}/);
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
 * Chrome decides which keys run a command and has no API for changing them, so the only way
 * to let a reader rebind one is to send them to Chrome's own editor. A settings screen that
 * showed a key it could not change, or offered an edit box of its own, would be lying.
 */
describe('shortcut settings', () => {
  const shortcuts = source('ui/ShortcutSettings.svelte');
  const options = source('entrypoints/options/App.svelte');

  it('reads the keys Chrome has bound instead of the manifest defaults', () => {
    expect(shortcuts).toContain('requestShortcutSnapshot');
    expect(shortcuts).toContain('displayShortcut');
    expect(shortcuts).not.toContain("'Alt+A'");
  });

  it('hands the reader to Chrome for the change itself', () => {
    expect(shortcuts).toContain('openShortcutEditor');
    expect(shortcuts).toContain('shortcutChange');
    // No key capture of its own: Chrome owns the bindings.
    expect(shortcuts).not.toMatch(/onkeydown|addEventListener\('keydown'/u);
  });

  it('says a command has no key rather than showing an empty box', () => {
    expect(shortcuts).toContain('shortcutUnset');
  });

  it('is on the settings page', () => {
    expect(options).toContain('ShortcutSettings');
    expect(options).toContain('shortcutHeading');
  });
});
