import { chunkForTranslation, joinTranslatedSentences } from '@/engine/text/sentences';
import type { GlossaryEntry } from '@/engine/types';
import {
  isGmailAutoTranslateLanguage,
  isGmailNeverTranslateLanguage,
  toggleGmailAutoTranslateLanguage,
  toggleGmailNeverTranslateLanguage,
  type Formality,
  type GmailTranslateLanguages,
} from '@/shared/settings';
import { listTranslatableBlocks } from './blocks';
import { canonicalPageLanguage, inferLanguage, isAlreadyTargetLanguage } from './detect';
import { translationPriority } from './priority';
import { assessTranslation, stripPlaceholderTokens } from './placeholders';
import { applyTranslation, restoreSegment } from './render';
import {
  MAIL_BANNER_PRESS_EVENTS,
  isMailBannerPressTrigger,
  mailBannerDebug,
  registerMailBannerPressHook,
} from './mail-banner-press';
import { buildSegment, placeholderIds, visibleOriginal, type SegmentModel } from './segment';
import type { PageEngine } from './session';

/** A body this short is a greeting or a signature, not enough prose to identify. */
export const MAIL_MIN_BODY_CHARS = 24;

export interface MailBannerGate {
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
export function shouldOfferMailTranslation(input: MailBannerGate): boolean {
  const text = input.text.replace(/\s+/gu, ' ').trim();
  if (text.length < (input.minChars ?? MAIL_MIN_BODY_CHARS)) return false;
  if (!/\p{L}/u.test(text)) return false;
  const source = canonicalPageLanguage(input.language);
  const target = canonicalPageLanguage(input.targetLanguage);
  return source !== null && target !== null && source !== target;
}

export type MailBannerPhase = 'offer' | 'translating' | 'translated' | 'original' | 'error';

export interface MailBannerState {
  phase: MailBannerPhase;
  dismissed: boolean;
}

export type MailBannerButton =
  'translate' | 'show-original' | 'show-translation' | 'busy' | 'error';

export function initialMailBannerState(): MailBannerState {
  return { phase: 'offer', dismissed: false };
}

export function mailBannerButton(state: MailBannerState): MailBannerButton | null {
  if (state.dismissed) return null;
  if (state.phase === 'translating') return 'busy';
  if (state.phase === 'translated') return 'show-original';
  if (state.phase === 'original') return 'show-translation';
  if (state.phase === 'error') return 'error';
  return 'translate';
}

export function mailBannerAfterTranslate(state: MailBannerState): MailBannerState {
  if (state.dismissed || state.phase !== 'offer') return state;
  return { ...state, phase: 'translating' };
}

export function mailBannerAfterTranslated(state: MailBannerState): MailBannerState {
  if (state.dismissed || state.phase !== 'translating') return state;
  return { ...state, phase: 'translated' };
}

/** Hides the translation but keeps the cached blocks so Show translation can reapply them. */
export function mailBannerAfterShowOriginal(state: MailBannerState): MailBannerState {
  if (state.dismissed || state.phase !== 'translated') return state;
  return { ...state, phase: 'original' };
}

export function mailBannerAfterShowTranslation(state: MailBannerState): MailBannerState {
  if (state.dismissed || state.phase !== 'original') return state;
  return { ...state, phase: 'translated' };
}

export function mailBannerAfterDismiss(state: MailBannerState): MailBannerState {
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
 * A mail provider's `<html lang>` is the interface language, not the language of the message body,
 * so the message has to be read on its own. The body's own `lang` wins; then the shared
 * script heuristic; then a small stop-word vote for Latin-script prose; and finally a
 * wrapper that covers most of the body.
 */
export function detectMailMessageLanguage(body: Element, targetLanguage: string): string | null {
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

export interface MailBannerLabels {
  region: string;
  detected: (language: string) => string;
  translate: (language: string) => string;
  showOriginal: string;
  showTranslation: string;
  translating: string;
  error: string;
  close: string;
  translated: (source: string, target: string) => string;
  menu: string;
  translateNow: (language: string) => string;
  alwaysTranslate: (language: string) => string;
  neverTranslate: (language: string) => string;
}

export interface MailBannerPreferences {
  enabled: boolean;
  targetLanguage: string;
  form: Formality;
  glossary?: readonly GlossaryEntry[];
  /** Source languages translated on arrival, without showing the offer button first. */
  autoLanguages?: readonly string[];
  /** Source languages that never get a banner. */
  neverLanguages?: readonly string[];
}

export interface MailBannerOptions {
  engine: PageEngine;
  labels: MailBannerLabels;
  preferences: MailBannerPreferences;
  onWarm?: () => void;
  onLanguagesChange?: (languages: GmailTranslateLanguages) => void;
  debounceMs?: number;
}

/**
 * Provider-specific DOM knowledge. The shared controller owns the state machine, menu,
 * rendering, caching, and translation; an adapter only says which nodes are message bodies,
 * how to key them, and how the banner should look on that provider.
 */
export interface MailBannerAdapter {
  readonly id: string;
  readonly tag: string;
  readonly actionEvent: string;
  readonly bannerDataset: string;
  readonly phaseDataset: string;
  readonly languageDataset: string;
  readonly translatedAttribute: string;
  readonly style: string;
  findMessageBodies(root: ParentNode): Element[];
  messageKey(body: Element): string;
  detectLanguage(body: Element, targetLanguage: string): string | null;
  shouldOffer(input: MailBannerGate): boolean;
}

export interface AppliedBlock {
  model: SegmentModel;
  text: string;
  created: Text[];
}

/** How many translatable jobs exist and how many have finished, for the busy banner. */
export interface MailBodyTranslationProgress {
  totalBlocks: number;
  completedBlocks: number;
  appliedBlocks: number;
}

interface CachedTranslation {
  source: string;
  text: string;
}

interface BannerRecord {
  body: Element;
  host: HTMLElement;
  shadow: ShadowRoot;
  banner: HTMLElement;
  text: HTMLElement;
  action: HTMLButtonElement;
  close: HTMLButtonElement;
  gear: HTMLButtonElement;
  menu: HTMLElement;
  menuTranslate: HTMLButtonElement;
  menuAuto: HTMLButtonElement;
  menuNever: HTMLButtonElement;
  autoCheck: HTMLElement;
  neverCheck: HTMLElement;
  state: MailBannerState;
  language: string;
  models: AppliedBlock[];
  progress: MailBodyTranslationProgress | null;
  controller: AbortController | null;
  autoAttempted: boolean;
  menuOpen: boolean;
  outsideHandler: ((event: Event) => void) | null;
  lastButtonPress: { button: HTMLButtonElement; at: number } | null;
  errorTimer: ReturnType<typeof setTimeout> | null;
}

const BUTTON_PRESS_DEDUPE_MS = 700;
const ERROR_VISIBLE_MS = 4000;

const bannerShadows = new WeakMap<Element, ShadowRoot>();

export function mailBannerShadow(host: Element | null | undefined): ShadowRoot | null {
  return host ? (bannerShadows.get(host) ?? null) : null;
}

/** Default banner appearance; providers may override it with their own native-style CSS. */
export const DEFAULT_MAIL_BANNER_STYLE = `
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
.banner.compact {
  gap: 8px;
  padding: 6px 8px;
  border-radius: 6px;
  background: #f1f6f8;
  font-size: 12.5px;
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
.close,
.gear {
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
.close:hover,
.gear:hover,
.gear[aria-expanded="true"] {
  background: rgb(60 64 67 / 10%);
}
.gear {
  display: inline-grid;
  place-items: center;
}
.gear svg {
  width: 17px;
  height: 17px;
}
.menu-wrap {
  position: relative;
  flex: 0 0 auto;
}
.menu {
  position: absolute;
  z-index: 2147483647;
  top: calc(100% + 6px);
  right: 0;
  box-sizing: border-box;
  min-width: 220px;
  padding: 6px;
  border: 1px solid #d7dee7;
  border-radius: 8px;
  background: #ffffff;
  box-shadow: 0 8px 24px rgb(60 64 67 / 22%);
}
.menu[hidden] {
  display: none;
}
.menu-item {
  box-sizing: border-box;
  display: grid;
  grid-template-columns: 18px 1fr;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 7px 8px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: #1f2937;
  cursor: pointer;
  text-align: left;
  white-space: nowrap;
}
.menu-item:hover,
.menu-item:focus-visible {
  background: rgb(14 116 144 / 9%);
  outline: none;
}
.check {
  color: #0e7490;
  font-weight: 700;
  text-align: center;
}
.action:focus-visible,
.close:focus-visible,
.gear:focus-visible,
.menu-item:focus-visible {
  outline: 2px solid #0e7490;
  outline-offset: 1px;
}
@media (prefers-color-scheme: dark) {
  .banner {
    border-color: #2d3947;
    background: #1a222c;
    color: #edf1f6;
  }
  .banner.compact {
    background: #152029;
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
  .close,
  .gear {
    color: #9ba7b6;
  }
  .close:hover,
  .gear:hover,
  .gear[aria-expanded="true"] {
    background: rgb(237 241 246 / 10%);
  }
  .menu {
    border-color: #2d3947;
    background: #1f2938;
    box-shadow: 0 8px 24px rgb(0 0 0 / 45%);
  }
  .menu-item {
    color: #edf1f6;
  }
  .menu-item:hover,
  .menu-item:focus-visible {
    background: rgb(103 232 249 / 12%);
  }
  .check {
    color: #67e8f9;
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

function appendGearIcon(doc: Document, parent: Element): void {
  const svg = doc.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const path = doc.createElementNS(SVG_NS, 'path');
  path.setAttribute(
    'd',
    'M19.4 13a7.7 7.7 0 0 0 0-2l2-1.6-2-3.4-2.4 1a7.6 7.6 0 0 0-1.7-1L15 3h-4l-.3 2.6a7.6 7.6 0 0 0-1.7 1l-2.4-1-2 3.4L6.6 11a7.7 7.7 0 0 0 0 2l-2 1.6 2 3.4 2.4-1a7.6 7.6 0 0 0 1.7 1L11 21h4l.3-2.6a7.6 7.6 0 0 0 1.7-1l2.4 1 2-3.4-2-1.6ZM13 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7Z',
  );
  path.setAttribute('fill', 'currentColor');
  svg.append(path);
  parent.append(svg);
}

export class MailBannerController {
  private readonly engine: PageEngine;
  private readonly adapter: MailBannerAdapter;
  private labels: MailBannerLabels;
  private prefs: MailBannerPreferences;
  private readonly onWarm: () => void;
  private readonly onLanguagesChange: (languages: GmailTranslateLanguages) => void;
  private readonly debounceMs: number;
  private readonly records = new Map<Element, BannerRecord>();
  private readonly dismissedKeys = new Set<string>();
  private readonly translatedKeys = new Set<string>();
  private readonly autoPendingKeys = new Set<string>();
  private readonly translationsByKey = new Map<string, CachedTranslation[]>();
  private observer: MutationObserver | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private openMenuRecord: BannerRecord | null = null;
  private readonly recordsByHost = new WeakMap<HTMLElement, BannerRecord>();
  private interactionWindow: Window | null = null;
  private unregisterPressHook: (() => void) | null = null;

  private readonly observerFactory: typeof MutationObserver | null;

  constructor(
    private readonly doc: Document,
    adapter: MailBannerAdapter,
    options: MailBannerOptions,
  ) {
    this.adapter = adapter;
    this.engine = options.engine;
    this.labels = options.labels;
    this.prefs = options.preferences;
    this.onWarm = options.onWarm ?? (() => undefined);
    this.onLanguagesChange = options.onLanguagesChange ?? (() => undefined);
    this.debounceMs = options.debounceMs ?? 150;
    const view = doc.defaultView as (Window & typeof globalThis) | null;
    this.observerFactory =
      view?.MutationObserver ?? (typeof MutationObserver === 'function' ? MutationObserver : null);
  }

  start(): void {
    if (this.started || !this.prefs.enabled) return;
    this.started = true;
    this.listenForButtonPresses();
    const root = this.doc.body ?? this.doc.documentElement;
    if (root && this.observerFactory) {
      this.observer = new this.observerFactory(() => this.schedule());
      this.observer.observe(root, { childList: true, subtree: true });
    }
    this.refresh();
  }

  stop(): void {
    this.started = false;
    this.stopListeningForButtonPresses();
    this.observer?.disconnect();
    this.observer = null;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    for (const record of [...this.records.values()]) {
      this.closeMenu(record);
      record.controller?.abort();
      if (record.errorTimer !== null) clearTimeout(record.errorTimer);
      this.restoreRecord(record);
      record.host.remove();
    }
    this.records.clear();
    this.dismissedKeys.clear();
    this.translatedKeys.clear();
    this.autoPendingKeys.clear();
    this.translationsByKey.clear();
    this.openMenuRecord = null;
  }

  dispose(): void {
    this.stop();
  }

  setLabels(labels: MailBannerLabels): void {
    this.labels = labels;
    for (const record of this.records.values()) this.paint(record);
  }

  setPreferences(next: MailBannerPreferences): void {
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
      return;
    }
    if (
      languageListKey(previous.autoLanguages) !== languageListKey(next.autoLanguages) ||
      languageListKey(previous.neverLanguages) !== languageListKey(next.neverLanguages)
    ) {
      this.applyLanguagePreferences();
    }
  }

  /** Reconciles banners already on screen after the auto/never lists change. */
  private applyLanguagePreferences(): void {
    for (const record of [...this.records.values()]) {
      const auto = isGmailAutoTranslateLanguage(record.language, this.prefs.autoLanguages ?? []);
      const never = isGmailNeverTranslateLanguage(record.language, this.prefs.neverLanguages ?? []);
      if (never) {
        record.controller?.abort();
        this.closeMenu(record);
        this.restoreRecord(record);
        this.removeRecord(record);
        const key = this.recordKey(record);
        if (key.length > 0) {
          this.translatedKeys.delete(key);
          this.translationsByKey.delete(key);
        }
        continue;
      }
      if (!auto) record.autoAttempted = false;
      this.paint(record);
      if (auto && record.state.phase === 'offer' && !record.autoAttempted) {
        record.autoAttempted = true;
        void this.translate(record);
      }
    }
    // A message hidden by a never rule can get its banner back when the list changes.
    this.refresh();
  }

  /**
   * OWA handles pointer events from a window/document capture listener and may call
   * `stopImmediatePropagation()` before the event can reach a banner button in a shadow root.
   * The document_start bridge is already listening for that case; this listener is the
   * fallback for ordinary pages and for synthetic presses that stay inside the shadow tree.
   */
  private listenForButtonPresses(): void {
    const view = this.doc.defaultView;
    if (!view) return;
    this.interactionWindow = view;
    this.unregisterPressHook = registerMailBannerPressHook(this.onButtonPress);
    for (const type of MAIL_BANNER_PRESS_EVENTS) {
      view.addEventListener(type, this.onButtonPress, true);
    }
    mailBannerDebug('listener installed', {
      host: this.doc.location?.hostname ?? '',
      events: [...MAIL_BANNER_PRESS_EVENTS],
    });
  }

  private stopListeningForButtonPresses(): void {
    this.unregisterPressHook?.();
    this.unregisterPressHook = null;
    const view = this.interactionWindow;
    if (!view) return;
    for (const type of MAIL_BANNER_PRESS_EVENTS) {
      view.removeEventListener(type, this.onButtonPress, true);
    }
    this.interactionWindow = null;
  }

  private readonly onButtonPress = (event: Event): boolean => {
    if (!isMailBannerPressTrigger(event)) return false;
    const record = this.recordForEvent(event);
    if (!record) return false;
    const button = this.buttonForEvent(record, event);
    if (!button) return false;
    mailBannerDebug('press received', {
      type: event.type,
      button: button.className,
      phase: record.state.phase,
    });
    // Consume the event before OWA's capture listener can swallow it. The follow-up
    // mouse/click events from the same press are consumed the same way and deduped in
    // `pressButton`, so the action runs once.
    event.preventDefault();
    event.stopPropagation();
    this.pressButton(record, button, event);
    return true;
  };

  private recordForEvent(event: Event): BannerRecord | null {
    const direct = this.recordsByHost.get(event.target as HTMLElement);
    if (direct) return direct;
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
    for (const node of path) {
      const record = this.recordsByHost.get(node as HTMLElement);
      if (record) return record;
    }
    return null;
  }

  private buttonForEvent(record: BannerRecord, event: Event): HTMLButtonElement | null {
    if (this.isRecordButton(record, event.target)) return event.target;
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
    for (const node of path) {
      if (this.isRecordButton(record, node)) return node;
    }
    return null;
  }

  private isRecordButton(
    record: BannerRecord,
    node: EventTarget | null,
  ): node is HTMLButtonElement {
    return (
      node === record.action ||
      node === record.close ||
      node === record.gear ||
      node === record.menuTranslate ||
      node === record.menuAuto ||
      node === record.menuNever
    );
  }

  private pressButton(record: BannerRecord, button: HTMLButtonElement, event: Event): void {
    const now = Date.now();
    const previous = record.lastButtonPress;
    const startsPress =
      event.type === 'pointerdown' ||
      event.type === 'mousedown' ||
      event.type === 'pointerup' ||
      event.type === 'mouseup' ||
      event.type === 'keydown';
    // A real press produces several phases; the first one that reaches us performs the
    // action, and the rest are consumed for 700 ms. A standalone synthetic click still
    // acts every time, matching the keyboard and test path.
    if (
      event.type !== 'pointerdown' &&
      previous?.button === button &&
      now - previous.at < BUTTON_PRESS_DEDUPE_MS
    ) {
      if (event.type === 'click') record.lastButtonPress = null;
      return;
    }
    if (startsPress) record.lastButtonPress = { button, at: now };
    else record.lastButtonPress = null;

    if (button === record.action) {
      void this.activate(record);
      return;
    }
    if (button === record.close) {
      this.dismiss(record);
      return;
    }
    if (button === record.gear) {
      if (record.menuOpen) this.closeMenu(record, true);
      else this.openMenu(record);
      return;
    }
    if (button === record.menuTranslate) {
      this.closeMenu(record, true);
      const kind = mailBannerButton(record.state);
      if (kind === 'translate') void this.translate(record);
      else if (kind === 'show-translation' || kind === 'show-original')
        this.showTranslation(record);
      return;
    }
    if (button === record.menuAuto) {
      this.setAutoLanguage(record);
      this.closeMenu(record, true);
      return;
    }
    if (button === record.menuNever) {
      this.setNeverLanguage(record);
      this.closeMenu(record, true);
    }
  }

  refresh(): void {
    if (!this.prefs.enabled) return;
    for (const [body, record] of [...this.records]) {
      // The common case costs two cheap checks. Only resolve through the parent chain when
      // OWA detached or moved the body, so ordinary Gmail refreshes keep their old cost.
      const resolved =
        body.isConnected && record.host.nextElementSibling === body
          ? body
          : this.resolveRecordBody(record);
      if (!resolved) {
        this.removeRecord(record, body);
        continue;
      }
      if (resolved !== body) {
        const key = this.recordKey(record);
        this.adoptBody(record, resolved);
        if (record.state.phase === 'translated') {
          const cached = key.length > 0 ? this.translationsByKey.get(key) : undefined;
          if (cached && cached.length > 0 && this.applyCachedTranslation(record, cached)) {
            record.state = { ...record.state, phase: 'translated' };
          } else {
            record.models = [];
            record.state = { ...record.state, phase: 'offer' };
          }
          this.paint(record);
        } else if (record.state.phase === 'original') {
          // Rebuild models against the new node so Show translation still works, then put
          // the original text back because that is the state the reader chose.
          const cached = key.length > 0 ? this.translationsByKey.get(key) : undefined;
          if (cached && cached.length > 0 && this.applyCachedTranslation(record, cached)) {
            this.restoreRecord(record, true);
            record.state = { ...record.state, phase: 'original' };
          } else {
            record.models = [];
            record.state = { ...record.state, phase: 'offer' };
          }
          this.paint(record);
        }
      }
    }

    for (const body of this.adapter.findMessageBodies(this.doc)) {
      const existing = this.records.get(body);
      if (existing) {
        if (
          mailBannerButton(existing.state) !== null &&
          (!existing.host.isConnected || existing.host.nextElementSibling !== body)
        ) {
          body.parentElement?.insertBefore(existing.host, body);
        }
        if (existing.state.phase === 'offer') this.refreshOffer(existing);
        continue;
      }
      if (isPageTranslated(body)) continue;

      const key = this.adapter.messageKey(body);
      if (key.length > 0 && this.dismissedKeys.has(key)) continue;

      const text = visibleOriginal(body);
      const language = this.adapter.detectLanguage(body, this.prefs.targetLanguage);
      if (
        !this.adapter.shouldOffer({
          text,
          language,
          targetLanguage: this.prefs.targetLanguage,
        })
      ) {
        continue;
      }
      if (isGmailNeverTranslateLanguage(language, this.prefs.neverLanguages ?? [])) continue;

      const source = language ?? 'en';
      const autoKey = key.length > 0 ? key : '';
      const alreadyAutoTranslated =
        autoKey.length > 0 &&
        (this.translatedKeys.has(autoKey) || this.autoPendingKeys.has(autoKey));
      const auto = isGmailAutoTranslateLanguage(source, this.prefs.autoLanguages ?? []);
      if (auto && !alreadyAutoTranslated && autoKey.length > 0) {
        this.autoPendingKeys.add(autoKey);
      }
      const record = this.mount(body, key, source, {
        auto: auto && !alreadyAutoTranslated,
        autoAttempted: alreadyAutoTranslated,
      });
      if (!record) continue;

      // A provider may replace the message node while the banner stays mounted. Reapply the
      // remembered translation instead of asking the engine for the same text again.
      const cached = key.length > 0 ? this.translationsByKey.get(key) : undefined;
      if (cached && cached.length > 0 && this.applyCachedTranslation(record, cached)) {
        record.state = { ...record.state, phase: 'translated' };
        record.autoAttempted = true;
        this.translatedKeys.add(key);
        this.paint(record);
      }
    }
  }

  /**
   * OWA's React tree can replace the body node while the banner host stays where it was.
   * Resolve from the host first (`nextElementSibling`), then within its parent chain, and
   * finally by message key so a detached `record.body` never receives the translation.
   */
  private recordKey(record: BannerRecord): string {
    const fromBody = this.adapter.messageKey(record.body);
    if (fromBody.length > 0) return fromBody;
    return record.host.dataset[this.adapter.bannerDataset] ?? '';
  }

  private resolveRecordBody(record: BannerRecord): Element | null {
    const key = this.recordKey(record);
    const host = record.host;
    const adjacent = host.nextElementSibling;
    if (this.isResolvedBody(adjacent, key)) return adjacent;
    if (this.isResolvedBody(record.body, key)) return record.body;

    let scope = host.parentElement;
    for (let depth = 0; scope && depth < 5; depth += 1, scope = scope.parentElement) {
      for (const candidate of this.adapter.findMessageBodies(scope)) {
        if (this.isResolvedBody(candidate, key)) return candidate;
      }
    }
    if (key.length > 0) {
      for (const candidate of this.adapter.findMessageBodies(this.doc)) {
        if (this.isResolvedBody(candidate, key)) return candidate;
      }
    }
    return null;
  }

  private isResolvedBody(candidate: Element | null, key: string): candidate is Element {
    if (!candidate || !candidate.isConnected) return false;
    if (key.length > 0 && this.adapter.messageKey(candidate) !== key) return false;
    if (visibleOriginal(candidate).trim().length === 0) return false;
    const style = this.doc.defaultView?.getComputedStyle(candidate);
    if (
      style &&
      (style.display === 'none' ||
        style.visibility === 'hidden' ||
        style.contentVisibility === 'hidden')
    ) {
      return false;
    }
    const parent = candidate.parentElement;
    if (!parent) return false;
    return this.adapter.findMessageBodies(parent).includes(candidate);
  }

  private adoptBody(record: BannerRecord, body: Element): void {
    const previous = record.body;
    if (previous !== body) {
      this.records.delete(previous);
      record.body = body;
      this.records.set(body, record);
    }
    const key = this.adapter.messageKey(body) || this.recordKey(record);
    if (key.length > 0) record.host.dataset[this.adapter.bannerDataset] = key;
    if (
      record.host.parentElement !== body.parentElement ||
      record.host.nextElementSibling !== body
    ) {
      body.parentElement?.insertBefore(record.host, body);
    }
    mailBannerDebug('body resolved', {
      selector: bodyDetails(body),
      connected: body.isConnected,
      textLength: visibleOriginal(body).trim().length,
      changed: previous !== body,
    });
  }

  private removeRecord(record: BannerRecord, body = record.body): void {
    this.closeMenu(record);
    record.controller?.abort();
    if (record.errorTimer !== null) {
      clearTimeout(record.errorTimer);
      record.errorTimer = null;
    }
    record.host.remove();
    this.records.delete(body);
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
    const language = this.adapter.detectLanguage(record.body, this.prefs.targetLanguage);
    if (
      !this.adapter.shouldOffer({
        text,
        language,
        targetLanguage: this.prefs.targetLanguage,
      })
    ) {
      this.removeRecord(record);
      return;
    }
    if (isGmailNeverTranslateLanguage(language, this.prefs.neverLanguages ?? [])) {
      this.removeRecord(record);
      return;
    }
    if (language && language !== record.language) {
      record.language = language;
      this.paint(record);
    }
    const auto = isGmailAutoTranslateLanguage(record.language, this.prefs.autoLanguages ?? []);
    if (auto && !record.autoAttempted && record.state.phase === 'offer') {
      record.autoAttempted = true;
      const key = this.recordKey(record);
      if (key.length > 0) this.autoPendingKeys.add(key);
      void this.translate(record);
    }
  }

  private mount(
    body: Element,
    key: string,
    language: string,
    options: { auto?: boolean; autoAttempted?: boolean } = {},
  ): BannerRecord | null {
    const parent = body.parentElement;
    if (!parent) return null;

    const host = this.doc.createElement(this.adapter.tag);
    host.setAttribute('translate', 'no');
    host.setAttribute('role', 'region');
    host.setAttribute('aria-label', this.labels.region);
    host.dataset[this.adapter.bannerDataset] = key;
    host.dataset[this.adapter.phaseDataset] = 'offer';
    host.style.display = 'block';

    const shadow = host.attachShadow({ mode: 'open' });
    bannerShadows.set(host, shadow);
    const style = this.doc.createElement('style');
    style.textContent = this.adapter.style;

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

    const menuWrap = this.doc.createElement('span');
    menuWrap.className = 'menu-wrap';
    const gear = this.doc.createElement('button');
    gear.type = 'button';
    gear.className = 'gear';
    gear.setAttribute('aria-haspopup', 'menu');
    gear.setAttribute('aria-expanded', 'false');
    appendGearIcon(this.doc, gear);

    const menu = this.doc.createElement('div');
    menu.className = 'menu';
    menu.setAttribute('role', 'menu');
    menu.hidden = true;

    const menuTranslate = this.doc.createElement('button');
    menuTranslate.type = 'button';
    menuTranslate.className = 'menu-item';
    menuTranslate.setAttribute('role', 'menuitem');
    const translateCheck = this.doc.createElement('span');
    translateCheck.className = 'check';
    translateCheck.setAttribute('aria-hidden', 'true');
    const translateLabel = this.doc.createElement('span');
    menuTranslate.append(translateCheck, translateLabel);

    const menuAuto = this.doc.createElement('button');
    menuAuto.type = 'button';
    menuAuto.className = 'menu-item';
    menuAuto.setAttribute('role', 'menuitemcheckbox');
    menuAuto.setAttribute('aria-checked', 'false');
    const autoCheck = this.doc.createElement('span');
    autoCheck.className = 'check';
    autoCheck.setAttribute('aria-hidden', 'true');
    const autoLabel = this.doc.createElement('span');
    menuAuto.append(autoCheck, autoLabel);

    const menuNever = this.doc.createElement('button');
    menuNever.type = 'button';
    menuNever.className = 'menu-item';
    menuNever.setAttribute('role', 'menuitemcheckbox');
    menuNever.setAttribute('aria-checked', 'false');
    const neverCheck = this.doc.createElement('span');
    neverCheck.className = 'check';
    neverCheck.setAttribute('aria-hidden', 'true');
    const neverLabel = this.doc.createElement('span');
    menuNever.append(neverCheck, neverLabel);

    menu.append(menuTranslate, menuAuto, menuNever);
    menuWrap.append(gear, menu);

    const close = this.doc.createElement('button');
    close.type = 'button';
    close.className = 'close';
    close.textContent = '×';

    banner.append(icon, text, action, menuWrap, close);
    shadow.append(style, banner);
    parent.insertBefore(host, body);

    const record: BannerRecord = {
      body,
      host,
      shadow,
      banner,
      text,
      action,
      close,
      gear,
      menu,
      menuTranslate,
      menuAuto,
      menuNever,
      autoCheck,
      neverCheck,
      state: initialMailBannerState(),
      language,
      models: [],
      progress: null,
      controller: null,
      autoAttempted: options.autoAttempted === true,
      menuOpen: false,
      outsideHandler: null,
      lastButtonPress: null,
      errorTimer: null,
    };
    this.records.set(body, record);
    this.recordsByHost.set(host, record);
    this.paint(record);

    for (const button of [
      action,
      close,
      gear,
      menuTranslate,
      menuAuto,
      menuNever,
    ] satisfies HTMLButtonElement[]) {
      // Composed presses normally reach the early or window capture listener first. This
      // fallback covers keyboard activation and synthetic events that stay inside the shadow.
      for (const type of MAIL_BANNER_PRESS_EVENTS) {
        button.addEventListener(type, (event) => {
          if (!isMailBannerPressTrigger(event)) return;
          event.preventDefault();
          event.stopPropagation();
          this.pressButton(record, button, event);
        });
      }
    }
    gear.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && record.menuOpen) {
        event.preventDefault();
        this.closeMenu(record, true);
        return;
      }
      if (event.key !== 'ArrowDown') return;
      event.preventDefault();
      this.openMenu(record);
    });
    menu.addEventListener('keydown', (event) => this.handleMenuKeydown(record, event));

    // The fixture build exposes the same actions as an event the page can dispatch.
    // The release build has no test hook.
    if (__SAKUTTO_FAKE_ENGINE__) {
      host.addEventListener(this.adapter.actionEvent, (event) => {
        const detail = event instanceof CustomEvent ? event.detail : null;
        if (detail === 'translate') void this.activate(record);
        if (detail === 'show-original' && mailBannerButton(record.state) === 'show-original') {
          this.restore(record);
        }
        if (
          detail === 'show-translation' &&
          mailBannerButton(record.state) === 'show-translation'
        ) {
          this.showTranslation(record);
        }
        if (detail === 'always-translate') this.setAutoLanguage(record);
        if (detail === 'never-translate') this.setNeverLanguage(record);
        if (detail === 'close') this.dismiss(record);
      });
    }

    if (options.auto === true) {
      record.autoAttempted = true;
      const autoKey = key.length > 0 ? key : '';
      if (autoKey.length > 0) this.autoPendingKeys.add(autoKey);
      void this.translate(record);
    }
    return record;
  }

  private openMenu(record: BannerRecord): void {
    if (record.menuOpen || !record.host.isConnected) return;
    if (this.openMenuRecord && this.openMenuRecord !== record) {
      this.closeMenu(this.openMenuRecord);
    }
    record.menuOpen = true;
    this.openMenuRecord = record;
    record.menu.hidden = false;
    record.gear.setAttribute('aria-expanded', 'true');
    const outside = (event: Event): void => {
      const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
      if (!path.includes(record.host)) this.closeMenu(record);
    };
    record.outsideHandler = outside;
    for (const type of ['pointerdown', 'mousedown', 'click'] as const) {
      this.doc.addEventListener(type, outside, true);
    }
    record.menu.querySelector<HTMLButtonElement>('[role^="menuitem"]')?.focus();
  }

  private closeMenu(record: BannerRecord, returnFocus = false): void {
    if (!record.menuOpen) return;
    record.menuOpen = false;
    record.menu.hidden = true;
    record.gear.setAttribute('aria-expanded', 'false');
    if (record.outsideHandler) {
      for (const type of ['pointerdown', 'mousedown', 'click'] as const) {
        this.doc.removeEventListener(type, record.outsideHandler, true);
      }
      record.outsideHandler = null;
    }
    if (this.openMenuRecord === record) this.openMenuRecord = null;
    if (returnFocus && record.gear.isConnected) record.gear.focus();
  }

  private handleMenuKeydown(record: BannerRecord, event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      this.closeMenu(record, true);
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const items = [...record.menu.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]')];
    if (items.length === 0) return;
    event.preventDefault();
    const activeElement = (record.shadow.activeElement ??
      this.doc.activeElement) as HTMLElement | null;
    const active = items.indexOf(activeElement as HTMLButtonElement);
    let index = 0;
    if (event.key === 'End') index = items.length - 1;
    else if (event.key === 'ArrowDown') index = active < 0 ? 0 : (active + 1) % items.length;
    else if (event.key === 'ArrowUp') {
      index = active < 0 ? items.length - 1 : (active - 1 + items.length) % items.length;
    }
    items[index]?.focus();
  }

  private paint(record: BannerRecord): void {
    const kind = mailBannerButton(record.state);
    if (kind === null) {
      this.closeMenu(record);
      record.host.hidden = true;
      return;
    }
    record.host.hidden = false;
    record.host.dataset[this.adapter.phaseDataset] = record.state.phase;
    record.host.dataset[this.adapter.languageDataset] = record.language;
    record.host.setAttribute('aria-label', this.labels.region);
    record.close.setAttribute('aria-label', this.labels.close);
    record.close.title = this.labels.close;
    record.gear.setAttribute('aria-label', this.labels.menu);
    record.gear.title = this.labels.menu;
    record.menu.setAttribute('aria-label', this.labels.menu);
    record.banner.classList.toggle(
      'compact',
      kind === 'show-original' || kind === 'show-translation',
    );

    const auto = isGmailAutoTranslateLanguage(record.language, this.prefs.autoLanguages ?? []);
    const never = isGmailNeverTranslateLanguage(record.language, this.prefs.neverLanguages ?? []);
    record.menuTranslate.setAttribute('aria-label', this.labels.translateNow(record.language));
    record.menuTranslate.querySelector('span:last-child')!.textContent = this.labels.translateNow(
      record.language,
    );
    record.menuAuto.setAttribute('aria-label', this.labels.alwaysTranslate(record.language));
    record.menuNever.setAttribute('aria-label', this.labels.neverTranslate(record.language));
    record.menuAuto.querySelector('span:last-child')!.textContent = this.labels.alwaysTranslate(
      record.language,
    );
    record.menuNever.querySelector('span:last-child')!.textContent = this.labels.neverTranslate(
      record.language,
    );
    record.menuAuto.setAttribute('aria-checked', auto ? 'true' : 'false');
    record.menuNever.setAttribute('aria-checked', never ? 'true' : 'false');
    record.autoCheck.textContent = auto ? '✓' : '';
    record.neverCheck.textContent = never ? '✓' : '';

    if (kind === 'show-original' || kind === 'show-translation') {
      record.text.textContent = this.labels.translated(record.language, this.prefs.targetLanguage);
      record.action.textContent =
        kind === 'show-original' ? this.labels.showOriginal : this.labels.showTranslation;
      record.action.disabled = false;
      return;
    }
    if (kind === 'error') {
      record.text.textContent = this.labels.error;
      record.action.textContent = this.labels.translate(this.prefs.targetLanguage);
      record.action.disabled = true;
      return;
    }
    if (kind === 'busy') {
      const progress = record.progress;
      if (progress && progress.totalBlocks > 0) {
        const percent = Math.min(
          100,
          Math.round((progress.completedBlocks / progress.totalBlocks) * 100),
        );
        record.text.textContent = `${this.labels.translating} ${String(percent)}%`;
      } else {
        record.text.textContent = this.labels.translating;
      }
      record.action.textContent = this.labels.translate(this.prefs.targetLanguage);
      record.action.disabled = true;
      return;
    }
    record.text.textContent = this.labels.detected(record.language);
    record.action.textContent = this.labels.translate(this.prefs.targetLanguage);
    record.action.disabled = false;
  }

  private async activate(record: BannerRecord): Promise<void> {
    const kind = mailBannerButton(record.state);
    if (kind === 'translate') {
      await this.translate(record);
      return;
    }
    if (kind === 'show-original') {
      this.restore(record);
      return;
    }
    if (kind === 'show-translation') this.showTranslation(record);
  }

  private async translate(record: BannerRecord): Promise<void> {
    record.state = mailBannerAfterTranslate(record.state);
    record.progress = null;
    record.controller = new AbortController();
    const signal = record.controller.signal;
    // Paint the busy state before the first await so the click visibly does something even
    // when the engine takes a while to open its port.
    this.paint(record);
    this.onWarm();
    try {
      const body = this.resolveRecordBody(record);
      if (!body) {
        this.failTranslation(record, 'body-not-found');
        return;
      }
      this.adoptBody(record, body);
      mailBannerDebug('translate sent', {
        body: bodyDetails(body),
        target: this.prefs.targetLanguage,
        language: record.language,
      });
      const models = await translateMailBody(
        body,
        this.engine,
        {
          targetLanguage: this.prefs.targetLanguage,
          form: this.prefs.form,
          ...(this.prefs.glossary ? { glossary: this.prefs.glossary } : {}),
          language: record.language,
          signal,
          onProgress: (progress) => {
            if (signal.aborted) return;
            record.progress = progress;
            if (record.state.phase === 'translating') this.paint(record);
          },
        },
        this.adapter,
      );
      if (signal.aborted) {
        for (const applied of models) restoreApplied(applied, this.adapter.translatedAttribute);
        return;
      }
      if (models.length === 0) {
        this.failTranslation(record, 'no-translation');
        return;
      }

      const entries = models.map((applied) => ({
        source: applied.model.source,
        text: applied.text,
      }));
      const current = this.resolveRecordBody(record);
      if (!current) {
        for (const applied of models) restoreApplied(applied, this.adapter.translatedAttribute);
        this.failTranslation(record, 'body-lost-after-translate');
        return;
      }
      if (current !== body) {
        // OWA replaced the reading-pane body while the engine was working. Undo the model
        // writes on the detached node and apply the same result to the new node.
        for (const applied of models) restoreApplied(applied, this.adapter.translatedAttribute);
        this.adoptBody(record, current);
        if (!this.applyCachedTranslation(record, entries)) {
          this.failTranslation(record, 'body-replaced-before-apply');
          return;
        }
      } else {
        this.adoptBody(record, body);
        record.models = models;
      }
      record.state = mailBannerAfterTranslated(record.state);
      mailBannerDebug('translate response', {
        models: models.length,
        applied: record.models.length,
        body: bodyDetails(record.body),
      });
    } catch (error) {
      if (!signal.aborted) {
        this.failTranslation(
          record,
          error instanceof Error ? `engine-error: ${error.message}` : 'engine-error',
        );
      }
    } finally {
      record.controller = null;
      record.progress = null;
      const key = this.recordKey(record);
      if (key.length > 0) {
        this.autoPendingKeys.delete(key);
        if (record.state.phase === 'translated') {
          this.translatedKeys.add(key);
          this.translationsByKey.set(
            key,
            record.models.map((applied) => ({
              source: applied.model.source,
              text: applied.text,
            })),
          );
        }
      }
      this.paint(record);
    }
  }

  private failTranslation(record: BannerRecord, reason: string): void {
    this.restoreRecord(record);
    record.models = [];
    record.progress = null;
    record.state = { ...record.state, phase: 'error' };
    this.paint(record);
    mailBannerDebug('translate error', { reason, body: bodyDetails(record.body) });
    if (record.errorTimer !== null) clearTimeout(record.errorTimer);
    record.errorTimer = setTimeout(() => {
      record.errorTimer = null;
      if (record.state.phase !== 'error' || !record.host.isConnected) return;
      record.state = { ...record.state, phase: 'offer' };
      this.paint(record);
    }, ERROR_VISIBLE_MS);
  }

  /** Shows the cached translation again without asking the engine. */
  private showTranslation(record: BannerRecord): void {
    if (record.state.phase !== 'original' || record.models.length === 0) return;
    record.controller?.abort();
    for (const applied of record.models) reapplyApplied(applied, this.adapter.translatedAttribute);
    record.state = mailBannerAfterShowTranslation(record.state);
    this.paint(record);
  }

  /**
   * Rebuilds the block models for a replaced message node and applies the translation
   * remembered under its message id. A provider re-renders a row rather than the whole page,
   * so this keeps the translated bar without asking for the same text again.
   */
  private applyCachedTranslation(
    record: BannerRecord,
    cached: readonly CachedTranslation[],
  ): boolean {
    const remaining = [...cached];
    const applied: AppliedBlock[] = [];
    for (const block of listTranslatableBlocks(record.body)) {
      if (isAlreadyTargetLanguage(block, this.prefs.targetLanguage, null, undefined, record.body)) {
        continue;
      }
      const model = buildSegment(block);
      if (!model) continue;
      const index = remaining.findIndex((entry) => entry.source === model.source);
      const entry = index >= 0 ? remaining.splice(index, 1)[0] : undefined;
      if (!entry) continue;
      const created: Text[] = [];
      applyTranslation(model, entry.text, created);
      model.block.setAttribute(this.adapter.translatedAttribute, '1');
      applied.push({ model, text: entry.text, created });
    }
    if (applied.length === 0) {
      mailBannerDebug('cache not applied', {
        cached: cached.length,
        body: bodyDetails(record.body),
      });
      return false;
    }
    record.models = applied;
    mailBannerDebug('cache applied', { blocks: applied.length, body: bodyDetails(record.body) });
    return true;
  }

  private restore(record: BannerRecord): void {
    if (record.state.phase !== 'translated') return;
    record.controller?.abort();
    // Keep the cached blocks so the action can toggle back without a request.
    this.restoreRecord(record, true);
    record.state = mailBannerAfterShowOriginal(record.state);
    this.paint(record);
  }

  private restoreRecord(record: BannerRecord, keepModels = false): void {
    for (const applied of record.models) restoreApplied(applied, this.adapter.translatedAttribute);
    if (!keepModels) record.models = [];
  }

  private setAutoLanguage(record: BannerRecord): void {
    const next = toggleGmailAutoTranslateLanguage(record.language, this.languageLists());
    this.prefs = {
      ...this.prefs,
      autoLanguages: next.auto,
      neverLanguages: next.never,
    };
    this.onLanguagesChange(next);
    this.paint(record);
    if (record.state.phase === 'offer' && next.auto.includes(record.language)) {
      record.autoAttempted = true;
      void this.translate(record);
    }
  }

  private setNeverLanguage(record: BannerRecord): void {
    const next = toggleGmailNeverTranslateLanguage(record.language, this.languageLists());
    this.prefs = {
      ...this.prefs,
      autoLanguages: next.auto,
      neverLanguages: next.never,
    };
    this.onLanguagesChange(next);
    if (next.never.includes(record.language)) {
      record.controller?.abort();
      this.closeMenu(record);
      this.restoreRecord(record);
      this.removeRecord(record);
      const key = this.recordKey(record);
      if (key.length > 0) {
        this.translatedKeys.delete(key);
        this.translationsByKey.delete(key);
      }
      return;
    }
    this.paint(record);
  }

  private languageLists(): GmailTranslateLanguages {
    return {
      auto: [...(this.prefs.autoLanguages ?? [])],
      never: [...(this.prefs.neverLanguages ?? [])],
    };
  }

  private dismiss(record: BannerRecord): void {
    record.controller?.abort();
    this.closeMenu(record);
    if (record.errorTimer !== null) {
      clearTimeout(record.errorTimer);
      record.errorTimer = null;
    }
    this.restoreRecord(record);
    record.state = mailBannerAfterDismiss(record.state);
    const key = this.recordKey(record);
    if (key.length > 0) this.dismissedKeys.add(key);
    record.host.remove();
    record.host.hidden = true;
  }

  private resetBanners(): void {
    for (const record of [...this.records.values()]) {
      this.closeMenu(record);
      record.controller?.abort();
      if (record.errorTimer !== null) clearTimeout(record.errorTimer);
      this.restoreRecord(record);
      record.host.remove();
    }
    this.records.clear();
    this.translatedKeys.clear();
    this.autoPendingKeys.clear();
    this.translationsByKey.clear();
  }
}

export interface MailBodyTranslationOptions {
  targetLanguage: string;
  form: Formality;
  glossary?: readonly GlossaryEntry[];
  language?: string | null;
  signal: AbortSignal;
  /** Called when the job count is known and after each block finishes. */
  onProgress?: (progress: MailBodyTranslationProgress) => void;
}

interface BlockJob {
  model: SegmentModel;
  texts: string[];
  final: boolean[];
  errors: boolean[];
  settled: boolean;
}

interface RequestOwner {
  job: BlockJob;
  index: number;
}

/**
 * Translate only the prose under one message body. The same block builder and renderer the
 * page session uses are applied to this root, so inline links and formatting keep their
 * place and Show original can put every text node back.
 */
export async function translateMailBody(
  root: Element,
  engine: PageEngine,
  options: MailBodyTranslationOptions,
  adapter: Pick<MailBannerAdapter, 'translatedAttribute'>,
): Promise<AppliedBlock[]> {
  const blocks = listTranslatableBlocks(root);
  const jobs: BlockJob[] = [];
  const requests: { id: string; text: string }[] = [];
  const owners = new Map<string, RequestOwner>();
  const skipped = {
    'already-target': 0,
    'no-segment': 0,
    'no-pieces': 0,
    'engine-error': 0,
    incomplete: 0,
    'empty-result': 0,
  };

  for (const block of blocks) {
    const model = buildSegment(block);
    if (
      isAlreadyTargetLanguage(
        block,
        options.targetLanguage,
        options.language ?? null,
        model?.source ?? '',
        root,
      )
    ) {
      skipped['already-target'] += 1;
      continue;
    }
    if (!model) {
      skipped['no-segment'] += 1;
      continue;
    }
    const pieces = chunkForTranslation(model.source);
    if (pieces.length === 0) {
      skipped['no-pieces'] += 1;
      continue;
    }
    const job: BlockJob = {
      model,
      texts: pieces.map(() => ''),
      final: pieces.map(() => false),
      errors: pieces.map(() => false),
      settled: false,
    };
    const jobIndex = jobs.length;
    jobs.push(job);
    pieces.forEach((text, index) => {
      const id = `g${String(jobIndex)}:${String(index)}`;
      requests.push({ id, text });
      owners.set(id, { job, index });
    });
  }

  const totalBlocks = jobs.length;
  const applied: AppliedBlock[] = [];
  let completedBlocks = 0;
  const reportProgress = (): void => {
    options.onProgress?.({
      totalBlocks,
      completedBlocks,
      appliedBlocks: applied.length,
    });
  };
  reportProgress();
  mailBannerDebug('translate blocks', {
    blocks: blocks.length,
    jobs: totalBlocks,
    requests: requests.length,
    skipped,
  });

  const applyJob = (job: BlockJob): boolean => {
    if (!job.final.every(Boolean) || job.errors.some(Boolean)) return false;
    const joined = joinTranslatedSentences(job.texts, options.targetLanguage);
    if (joined.trim().length === 0) return false;
    const markup = job.model.placeholder
      ? assessTranslation(joined, placeholderIds(job.model))
      : null;
    const text = markup ? (markup.ok ? markup.text : markup.plain) : stripPlaceholderTokens(joined);
    if (text.trim().length === 0) return false;
    const created: Text[] = [];
    applyTranslation(job.model, text, created);
    job.model.block.setAttribute(adapter.translatedAttribute, '1');
    applied.push({ model: job.model, text, created });
    return true;
  };

  let chunksReceived = 0;
  try {
    for await (const chunk of engine.translate(requests, {
      tgt: options.targetLanguage,
      form: options.form,
      ...(options.language ? { src: options.language } : {}),
      ...(options.glossary && options.glossary.length > 0 ? { glossary: options.glossary } : {}),
      priority: translationPriority('selection', 0, 'prose'),
      signal: options.signal,
    })) {
      if (options.signal.aborted) break;
      chunksReceived += 1;
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
      if (job.settled || !job.final.every(Boolean)) continue;
      job.settled = true;
      completedBlocks += 1;
      if (job.errors.some(Boolean)) {
        skipped['engine-error'] += 1;
      } else if (!applyJob(job)) {
        skipped['empty-result'] += 1;
      }
      reportProgress();
    }
  } catch (error) {
    // The engine can fail after only some blocks have painted. Put those back before the
    // controller shows its error state, because it never received their applied records.
    for (const block of applied) restoreApplied(block, adapter.translatedAttribute);
    applied.length = 0;
    throw error;
  } finally {
    for (const job of jobs) {
      if (!job.settled) skipped.incomplete += 1;
    }
    mailBannerDebug('translate summary', {
      blocks: blocks.length,
      jobs: totalBlocks,
      requests: requests.length,
      chunks: chunksReceived,
      completed: completedBlocks,
      applied: applied.length,
      skipped,
    });
  }
  return applied;
}

function reapplyApplied(applied: AppliedBlock, translatedAttribute: string): void {
  applyTranslation(applied.model, applied.text, applied.created);
  applied.model.block.setAttribute(translatedAttribute, '1');
}

function restoreApplied(applied: AppliedBlock, translatedAttribute: string): void {
  restoreSegment(applied.model, applied.created);
  applied.model.block.removeAttribute(translatedAttribute);
}

function bodyDetails(body: Element): string {
  const tag = body.tagName.toLowerCase();
  const id = body.id.length > 0 ? `#${body.id}` : '';
  const label = body.getAttribute('aria-label');
  const classes = [...body.classList].slice(0, 2).join('.');
  return `${tag}${id}${classes.length > 0 ? `.${classes}` : ''}${label ? `[aria-label="${label}"]` : ''}`;
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

function languageListKey(languages: readonly string[] | undefined): string {
  return [...(languages ?? [])].sort().join('\u0000');
}
