/**
 * A small client for a local `llama-server` running PLaMo 3 Translate, used to draft a UI
 * catalog. This is a maintainer tool, not part of the extension: the extension talks to its own
 * wllama worker, and nothing here is bundled.
 *
 * Start a server that has the model on the GPU:
 *
 *   llama-server -m plamo-3-translate-0.8b-Q4_K_M.gguf -ngl 99 -c 4096 --port 11501
 *
 * The prompt is the same PFML3 form as `src/engine/prompt/pfml3.ts`. It is repeated here rather
 * than imported because this file runs on plain Node without the extension's path aliases, and
 * the format is small enough that duplicating it is clearer than a build step.
 */

const TAG = '<|plamo:tag|>';
const MSG = '<|plamo:msg|>';
const KEY = '<|plamo:key|>';
const VAL = '<|plamo:val|>';

export const BASE = process.env.SAKUTTO_PLAMO_URL ?? 'http://127.0.0.1:11501';

/**
 * @typedef {object} PromptParts
 * @property {string} text
 * @property {string} tgt  Target language in the model's spelling, e.g. `ko`, `zh-hans`, `pt-BR`.
 * @property {string} [src]
 * @property {string} [glossary]  Keeps names and technical terms untranslated.
 */

/**
 * @param {PromptParts} parts
 * @returns {string}
 */
export function buildPrompt({ text, tgt, src, glossary }) {
  let prompt = `${TAG}dataset${MSG}translation`;

  if (glossary && glossary.trim().length > 0) {
    prompt += `${TAG}context${MSG}Keep these as they are: ${glossary}`;
  }

  prompt += `${TAG}input`;
  if (src) prompt += `${KEY}lang${VAL}${src}`;
  prompt += `${MSG}${text}`;
  prompt += `${TAG}output${KEY}lang${VAL}${tgt}`;
  return `${prompt}${MSG}`;
}

/**
 * @param {PromptParts} parts
 * @returns {Promise<string>}
 */
export async function translate(parts) {
  const response = await fetch(`${BASE}/completion`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      prompt: buildPrompt(parts),
      temperature: 0,
      top_k: 1,
      n_predict: 384,
      stream: false,
      cache_prompt: false,
      stop: [TAG, '<|plamo:bos|>'],
    }),
  });

  if (!response.ok) {
    throw new Error(
      `llama-server returned HTTP ${String(response.status)}: ${await response.text()}`,
    );
  }

  const json = await response.json();
  return (json.content ?? '').trim();
}

/** Names that must survive translation unchanged. */
export const GLOSSARY =
  'Sakutto, PLaMo, PLaMo 3 Translate, PFN, Preferred Networks, Chrome, WebGPU, CPU, GPU, ' +
  'LLM, CSV, NOTICE, MIT License, HTTP, tokens/s, tok/s, seg/s, n_parallel';
