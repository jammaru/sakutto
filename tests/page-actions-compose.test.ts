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
    expect(actions).toContain("const allFrames = command === 'compose'");
    expect(actions).toContain('allFrames: true');
    expect(actions).toContain('document.hasFocus()');
    expect(actions).toContain('requestPageCommand(tabId, command, frameId)');
    expect(messages).toContain('frameId?: number');
    expect(messages).toContain('{ frameId }');
    expect(bridge).toContain('allFrames?: boolean');
    expect(content).toContain('shouldHandleComposeCommand(document)');
  });
});
