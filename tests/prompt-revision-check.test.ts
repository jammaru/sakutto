import { describe, expect, it } from 'vitest';
import { getModel } from '@/engine/model/catalog';
import { buildTranslationPrompt, cleanModelOutput, PFML3 } from '@/engine/prompt/pfml3';

const PAIRS: readonly { text: string; src: string; tgt: string }[] = [
  { text: 'The translation model is ready.', src: 'en', tgt: 'ja' },
  { text: 'Open the dashboard and review the results.', src: 'en', tgt: 'ja' },
  { text: '翻訳モデルを新しいリビジョンに更新しました。', src: 'ja', tgt: 'en' },
];

function expectedPrompt(text: string, src: string, tgt: string): string {
  return (
    `${PFML3.tag}dataset${PFML3.msg}translation` +
    `${PFML3.tag}input${PFML3.key}lang${PFML3.val}${src}${PFML3.msg}${text}` +
    `${PFML3.tag}output${PFML3.key}lang${PFML3.val}${tgt}${PFML3.msg}`
  );
}

describe('PFML3 prompts across GGUF revisions', () => {
  it('builds explicit EN→JA and JA→EN prompts for fixed strings', () => {
    for (const pair of PAIRS) {
      const prompt = buildTranslationPrompt({ text: pair.text, src: pair.src, tgt: pair.tgt });
      expect(prompt).toBe(expectedPrompt(pair.text, pair.src, pair.tgt));
      expect(prompt.startsWith('<|plamo:bos|>')).toBe(false);
    }
  });

  it('does not vary the prompt with the installed model revision', () => {
    const entry = getModel('plamo-3-translate-0.8b-q4_k_m');
    expect(entry.revisions).toHaveLength(6);
    for (const pair of PAIRS) {
      const prompts = entry.revisions.map(() =>
        buildTranslationPrompt({ text: pair.text, src: pair.src, tgt: pair.tgt }),
      );
      expect(new Set(prompts).size).toBe(1);
    }
  });

  it('still strips the stop marker from model output', () => {
    expect(cleanModelOutput(`翻訳結果${PFML3.tag}ignored`)).toBe('翻訳結果');
    expect(cleanModelOutput('Translated text<|plamo:bos|>')).toBe('Translated text');
  });
});
