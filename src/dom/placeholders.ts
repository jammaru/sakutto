export type PlaceholderPart =
  { type: 'text'; value: string } | { type: 'tag'; id: string; children: PlaceholderPart[] };

const TAG_PATTERN = /^<(\/?)(i\d+)>/;

const ENTITY_PATTERN = /&(?:amp|lt|gt|quot|#39);/g;

const ENTITIES: Readonly<Record<string, string>> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
};

function decodeEntities(value: string): string {
  return value.replace(ENTITY_PATTERN, (entity) => ENTITIES[entity] ?? entity);
}

/**
 * Parses placeholder tags produced for inline elements. Tags outside the allow-list or an
 * unbalanced tree fail closed so the caller can keep the original nodes.
 */
export function parsePlaceholders(
  source: string,
  allowed: ReadonlySet<string>,
): PlaceholderPart[] | null {
  const parts: PlaceholderPart[] = [];
  const stack: { id: string; parts: PlaceholderPart[] }[] = [];
  let index = 0;
  let buffer = '';

  const flush = (): void => {
    if (buffer.length === 0) return;
    const target = stack.length > 0 ? stack[stack.length - 1]!.parts : parts;
    target.push({ type: 'text', value: decodeEntities(buffer) });
    buffer = '';
  };

  while (index < source.length) {
    const open = source.indexOf('<', index);
    if (open === -1) {
      buffer += source.slice(index);
      break;
    }

    buffer += source.slice(index, open);
    const match = TAG_PATTERN.exec(source.slice(open));
    const id = match?.[2];
    if (!match || !id || !allowed.has(id)) {
      buffer += '<';
      index = open + 1;
      continue;
    }

    flush();
    if (match[1] === '/') {
      const current = stack.pop();
      if (!current || current.id !== id) return null;
      const node: PlaceholderPart = { type: 'tag', id, children: current.parts };
      const target = stack.length > 0 ? stack[stack.length - 1]!.parts : parts;
      target.push(node);
    } else {
      stack.push({ id, parts: [] });
    }
    index = open + match[0].length;
  }

  if (stack.length > 0) return null;
  flush();
  return parts;
}

export function serializePlaceholders(parts: readonly PlaceholderPart[]): string {
  let output = '';

  for (const part of parts) {
    output +=
      part.type === 'text'
        ? part.value
        : `<${part.id}>${serializePlaceholders(part.children)}</${part.id}>`;
  }

  return output;
}

/** Removes complete and truncated placeholder tokens such as `<i1` or `</i2>`. */
export function stripPlaceholderTokens(value: string): string {
  return value.replace(/<\/?i\d+\s*>?/g, '');
}

function hasStrayPlaceholder(output: string, allowed: ReadonlySet<string>): boolean {
  const rest = output.replace(/<\/?(i\d+)>/g, (match, id: string) =>
    allowed.has(id) ? '' : match,
  );
  return /<\/?i\d+\s*>?/.test(rest);
}

function collectIds(parts: readonly PlaceholderPart[]): string[] {
  const ids: string[] = [];
  const visit = (nodes: readonly PlaceholderPart[]): void => {
    for (const node of nodes) {
      if (node.type === 'text') continue;
      ids.push(node.id);
      visit(node.children);
    }
  };
  visit(parts);
  return ids;
}

export interface TranslationMarkup {
  ok: boolean;
  text: string;
  plain: string;
}

/**
 * A usable translation uses each allowed placeholder once, and nowhere else.
 * Anything else becomes plain text with the tokens removed.
 */
export function assessTranslation(output: string, allowed: ReadonlySet<string>): TranslationMarkup {
  const plain = stripPlaceholderTokens(output)
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
  if (hasStrayPlaceholder(output, allowed)) return { ok: false, text: plain, plain };
  if (allowed.size === 0) return { ok: true, text: output.trim(), plain };

  const parsed = parsePlaceholders(output, allowed);
  if (!parsed) return { ok: false, text: plain, plain };
  const ids = collectIds(parsed);
  if (ids.length !== allowed.size || new Set(ids).size !== ids.length) {
    return { ok: false, text: plain, plain };
  }
  for (const id of allowed) {
    if (!ids.includes(id)) return { ok: false, text: plain, plain };
  }
  return { ok: true, text: output.trim(), plain };
}

export function visibleTranslation(value: string): string {
  return stripPlaceholderTokens(value);
}
