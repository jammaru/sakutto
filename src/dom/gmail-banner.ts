import { chunkForTranslation, joinTranslatedSentences } from '@/engine/text/sentences';
import type { GlossaryEntry } from '@/engine/types';
import type { Formality } from '@/shared/settings';
import { listTranslatableBlocks } from './blocks';
import { canonicalPageLanguage, inferLanguage, isAlreadyTargetLanguage } from './detect';
import { translationPriority } from './priority';
import { assessTranslation, stripPlaceholderTokens } from './placeholders';
import { applyTranslation, restoreSegment } from './render';
import { buildSegment, placeholderIds, visibleOriginal, type SegmentModel } from './segment';
import type { PageEngine } from './session';

/** A body this short is a greeting or a signature, not enough prose to identify. */
export const GMAIL_MIN_BODY_CHARS = 24;

const GMAIL_BODY_SELECTOR = 'div.a3s, .a3s.aiL';
const COMPOSE_SELECTOR = [
  'textarea',
  'input',
  'select',
  '[contenteditable]:not([contenteditable="false"])',
  '[role="textbox"]',
].join(', ');

export const GMAIL_BANNER_TAG = 'sakutto-gmail';

export function isGmailHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === 'mail.google.com' || normalized.endsWith('.mail.google.com');
}

export function shouldAutoInjectGmailBanner(options: {
  settingOn: boolean;
  host: string;
  originAllowed: boolean;
}): boolean {
  return options.settingOn && options.originAllowed && isGmailHost(options.host);
}

export function isGmailMessageBody(element: Element): boolean {
  if (!element.matches(GMAIL_BODY_SELECTOR)) return false;
  if (element.closest(COMPOSE_SELECTOR)) return false;
  if (element.closest('[aria-hidden="true"]')) return false;
  return true;
}

export function findGmailMessageBodies(root: ParentNode): Element[] {
  const bodies = new Set<Element>();
  if (root instanceof Element && isGmailMessageBody(root)) bodies.add(root);
  for (const element of root.querySelectorAll(GMAIL_BODY_SELECTOR)) {
    if (isGmailMessageBody(element)) bodies.add(element);
  }
  return [...bodies];
}

export function gmailMessageKey(body: Element): string {
  const row = body.closest('[data-message-id], [data-legacy-message-id]');
  return row?.getAttribute('data-message-id') ?? row?.getAttribute('data-legacy-message-id') ?? '';
}

export interface GmailBannerGate {
  text: string;
  language: string | null;
  targetLanguage: string;
  minChars?: number;
}

/**
 * Whether a message body earns a banner. The source must be long enough to identify and
 * must differ from the target. Easy Japanese has the script of Japanese, so a Japanese
 * email does not offer to translate itself into Easy Japanese.
 */
export function shouldOfferGmailTranslation(input: GmailBannerGate): boolean {
  const text = input.text.replace(/\s+/gu, ' ').trim();
  if (text.length < (input.minChars ?? GMAIL_MIN_BODY_CHARS)) return false;
  if (!/\p{L}/u.test(text)) return false;
  const source = canonicalPageLanguage(input.language);
  const target = canonicalPageLanguage(input.targetLanguage);
  return source !== null && target !== null && source !== target;
}

export type GmailBannerPhase = 'offer' | 'translating' | 'translated';

export interface GmailBannerState {
  phase: GmailBannerPhase;
  dismissed: boolean;
}

export type GmailBannerButton = 'translate' | 'show-original' | 'busy';

export function initialGmailBannerState(): GmailBannerState {
  return { phase: 'offer', dismissed: false };
}

export function gmailBannerButton(state: GmailBannerState): GmailBannerButton | null {
  if (state.dismissed) return null;
  if (state.phase === 'translating') return 'busy';
  if (state.phase === 'translated') return 'show-original';
  return 'translate';
}

export function gmailBannerAfterTranslate(state: GmailBannerState): GmailBannerState {
  if (state.dismissed || state.phase !== 'offer') return state;
  return { ...state, phase: 'translating' };
}

export function gmailBannerAfterTranslated(state: GmailBannerState): GmailBannerState {
  if (state.dismissed || state.phase !== 'translating') return state;
  return { ...state, phase: 'translated' };
}

export function gmailBannerAfterShowOriginal(state: GmailBannerState): GmailBannerState {
  if (state.dismissed || state.phase !== 'translated') return state;
  return { ...state, phase: 'offer' };
}

export function gmailBannerAfterDismiss(state: GmailBannerState): GmailBannerState {
  // Dismissal only hides the banner. The controller restores the translated body
  // before calling this, so the phase does not need to change.
  return { ...state, dismissed: true };
}

const NON_LATIN_TARGETS: ReadonlySet<string> = new Set([
  'ja',
  'zh-hans',
  'zh-hant',
  'ko',
  'ru',
  'ar',
  'th',
  'he',
  'hi',
  'bn',
  'gu',
  'ml',
  'mr',
  'ne',
  'pa',
  'si',
  'ta',
  'te',
  'ur',
  'my',
  'km',
  'fa',
  'be',
  'bg',
  'kk',
  'hy',
  'ka',
]);

/**
 * Gmail's `<html lang>` is the interface language, not the language of the message body,
 * so the message has to be read on its own. The body's own `lang` wins; then the shared
 * script heuristic; then a small stop-word vote for Latin-script prose; and finally a
 * wrapper that covers most of the body.
 */
export function detectGmailMessageLanguage(body: Element, targetLanguage: string): string | null {
  const own = canonicalPageLanguage(body.getAttribute('lang'));
  if (own) return own;

  const text = visibleOriginal(body);
  const inferred = inferLanguage(text);
  if (inferred) return inferred;

  const latin = guessLatinLanguage(text);
  if (latin) return latin;

  const descendant = descendantMessageLanguage(body, text.length);
  if (descendant) return descendant;

  // Latin prose cannot be a non-Latin target, and a Japanese/Chinese/Korean reader is
  // exactly the case this banner is for. The label may be approximate for a rare language,
  // but leaving the banner hidden is worse than naming the likely source.
  if (isNonLatinTarget(targetLanguage) && hasLatinLetters(text)) return 'en';
  return null;
}

/**
 * A wrapper around the whole message may declare the language instead of the body itself.
 * A small quoted snippet with its own `lang` must not decide the whole message, so only a
 * tag covering at least half of the body counts.
 */
function descendantMessageLanguage(body: Element, bodyLength: number): string | null {
  let best: { language: string; length: number } | null = null;
  let checked = 0;
  for (const tagged of body.querySelectorAll('[lang]')) {
    if (checked >= 20) break;
    checked += 1;
    const length = (tagged.textContent ?? '').trim().length;
    if (length === 0 || length * 2 < bodyLength) continue;
    const language = canonicalPageLanguage(tagged.getAttribute('lang'));
    if (language && (!best || length > best.length)) best = { language, length };
  }
  return best?.language ?? null;
}

function isNonLatinTarget(targetLanguage: string): boolean {
  const canonical = canonicalPageLanguage(targetLanguage);
  return canonical !== null && NON_LATIN_TARGETS.has(canonical);
}

function hasLatinLetters(text: string): boolean {
  return /[A-Za-z]/u.test(text);
}

const LATIN_STOPWORDS: ReadonlyMap<string, ReadonlySet<string>> = new Map(
  Object.entries({
    en: [
      'the',
      'and',
      'you',
      'your',
      'are',
      'for',
      'with',
      'this',
      'that',
      'have',
      'not',
      'from',
      'will',
      'can',
      'our',
      'was',
      'were',
      'they',
      'but',
      'about',
      'would',
      'there',
      'what',
      'when',
      'which',
      'has',
      'been',
      'more',
      'just',
      'please',
      'thanks',
      'thank',
      'hello',
      'hi',
      'we',
      'us',
      'is',
      'it',
      'to',
      'of',
      'in',
      'on',
      'at',
      'as',
      'be',
      'by',
      'or',
      'if',
      'so',
      'my',
      'me',
      'he',
      'she',
      'his',
      'her',
      'do',
      'did',
      'does',
      'how',
      'all',
      'one',
      'two',
      'get',
      'got',
      'let',
      'know',
      'think',
      'need',
      'want',
      'make',
      'see',
      'come',
      'go',
      'going',
      'good',
      'new',
      'day',
      'today',
      'tomorrow',
      'week',
      'time',
      'email',
      'message',
      'meeting',
      'team',
      'work',
      'help',
      'regards',
      'best',
    ],
    es: [
      'los',
      'las',
      'una',
      'unos',
      'unas',
      'que',
      'por',
      'para',
      'con',
      'como',
      'pero',
      'más',
      'este',
      'esta',
      'estos',
      'estas',
      'son',
      'está',
      'están',
      'hay',
      'muy',
      'también',
      'desde',
      'hasta',
      'entre',
      'cuando',
      'donde',
      'quien',
      'quién',
      'porque',
      'sobre',
      'puede',
      'puedes',
      'tengo',
      'tiene',
      'hola',
      'gracias',
      'saludos',
      'correo',
      'mensaje',
      'reunión',
      'equipo',
      'trabajo',
      'hoy',
      'mañana',
      'semana',
      'día',
      'buenos',
      'buenas',
      'días',
      'tardes',
      'nosotros',
      'ellos',
      'ellas',
      'usted',
      'ustedes',
      'ser',
      'estar',
      'fue',
      'era',
      'han',
      'he',
      'ha',
      'su',
      'sus',
      'nuestro',
      'nuestra',
      'si',
      'sí',
      'no',
      'ya',
      'aquí',
      'allí',
      'todo',
      'todos',
      'toda',
      'todas',
      'nos',
    ],
    fr: [
      'les',
      'des',
      'une',
      'unes',
      'que',
      'qui',
      'quoi',
      'pour',
      'par',
      'avec',
      'dans',
      'sur',
      'sous',
      'entre',
      'comme',
      'mais',
      'plus',
      'très',
      'aussi',
      'être',
      'avoir',
      'suis',
      'es',
      'est',
      'sommes',
      'êtes',
      'sont',
      'étais',
      'était',
      'étions',
      'étiez',
      'étaient',
      'ai',
      'as',
      'avons',
      'avez',
      'ont',
      'avais',
      'avait',
      'avions',
      'aviez',
      'avaient',
      'ce',
      'cet',
      'cette',
      'ces',
      'mon',
      'ma',
      'mes',
      'ton',
      'ta',
      'tes',
      'son',
      'sa',
      'ses',
      'notre',
      'nos',
      'votre',
      'vos',
      'leur',
      'leurs',
      'je',
      'tu',
      'il',
      'elle',
      'nous',
      'vous',
      'ils',
      'elles',
      'on',
      'bonjour',
      'merci',
      'salut',
      'cordialement',
      'message',
      'courriel',
      'réunion',
      'équipe',
      'travail',
      'aujourd',
      'hui',
      'demain',
      'semaine',
      'jour',
      'bonne',
      'journée',
      'plaît',
      'oui',
      'non',
      'pas',
      'ne',
      'au',
      'aux',
      'du',
      'de',
      'en',
      'et',
      'ou',
      'où',
      'donc',
      'or',
      'ni',
      'car',
      'comment',
      'allez',
    ],
    de: [
      'der',
      'die',
      'das',
      'den',
      'dem',
      'des',
      'ein',
      'eine',
      'einer',
      'eines',
      'einem',
      'einen',
      'und',
      'oder',
      'aber',
      'nicht',
      'kein',
      'keine',
      'mit',
      'von',
      'zu',
      'zum',
      'zur',
      'im',
      'in',
      'am',
      'an',
      'auf',
      'für',
      'über',
      'unter',
      'zwischen',
      'aus',
      'bei',
      'nach',
      'vor',
      'durch',
      'gegen',
      'ohne',
      'um',
      'ist',
      'sind',
      'war',
      'waren',
      'bin',
      'bist',
      'seid',
      'habe',
      'hast',
      'hat',
      'haben',
      'hatte',
      'hatten',
      'werde',
      'wirst',
      'wird',
      'werden',
      'würde',
      'würden',
      'kann',
      'kannst',
      'können',
      'muss',
      'musst',
      'müssen',
      'soll',
      'sollen',
      'darf',
      'dürfen',
      'ich',
      'du',
      'er',
      'sie',
      'es',
      'wir',
      'ihr',
      'mich',
      'dich',
      'sich',
      'uns',
      'euch',
      'mein',
      'meine',
      'dein',
      'deine',
      'sein',
      'seine',
      'ihre',
      'unser',
      'unsere',
      'hallo',
      'danke',
      'bitte',
      'grüße',
      'freundlichen',
      'nachricht',
      'mail',
      'termin',
      'team',
      'arbeit',
      'heute',
      'morgen',
      'woche',
      'tag',
      'guten',
    ],
    it: [
      'gli',
      'le',
      'uno',
      'una',
      'dei',
      'degli',
      'delle',
      'del',
      'della',
      'dello',
      'che',
      'chi',
      'cui',
      'per',
      'con',
      'come',
      'ma',
      'più',
      'anche',
      'essere',
      'avere',
      'sono',
      'sei',
      'è',
      'siamo',
      'siete',
      'era',
      'erano',
      'ho',
      'hai',
      'ha',
      'abbiamo',
      'avete',
      'hanno',
      'avevo',
      'aveva',
      'questo',
      'questa',
      'questi',
      'queste',
      'mio',
      'mia',
      'miei',
      'mie',
      'tuo',
      'tua',
      'suo',
      'sua',
      'nostro',
      'nostra',
      'vostro',
      'vostra',
      'loro',
      'io',
      'tu',
      'lui',
      'lei',
      'noi',
      'voi',
      'ciao',
      'grazie',
      'saluti',
      'cordiali',
      'messaggio',
      'posta',
      'riunione',
      'squadra',
      'lavoro',
      'oggi',
      'domani',
      'settimana',
      'giorno',
      'buongiorno',
      'buonasera',
      'sì',
      'non',
      'di',
      'da',
      'su',
      'tra',
      'fra',
      'e',
      'o',
      'se',
      'perché',
      'quando',
      'dove',
    ],
    pt: [
      'os',
      'as',
      'um',
      'uma',
      'uns',
      'umas',
      'do',
      'da',
      'dos',
      'das',
      'no',
      'na',
      'nos',
      'nas',
      'que',
      'quem',
      'para',
      'por',
      'com',
      'como',
      'mas',
      'mais',
      'muito',
      'também',
      'ser',
      'estar',
      'sou',
      'és',
      'é',
      'somos',
      'são',
      'era',
      'eram',
      'tenho',
      'tens',
      'tem',
      'temos',
      'têm',
      'tinha',
      'tinham',
      'este',
      'esta',
      'estes',
      'estas',
      'meu',
      'minha',
      'meus',
      'minhas',
      'teu',
      'tua',
      'seu',
      'sua',
      'nosso',
      'nossa',
      'você',
      'vocês',
      'ele',
      'ela',
      'eles',
      'elas',
      'nós',
      'olá',
      'obrigado',
      'obrigada',
      'atenciosamente',
      'mensagem',
      'correio',
      'reunião',
      'equipe',
      'trabalho',
      'hoje',
      'amanhã',
      'semana',
      'dia',
      'bom',
      'boa',
      'não',
      'sim',
      'em',
      'entre',
      'sobre',
      'quando',
      'onde',
    ],
    nl: [
      'het',
      'een',
      'en',
      'of',
      'maar',
      'niet',
      'geen',
      'met',
      'van',
      'voor',
      'op',
      'in',
      'aan',
      'bij',
      'uit',
      'over',
      'onder',
      'tussen',
      'naar',
      'door',
      'tegen',
      'zonder',
      'om',
      'is',
      'zijn',
      'was',
      'waren',
      'ben',
      'bent',
      'heeft',
      'hebben',
      'had',
      'hadden',
      'zal',
      'zullen',
      'kan',
      'kunnen',
      'moet',
      'moeten',
      'ik',
      'jij',
      'je',
      'hij',
      'zij',
      'ze',
      'wij',
      'we',
      'jullie',
      'mij',
      'mijn',
      'jouw',
      'haar',
      'ons',
      'onze',
      'hallo',
      'bedankt',
      'dank',
      'groeten',
      'bericht',
      'mail',
      'vergadering',
      'team',
      'werk',
      'vandaag',
      'morgen',
      'week',
      'dag',
      'goed',
      'goede',
    ],
    id: [
      'yang',
      'dan',
      'di',
      'ke',
      'dari',
      'untuk',
      'dengan',
      'pada',
      'dalam',
      'ini',
      'itu',
      'adalah',
      'akan',
      'tidak',
      'bisa',
      'sudah',
      'belum',
      'saya',
      'kamu',
      'anda',
      'dia',
      'kami',
      'kita',
      'mereka',
      'apa',
      'siapa',
      'kapan',
      'dimana',
      'mengapa',
      'bagaimana',
      'karena',
      'tetapi',
      'atau',
      'juga',
      'sangat',
      'lebih',
      'oleh',
      'sebagai',
      'ada',
      'telah',
      'masih',
      'hanya',
      'saja',
      'halo',
      'terima',
      'kasih',
      'salam',
      'pesan',
      'email',
      'rapat',
      'tim',
      'kerja',
      'hari',
      'besok',
      'minggu',
      'selamat',
      'pagi',
      'siang',
      'malam',
    ],
    vi: [
      'và',
      'là',
      'của',
      'có',
      'không',
      'được',
      'cho',
      'trong',
      'một',
      'những',
      'các',
      'người',
      'này',
      'đó',
      'với',
      'để',
      'từ',
      'đến',
      'về',
      'khi',
      'như',
      'nhưng',
      'hoặc',
      'nếu',
      'vì',
      'đã',
      'đang',
      'sẽ',
      'rất',
      'cũng',
      'tôi',
      'bạn',
      'anh',
      'chị',
      'em',
      'chúng',
      'họ',
      'ai',
      'gì',
      'sao',
      'nào',
      'ở',
      'ra',
      'vào',
      'lên',
      'xuống',
      'hôm',
      'nay',
      'mai',
      'tuần',
      'ngày',
      'xin',
      'chào',
      'cảm',
      'ơn',
      'thư',
      'tin',
      'họp',
      'nhóm',
      'công',
      'việc',
      'chúc',
      'khỏe',
    ],
  }).map(([language, words]) => [language, new Set(words)]),
);

function guessLatinLanguage(text: string): string | null {
  const words = new Set(text.toLowerCase().match(/\p{L}{2,}/gu) ?? []);
  if (words.size < 3) return null;

  let best: string | null = null;
  let bestScore = 0;
  let second = 0;
  for (const [language, stopwords] of LATIN_STOPWORDS) {
    let score = 0;
    for (const word of words) {
      if (stopwords.has(word)) score += 1;
    }
    if (score > bestScore) {
      second = bestScore;
      bestScore = score;
      best = language;
    } else if (score > second) {
      second = score;
    }
  }

  return bestScore >= 2 && bestScore > second ? best : null;
}

export interface GmailBannerLabels {
  region: string;
  detected: (language: string) => string;
  translate: (language: string) => string;
  showOriginal: string;
  translating: string;
  close: string;
}

export interface GmailBannerPreferences {
  enabled: boolean;
  targetLanguage: string;
  form: Formality;
  glossary?: readonly GlossaryEntry[];
}

export interface GmailBannerOptions {
  engine: PageEngine;
  labels: GmailBannerLabels;
  preferences: GmailBannerPreferences;
  onWarm?: () => void;
  debounceMs?: number;
}

interface AppliedBlock {
  model: SegmentModel;
  created: Text[];
}

interface BannerRecord {
  body: Element;
  host: HTMLElement;
  shadow: ShadowRoot;
  text: HTMLElement;
  action: HTMLButtonElement;
  close: HTMLButtonElement;
  state: GmailBannerState;
  language: string;
  models: AppliedBlock[];
  controller: AbortController | null;
}

const bannerShadows = new WeakMap<Element, ShadowRoot>();

export function gmailBannerShadow(host: Element | null | undefined): ShadowRoot | null {
  return host ? (bannerShadows.get(host) ?? null) : null;
}

const BANNER_STYLE = `
:host {
  all: initial;
}
.banner {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  margin: 0 0 8px;
  padding: 8px 10px;
  border: 1px solid #d7dee7;
  border-radius: 8px;
  background: #f7f9fc;
  color: #1f2937;
  font: 13px/1.45 "Google Sans", "Segoe UI", "Hiragino Sans", "Noto Sans JP", sans-serif;
  box-shadow: 0 1px 2px rgb(60 64 67 / 8%);
}
.icon {
  flex: 0 0 auto;
  width: 18px;
  height: 18px;
  color: #0e7490;
}
.text {
  flex: 1 1 auto;
  min-width: 0;
}
button {
  font: inherit;
}
.action {
  flex: 0 0 auto;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: #0e7490;
  cursor: pointer;
  font-weight: 600;
  padding: 3px 6px;
  white-space: nowrap;
}
.action:hover {
  background: rgb(14 116 144 / 8%);
  text-decoration: underline;
}
.action:disabled {
  color: #5b6675;
  cursor: default;
  text-decoration: none;
}
.close {
  flex: 0 0 auto;
  width: 26px;
  height: 26px;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: #5b6675;
  cursor: pointer;
  font-size: 18px;
  line-height: 1;
  padding: 0;
}
.close:hover {
  background: rgb(60 64 67 / 10%);
}
@media (prefers-color-scheme: dark) {
  .banner {
    border-color: #2d3947;
    background: #1a222c;
    color: #edf1f6;
  }
  .icon {
    color: #67e8f9;
  }
  .action {
    color: #67e8f9;
  }
  .action:hover {
    background: rgb(103 232 249 / 12%);
  }
  .action:disabled,
  .close {
    color: #9ba7b6;
  }
  .close:hover {
    background: rgb(237 241 246 / 10%);
  }
}
`;

const SVG_NS = 'http://www.w3.org/2000/svg';

function appendLanguageIcon(doc: Document, parent: Element): void {
  const svg = doc.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'icon');
  const circle = doc.createElementNS(SVG_NS, 'circle');
  circle.setAttribute('cx', '12');
  circle.setAttribute('cy', '12');
  circle.setAttribute('r', '9');
  circle.setAttribute('fill', 'none');
  circle.setAttribute('stroke', 'currentColor');
  circle.setAttribute('stroke-width', '1.7');
  const meridian = doc.createElementNS(SVG_NS, 'path');
  meridian.setAttribute('d', 'M3.5 9.5h17M3.5 14.5h17M12 3a16 16 0 0 1 0 18M12 3a16 16 0 0 0 0 18');
  meridian.setAttribute('fill', 'none');
  meridian.setAttribute('stroke', 'currentColor');
  meridian.setAttribute('stroke-width', '1.5');
  meridian.setAttribute('stroke-linecap', 'round');
  svg.append(circle, meridian);
  parent.append(svg);
}

export class GmailBannerController {
  private readonly engine: PageEngine;
  private labels: GmailBannerLabels;
  private prefs: GmailBannerPreferences;
  private readonly onWarm: () => void;
  private readonly debounceMs: number;
  private readonly records = new Map<Element, BannerRecord>();
  private readonly dismissedKeys = new Set<string>();
  private observer: MutationObserver | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private started = false;

  private readonly observerFactory: typeof MutationObserver | null;

  constructor(
    private readonly doc: Document,
    options: GmailBannerOptions,
  ) {
    this.engine = options.engine;
    this.labels = options.labels;
    this.prefs = options.preferences;
    this.onWarm = options.onWarm ?? (() => undefined);
    this.debounceMs = options.debounceMs ?? 150;
    const view = doc.defaultView as (Window & typeof globalThis) | null;
    this.observerFactory =
      view?.MutationObserver ?? (typeof MutationObserver === 'function' ? MutationObserver : null);
  }

  start(): void {
    if (this.started || !this.prefs.enabled) return;
    this.started = true;
    const root = this.doc.body ?? this.doc.documentElement;
    if (root && this.observerFactory) {
      this.observer = new this.observerFactory(() => this.schedule());
      this.observer.observe(root, { childList: true, subtree: true });
    }
    this.refresh();
  }

  stop(): void {
    this.started = false;
    this.observer?.disconnect();
    this.observer = null;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    for (const record of [...this.records.values()]) {
      record.controller?.abort();
      this.restoreRecord(record);
      record.host.remove();
    }
    this.records.clear();
    this.dismissedKeys.clear();
  }

  dispose(): void {
    this.stop();
  }

  setLabels(labels: GmailBannerLabels): void {
    this.labels = labels;
    for (const record of this.records.values()) this.paint(record);
  }

  setPreferences(next: GmailBannerPreferences): void {
    const previous = this.prefs;
    this.prefs = next;
    if (!next.enabled) {
      this.stop();
      return;
    }
    if (!this.started) {
      this.start();
      return;
    }
    if (
      previous.targetLanguage !== next.targetLanguage ||
      previous.form !== next.form ||
      glossaryKey(previous.glossary) !== glossaryKey(next.glossary)
    ) {
      this.resetBanners();
      this.refresh();
    }
  }

  refresh(): void {
    if (!this.prefs.enabled) return;
    for (const [body, record] of [...this.records]) {
      if (body.isConnected) continue;
      record.controller?.abort();
      record.host.remove();
      this.records.delete(body);
    }

    for (const body of findGmailMessageBodies(this.doc)) {
      const existing = this.records.get(body);
      if (existing) {
        if (
          gmailBannerButton(existing.state) !== null &&
          (!existing.host.isConnected || existing.host.nextElementSibling !== body)
        ) {
          body.parentElement?.insertBefore(existing.host, body);
        }
        if (existing.state.phase === 'offer') this.refreshOffer(existing);
        continue;
      }
      if (isPageTranslated(body)) continue;

      const key = gmailMessageKey(body);
      if (key.length > 0 && this.dismissedKeys.has(key)) continue;

      const text = visibleOriginal(body);
      const language = detectGmailMessageLanguage(body, this.prefs.targetLanguage);
      if (
        !shouldOfferGmailTranslation({
          text,
          language,
          targetLanguage: this.prefs.targetLanguage,
        })
      ) {
        continue;
      }
      this.mount(body, key, language ?? 'en');
    }
  }

  private schedule(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.refresh();
    }, this.debounceMs);
  }

  private refreshOffer(record: BannerRecord): void {
    const text = visibleOriginal(record.body);
    const language = detectGmailMessageLanguage(record.body, this.prefs.targetLanguage);
    if (
      !shouldOfferGmailTranslation({
        text,
        language,
        targetLanguage: this.prefs.targetLanguage,
      })
    ) {
      record.host.remove();
      this.records.delete(record.body);
      return;
    }
    if (language && language !== record.language) {
      record.language = language;
      this.paint(record);
    }
  }

  private mount(body: Element, key: string, language: string): void {
    const parent = body.parentElement;
    if (!parent) return;

    const host = this.doc.createElement(GMAIL_BANNER_TAG);
    host.setAttribute('translate', 'no');
    host.setAttribute('role', 'region');
    host.setAttribute('aria-label', this.labels.region);
    host.dataset.sakuttoGmailBanner = key;
    host.dataset.sakuttoGmailPhase = 'offer';
    host.style.display = 'block';

    const shadow = host.attachShadow({ mode: 'closed' });
    bannerShadows.set(host, shadow);
    const style = this.doc.createElement('style');
    style.textContent = BANNER_STYLE;

    const banner = this.doc.createElement('div');
    banner.className = 'banner';
    const icon = this.doc.createElement('span');
    appendLanguageIcon(this.doc, icon);
    const text = this.doc.createElement('span');
    text.className = 'text';
    text.setAttribute('aria-live', 'polite');
    const action = this.doc.createElement('button');
    action.type = 'button';
    action.className = 'action';
    const close = this.doc.createElement('button');
    close.type = 'button';
    close.className = 'close';
    close.textContent = '×';

    banner.append(icon, text, action, close);
    shadow.append(style, banner);
    parent.insertBefore(host, body);

    const record: BannerRecord = {
      body,
      host,
      shadow,
      text,
      action,
      close,
      state: initialGmailBannerState(),
      language,
      models: [],
      controller: null,
    };
    this.records.set(body, record);
    this.paint(record);
    action.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      void this.activate(record);
    });
    close.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.dismiss(record);
    });
    // The shadow root is closed, so the fixture build exposes the same actions as an
    // event the page can dispatch. The release build has no test hook.
    if (__SAKUTTO_FAKE_ENGINE__) {
      host.addEventListener('sakutto-gmail-action', (event) => {
        const detail = event instanceof CustomEvent ? event.detail : null;
        if (detail === 'translate') void this.activate(record);
        if (detail === 'show-original' && gmailBannerButton(record.state) === 'show-original') {
          this.restore(record);
        }
        if (detail === 'close') this.dismiss(record);
      });
    }
  }

  private paint(record: BannerRecord): void {
    const kind = gmailBannerButton(record.state);
    if (kind === null) {
      record.host.hidden = true;
      return;
    }
    record.host.hidden = false;
    record.host.dataset.sakuttoGmailPhase = record.state.phase;
    record.host.dataset.sakuttoGmailLanguage = record.language;
    record.host.setAttribute('aria-label', this.labels.region);
    record.close.setAttribute('aria-label', this.labels.close);
    record.close.title = this.labels.close;

    if (kind === 'show-original') {
      record.text.textContent = this.labels.detected(record.language);
      record.action.textContent = this.labels.showOriginal;
      record.action.disabled = false;
      return;
    }
    record.text.textContent =
      kind === 'busy' ? this.labels.translating : this.labels.detected(record.language);
    record.action.textContent = this.labels.translate(this.prefs.targetLanguage);
    record.action.disabled = kind === 'busy';
  }

  private async activate(record: BannerRecord): Promise<void> {
    const kind = gmailBannerButton(record.state);
    if (kind === 'translate') {
      await this.translate(record);
      return;
    }
    if (kind === 'show-original') this.restore(record);
  }

  private async translate(record: BannerRecord): Promise<void> {
    if (!record.body.isConnected) return;
    record.state = gmailBannerAfterTranslate(record.state);
    record.controller = new AbortController();
    this.paint(record);
    this.onWarm();
    try {
      const models = await translateGmailBody(record.body, this.engine, {
        targetLanguage: this.prefs.targetLanguage,
        form: this.prefs.form,
        ...(this.prefs.glossary ? { glossary: this.prefs.glossary } : {}),
        language: record.language,
        signal: record.controller.signal,
      });
      if (record.controller.signal.aborted || !record.body.isConnected) {
        for (const applied of models) restoreApplied(applied);
        return;
      }
      if (models.length === 0) {
        record.state = { ...record.state, phase: 'offer' };
        return;
      }
      record.models = models;
      record.state = gmailBannerAfterTranslated(record.state);
    } catch {
      if (!record.controller.signal.aborted) {
        this.restoreRecord(record);
        record.state = { ...record.state, phase: 'offer' };
      }
    } finally {
      record.controller = null;
      this.paint(record);
    }
  }

  private restore(record: BannerRecord): void {
    record.controller?.abort();
    this.restoreRecord(record);
    record.state = gmailBannerAfterShowOriginal(record.state);
    this.paint(record);
  }

  private restoreRecord(record: BannerRecord): void {
    for (const applied of record.models) restoreApplied(applied);
    record.models = [];
  }

  private dismiss(record: BannerRecord): void {
    record.controller?.abort();
    this.restoreRecord(record);
    record.state = gmailBannerAfterDismiss(record.state);
    const key = gmailMessageKey(record.body);
    if (key.length > 0) this.dismissedKeys.add(key);
    record.host.remove();
    record.host.hidden = true;
  }

  private resetBanners(): void {
    for (const record of [...this.records.values()]) {
      record.controller?.abort();
      this.restoreRecord(record);
      record.host.remove();
    }
    this.records.clear();
  }
}

export interface GmailBodyTranslationOptions {
  targetLanguage: string;
  form: Formality;
  glossary?: readonly GlossaryEntry[];
  language?: string | null;
  signal: AbortSignal;
}

interface BlockJob {
  model: SegmentModel;
  texts: string[];
  final: boolean[];
  errors: boolean[];
}

interface RequestOwner {
  job: BlockJob;
  index: number;
}

/**
 * Translate only the prose under one Gmail body. The same block builder and renderer the
 * page session uses are applied to this root, so inline links and formatting keep their
 * place and Show original can put every text node back.
 */
export async function translateGmailBody(
  root: Element,
  engine: PageEngine,
  options: GmailBodyTranslationOptions,
): Promise<AppliedBlock[]> {
  const jobs: BlockJob[] = [];
  const requests: { id: string; text: string }[] = [];
  const owners = new Map<string, RequestOwner>();

  for (const block of listTranslatableBlocks(root)) {
    const model = buildSegment(block);
    if (isAlreadyTargetLanguage(block, options.targetLanguage, null, model?.source ?? '')) {
      continue;
    }
    if (!model) continue;
    const pieces = chunkForTranslation(model.source);
    if (pieces.length === 0) continue;
    const job: BlockJob = {
      model,
      texts: pieces.map(() => ''),
      final: pieces.map(() => false),
      errors: pieces.map(() => false),
    };
    const jobIndex = jobs.length;
    jobs.push(job);
    pieces.forEach((text, index) => {
      const id = `g${String(jobIndex)}:${String(index)}`;
      requests.push({ id, text });
      owners.set(id, { job, index });
    });
  }

  if (requests.length === 0) return [];

  for await (const chunk of engine.translate(requests, {
    tgt: options.targetLanguage,
    form: options.form,
    ...(options.language ? { src: options.language } : {}),
    ...(options.glossary && options.glossary.length > 0 ? { glossary: options.glossary } : {}),
    priority: translationPriority('selection', 0, 'prose'),
    signal: options.signal,
  })) {
    if (options.signal.aborted) break;
    const owner = owners.get(chunk.id);
    if (!owner) continue;
    const { job, index } = owner;
    if (chunk.textDelta !== undefined) {
      if (chunk.restart === true) job.texts[index] = '';
      job.texts[index] = (job.texts[index] ?? '') + chunk.textDelta;
      continue;
    }
    job.texts[index] = chunk.final;
    job.final[index] = true;
    if (chunk.error === true) job.errors[index] = true;
  }

  if (options.signal.aborted) return [];

  const applied: AppliedBlock[] = [];
  for (const job of jobs) {
    if (!job.final.every(Boolean) || job.errors.some(Boolean)) continue;
    const joined = joinTranslatedSentences(job.texts, options.targetLanguage);
    if (joined.trim().length === 0) continue;
    const markup = job.model.placeholder
      ? assessTranslation(joined, placeholderIds(job.model))
      : null;
    const text = markup ? (markup.ok ? markup.text : markup.plain) : stripPlaceholderTokens(joined);
    if (text.trim().length === 0) continue;
    const created: Text[] = [];
    applyTranslation(job.model, text, created);
    job.model.block.setAttribute('data-sakutto-gmail-translated', '1');
    applied.push({ model: job.model, created });
  }
  return applied;
}

function restoreApplied(applied: AppliedBlock): void {
  restoreSegment(applied.model, applied.created);
  applied.model.block.removeAttribute('data-sakutto-gmail-translated');
}

function isPageTranslated(body: Element): boolean {
  return (
    body.hasAttribute('data-sakutto-id') ||
    body.querySelector('[data-sakutto-id]') !== null ||
    body.querySelector('sakutto-line') !== null
  );
}

function glossaryKey(glossary: readonly GlossaryEntry[] | undefined): string {
  return (glossary ?? []).map((entry) => `${entry.source}\u0000${entry.target}`).join('\u0001');
}
