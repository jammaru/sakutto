/**
 * First-page bylines: person names, affiliations, and emails.
 *
 * Those strings are identity, not prose. Translating them transliterates a name or a
 * workplace, which is the wrong thing to put on the page. A title is not a byline: it is
 * larger than the body, and it is translated faithfully rather than shortened.
 */

const EMAIL = /[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/u;

const AFFILIATION =
  /\b(?:University|Universität|Universit[eé]|Institute|Institut|Department|Dept\.|Laboratory|Laboratoire|College|School of|Faculty of|Graduate School|Inc\.|Ltd\.|GmbH|Corp\.|Foundation|Hospital|Center for|Centre for|Research (?:Center|Centre|Lab)|Academy of|Correspondence|Corresponding author|Equal contribution|Independent researcher|Work done at|ORCID)\b/iu;

const SECTION =
  /^(?:Abstract|Introduction|Related Work|Conclusion|References|Acknowledgments?|Appendix|Summary|Keywords?|Contents|Overview|Background|Method|Methods|Results|Discussion|Limitations)\b/iu;

const SECTION_HEADING =
  /^(?:Abstract|Introduction|Related Work|Conclusion|References|Acknowledgments?|Appendix|Summary|Keywords?|Contents|Overview|Background|Method|Methods|Results|Discussion|Limitations)\s*:?\s*$/iu;

const BYLINE_LABEL = /^(?:Authors?|Affiliations?|E-?mails?)\s*:?\s*$/iu;

/** A superscript marker or membership role that only appears in a paper's author line. */
const AUTHOR_MARK = /[*†‡§¶⁎∗]|\b(?:Non)?members?\b/iu;

/** Function words that belong in a title, not in a person's name. */
const TITLE_STOP =
  /^(?:The|A|An|Is|Are|Was|Were|For|Of|To|In|On|With|From|By|Or|Not|All|You|We|This|That|These|Those|How|What|Why|When|Where)\b/u;

const PARTICLE = /^(?:and|von|van|de|del|da|di|la|le|bin|al|der|den|dos|das)\b/iu;

/** True when a string is an email, an affiliation, or a list of person names. */
export function isIdentityText(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  if (isBylineLabel(trimmed)) return true;
  if (EMAIL.test(trimmed)) return true;
  if (AFFILIATION.test(trimmed) && trimmed.length <= 140) return true;
  return isNameLine(trimmed);
}

/** True when a block is a section title such as Abstract, not a byline. */
export function isSectionHeading(text: string): boolean {
  return SECTION_HEADING.test(text.trim());
}

/** True when a block is an Author / Affiliation / Email label rather than a heading. */
export function isBylineLabel(text: string): boolean {
  return BYLINE_LABEL.test(text.trim());
}

/**
 * True when a name line carries an author marker, such as a superscript or a membership role.
 * A title does not carry those markers, so it stays a translated heading on any page.
 */
export function isMarkedAuthorLine(text: string): boolean {
  const trimmed = text.trim();
  if (!AUTHOR_MARK.test(trimmed)) return false;
  return isIdentityText(trimmed);
}

/**
 * True when a first-page block above the abstract is a byline rather than a title or a
 * paragraph. Later pages, the lower half of the first page, and type larger than the body
 * are left to the ordinary role rules.
 */
export function isFirstPageIdentity(
  text: string,
  options: {
    pageIndex: number;
    y: number;
    pageHeight: number;
    fontSize: number;
    bodySize: number;
  },
): boolean {
  if (options.pageIndex !== 0) return false;
  if (options.pageHeight > 0 && options.y > options.pageHeight * 0.48) return false;
  if (options.bodySize > 0 && options.fontSize >= options.bodySize * 1.28) return false;
  if (isSectionHeading(text) || SECTION.test(text.trim())) return false;
  return isIdentityText(text);
}

function isNameLine(text: string): boolean {
  if (SECTION.test(text)) return false;
  if (text.length < 4 || text.length > 96) return false;
  if (/[.!?]$/u.test(text) && !/[A-Z]\.$/u.test(text)) return false;
  const cleaned = text
    .replace(/[*†‡§¶⁎∗]+/gu, ' ')
    .replace(/\b\d{1,2}\b/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  if (cleaned.length < 4) return false;

  const groups = cleaned
    .split(/\s*(?:,|;|&| and )\s*/iu)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (groups.length === 0) return false;
  // A title is one long phrase; a byline is one name or a short list of them.
  if (groups.length === 1) {
    const words = groups[0]?.split(/\s+/u) ?? [];
    // A lone capitalised word is a label or a table header, not a byline.
    if (words.length < 2 || words.length > 4) return false;
    if (words.some((word) => TITLE_STOP.test(word))) return false;
    return looksLikeName(groups[0] ?? '');
  }
  return groups.every((group) => looksLikeName(group));
}

function looksLikeName(phrase: string): boolean {
  const words = phrase.split(/\s+/u).filter(Boolean);
  if (words.length < 1 || words.length > 5) return false;
  let nameWords = 0;
  for (const word of words) {
    if (PARTICLE.test(word)) continue;
    if (/^[A-Z]\.$/u.test(word) || /^[A-Z]$/u.test(word)) {
      nameWords += 1;
      continue;
    }
    if (/^\p{Lu}[\p{Ll}'’-]+$/u.test(word) && word.length >= 2) {
      nameWords += 1;
      continue;
    }
    return false;
  }
  return nameWords >= 1 && nameWords <= 5;
}
