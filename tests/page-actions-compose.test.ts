import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { pickFocusedFrameId } from '@/background/page-actions';

describe('compose context menu', () => {
  it('keeps the editable item always visible instead of hiding it after open', () => {
    const source = readFileSync(
      new URL('../src/background/page-actions.ts', import.meta.url),
      'utf8',
    );
    expect(source).not.toContain('setComposeMenuEnabled');
    expect(source).not.toMatch(/visible:\s*composeMenuEnabled/);
    expect(source).toContain("contexts: ['editable']");
  });
});

describe('compose command routing', () => {
  it('picks the frame whose document has a focused control', () => {
    expect(
      pickFocusedFrameId([
        { frameId: 0, result: false },
        { frameId: 2, result: true },
        { frameId: 7, result: true },
      ]),
    ).toBe(2);
    expect(pickFocusedFrameId([{ frameId: 0, result: false }])).toBeUndefined();
  });

  it('injects compose into every frame and sends the command to the focused one', () => {
    const actions = readFileSync(
      new URL('../src/background/page-actions.ts', import.meta.url),
      'utf8',
    );
    const messages = readFileSync(new URL('../src/shared/messages.ts', import.meta.url), 'utf8');
    const bridge = readFileSync(new URL('../src/shared/page-bridge.ts', import.meta.url), 'utf8');
    const content = readFileSync(new URL('../src/entrypoints/content.ts', import.meta.url), 'utf8');
    expect(actions).toContain('noteShortcutCommandAssigned');
    expect(actions).toContain('handleShortcutCommand');
    expect(actions).toContain('lastFocusedWindow');
    expect(actions).toContain("const allFrames = command === 'compose'");
    expect(actions).toContain('allFrames: true');
    expect(actions).toContain('document.hasFocus()');
    expect(actions).toContain('requestPageCommand(tabId, command, frameId)');
    expect(messages).toContain('frameId?: number');
    expect(messages).toContain('{ frameId }');
    expect(bridge).toContain('allFrames?: boolean');
    expect(content).toContain('shouldHandleComposeCommand(document)');
  });

  it('does not let a cleared Chrome binding block popup or context-menu page commands', () => {
    const content = readFileSync(new URL('../src/entrypoints/content.ts', import.meta.url), 'utf8');
    expect(content).not.toContain('commandEnabled(');
    expect(content).toContain('commands.onCommand');
  });
});

describe('caption auto-inject', () => {
  it('injects youtube.com and x.com tabs when the caption setting is on', () => {
    const actions = readFileSync(
      new URL('../src/background/page-actions.ts', import.meta.url),
      'utf8',
    );
    const background = readFileSync(
      new URL('../src/entrypoints/background.ts', import.meta.url),
      'utf8',
    );
    expect(actions).toContain('injectIfCaptions');
    expect(actions).toContain('shouldAutoInjectCaptions');
    expect(actions).toContain('injectCaptionPages');
    expect(background).toContain('injectCaptionPages');
    expect(background).toContain('settings.translateVideoCaptions');
    expect(background).toContain('syncCaptionCustomContentScripts');
  });

  it('requests optional YouTube and X origins from the caption setting checkbox', () => {
    const fields = readFileSync(
      new URL('../src/ui/SettingsFields.svelte', import.meta.url),
      'utf8',
    );
    const popup = readFileSync(
      new URL('../src/entrypoints/popup/App.svelte', import.meta.url),
      'utf8',
    );
    expect(fields).toContain('resolveCaptionToggle');
    expect(fields).toContain('translateVideoCaptions');
    expect(popup).toContain('resolveCaptionToggle');
    expect(popup).toContain('settleCaptionEnableIntent');
    expect(popup).toContain('videoCaptionsSetting');
    expect(popup).toContain('data-sakutto="video-captions"');
    expect(fields).toContain('data-sakutto="video-captions"');
    expect(fields).toContain('data-sakutto="video-captions-original"');
    expect(fields).toContain('type="range"');
    expect(fields).toContain('requestCaptionCustomHostAccess');
    const addStart = fields.indexOf('function addCustomHost');
    const addBody = fields.slice(addStart, fields.indexOf('function removeCustomHost'));
    const beforeRequest = addBody.slice(0, addBody.indexOf('await requestCaptionCustomHostAccess'));
    expect(beforeRequest).not.toMatch(/\bawait\b/);
    const register = readFileSync(
      new URL('../src/captions/register-custom.ts', import.meta.url),
      'utf8',
    );
    expect(register).toContain('registerContentScripts');
    expect(register).toContain('permissions.request');
    const background = readFileSync(
      new URL('../src/entrypoints/background.ts', import.meta.url),
      'utf8',
    );
    expect(background).toContain('permissions.onAdded');
    expect(background).toContain('settleCaptionEnableIntent');
  });
});
