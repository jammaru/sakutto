export const DEFAULT_SENTENCE_THRESHOLD = 250;
export const DEFAULT_MAX_CHUNK_CHARS = 450;
/**
 * About 150 source tokens of English: a full paragraph of most articles. Larger pieces keep
 * more context but hold the first token back by their whole prefill, which on the CPU
 * runtime costs nearly as much per token as decoding does.
 */
export const DEFAULT_PIECE_CHARS = 600;

const NO_SPACE_TARGETS: ReadonlySet<string> = new Set(['ja', 'zh-hans', 'zh-hant', 'th']);

const TERMINATORS: ReadonlySet<string> = new Set(['.', '!', '?', '。', '！', '？', '…']);
const CLOSERS: ReadonlySet<string> = new Set([
  '"',
  "'",
  '”',
  '’',
  ')',
  ']',
  '}',
  '）',
  '］',
  '」',
  '』',
  '】',
  '〕',
  '〉',
  '》',
]);

const ABBREVIATIONS: ReadonlySet<string> = new Set([
  'approx',
  'corp',
  'dept',
  'dr',
  'e.g',
  'est',
  'etc',
  'fig',
  'i.e',
  'inc',
  'jr',
  'ltd',
  'mr',
  'mrs',
  'ms',
  'no',
  'prof',
  'sr',
  'st',
  'u.k',
  'u.s',
  'vol',
  'vs',
]);

interface TextRange {
  start: number;
  end: number;
}

export interface SentenceSplitOptions {
  sentenceThreshold?: number;
  maxChunkChars?: number;
}

function findProtectedRanges(text: string): TextRange[] {
  const ranges: TextRange[] = [];

  const patterns = [
    /(?:https?:\/\/|www\.)[^\s<>"'）)】」』]+/giu,
    /[^\s<>()"']+@[^\s<>()"']+\.[a-z]{2,}/giu,
    /<\/?[A-Za-z][\w-]*\d*>/g,
  ];

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      if (match.index === undefined) continue;
      ranges.push({ start: match.index, end: match.index + match[0].length });
    }
  }

  return ranges.sort((a, b) => a.start - b.start);
}

function insideRange(ranges: readonly TextRange[], index: number): boolean {
  return ranges.some((range) => index >= range.start && index < range.end);
}

function isAsciiWordCharacter(character: string): boolean {
  return /[A-Za-z0-9_]/u.test(character);
}

function isAbbreviation(text: string, periodIndex: number): boolean {
  let start = periodIndex;

  while (start > 0 && /[A-Za-z.&]/.test(text[start - 1] ?? '')) start -= 1;
  const word = text
    .slice(start, periodIndex)
    .toLowerCase()
    .replace(/^[("\u2018\u201c]+/u, '');

  return word.length > 0 && (ABBREVIATIONS.has(word) || /^[a-z]$/u.test(word));
}

function isCjkTerminator(character: string): boolean {
  return character !== '.' && character !== '!' && character !== '?';
}

function splitRawSentences(text: string, ranges: readonly TextRange[]): string[] {
  const sentences: string[] = [];
  let start = 0;
  let index = 0;

  while (index < text.length) {
    const character = text[index] ?? '';
    if (!TERMINATORS.has(character) || insideRange(ranges, index)) {
      index += 1;
      continue;
    }

    let end = index + 1;
    while (end < text.length && TERMINATORS.has(text[end] ?? '')) end += 1;
    while (end < text.length && CLOSERS.has(text[end] ?? '')) end += 1;

    const next = text[end];
    const followedBySpace = next === undefined || /\s/u.test(next);
    const cjkBreak =
      isCjkTerminator(character) && next !== undefined && !isAsciiWordCharacter(next);
    if (!followedBySpace && !cjkBreak) {
      index = end;
      continue;
    }

    if (character === '.' && isAbbreviation(text, index)) {
      index = end;
      continue;
    }

    const before = text[index - 1] ?? '';
    if (character === '.' && /\d/u.test(before) && next !== undefined && /\d/u.test(next)) {
      index = end;
      continue;
    }

    const sentence = text.slice(start, end).trim();
    if (sentence.length > 0) sentences.push(sentence);
    start = end;
    index = end;
  }

  const rest = text.slice(start).trim();
  if (rest.length > 0) sentences.push(rest);

  return sentences;
}

function tagDepth(text: string): number {
  let depth = 0;
  for (const match of text.matchAll(/<(\/?)([A-Za-z][\w-]*\d*)>/g)) {
    if (match[1] === '/') {
      depth = Math.max(0, depth - 1);
    } else {
      depth += 1;
    }
  }
  return depth;
}

function joinChunks(left: string, right: string): string {
  const needsSpace = !/[\s\u3000-\u303f\uff00-\uffef]$/u.test(left);
  return needsSpace ? `${left} ${right}` : `${left}${right}`;
}

function mergeUnbalanced(chunks: readonly string[]): string[] {
  const merged: string[] = [];
  let current = '';

  for (const chunk of chunks) {
    current = current.length > 0 ? joinChunks(current, chunk) : chunk;
    if (tagDepth(current) === 0) {
      merged.push(current);
      current = '';
    }
  }

  if (current.length > 0) merged.push(current);
  return merged;
}

function findSplitIndex(text: string, limit: number): number {
  let depth = 0;
  let bestSpace = -1;
  let bestSafe = -1;
  let index = 0;

  while (index < text.length) {
    if (text[index] === '<') {
      const end = text.indexOf('>', index + 1);
      if (end !== -1 && end > index + 1) {
        const tag = text.slice(index, end + 1);
        if (/^<\/[A-Za-z][\w-]*\d*>$/u.test(tag)) {
          depth = Math.max(0, depth - 1);
        } else if (/^<[A-Za-z][\w-]*\d*>$/u.test(tag)) {
          depth += 1;
        }
        index = end + 1;
        continue;
      }
    }

    if (depth === 0 && index <= limit && index > 0) {
      bestSafe = index;
      if (/\s/u.test(text[index] ?? '')) bestSpace = index;
    }
    index += 1;
  }

  return bestSpace > 0 ? bestSpace : bestSafe;
}

function splitLongChunk(chunk: string, maxChunkChars: number): string[] {
  if (chunk.length <= maxChunkChars) return [chunk];

  const pieces: string[] = [];
  let rest = chunk;

  while (rest.length > maxChunkChars) {
    const splitIndex = findSplitIndex(rest, maxChunkChars);
    if (splitIndex <= 0) break;
    const piece = rest.slice(0, splitIndex).trim();
    if (piece.length > 0) pieces.push(piece);
    rest = rest.slice(splitIndex).trim();
  }

  if (rest.length > 0) pieces.push(rest);
  return pieces;
}

/**
 * Splits a paragraph that is longer than the sentence threshold. Placeholder tags are kept
 * inside one piece and hard splits happen only at tag depth zero.
 */
export function splitForTranslation(text: string, options: SentenceSplitOptions = {}): string[] {
  const sentenceThreshold = options.sentenceThreshold ?? DEFAULT_SENTENCE_THRESHOLD;
  const maxChunkChars = options.maxChunkChars ?? DEFAULT_MAX_CHUNK_CHARS;
  const trimmed = text.trim();

  if (trimmed.length === 0) return [];
  if (trimmed.length <= sentenceThreshold) return [trimmed];

  const ranges = findProtectedRanges(trimmed);
  const merged = mergeUnbalanced(splitRawSentences(trimmed, ranges));
  return merged.flatMap((chunk) => splitLongChunk(chunk, maxChunkChars));
}

/**
 * Splits text only when it is longer than one ordinary paragraph, and then into runs of whole
 * sentences rather than single sentences. Each piece becomes its own prompt, so the model
 * sees a sentence together with its neighbours, as it does when it translates a paragraph,
 * and no piece depends on the model echoing back a line structure.
 */
export function chunkForTranslation(text: string, maxChars = DEFAULT_PIECE_CHARS): string[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];
  if (trimmed.length <= maxChars) return [trimmed];

  const sentences = mergeUnbalanced(splitRawSentences(trimmed, findProtectedRanges(trimmed)));
  const pieces: string[] = [];
  let current = '';
  for (const sentence of sentences.flatMap((chunk) => splitLongChunk(chunk, maxChars))) {
    const joined = current.length > 0 ? joinChunks(current, sentence) : sentence;
    if (current.length > 0 && joined.length > maxChars) {
      pieces.push(current);
      current = sentence;
      continue;
    }
    current = joined;
  }
  if (current.length > 0) pieces.push(current);
  return pieces;
}

export function sentenceSeparator(tgt: string): string {
  return NO_SPACE_TARGETS.has(tgt.trim().toLowerCase()) ? '' : ' ';
}

export function joinTranslatedSentences(parts: readonly string[], tgt: string): string {
  const cleaned = parts.map((part) => part.trim()).filter((part) => part.length > 0);
  if (cleaned.length === 0) return '';

  return cleaned.join(sentenceSeparator(tgt));
}
