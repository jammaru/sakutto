/**
 * Shows a finished translation with one short motion instead of text that fills in.
 *
 * Streaming a translation into a block rewrites the block every frame: an English paragraph
 * collapses to one Japanese line and grows again, and everything under it moves both ways.
 * Here the block keeps its source until its translation is finished. Then the text is swapped
 * in the next frame, the translation comes into focus, and what sits under the block glides
 * to its new place.
 *
 * Nothing is added to the page for this: no element, class or style rule. The motion is a set
 * of Web Animations. The opacity one names only where the translation starts from, so it
 * ends at whatever opacity the page gave the block; the blur is added on top of the page's
 * own filter, and the movements use `translate`, which leaves the page's transform alone. So
 * a block the page dims or hides is never painted more visible than the page made it, and
 * nothing can stay faded: every animation ends by itself.
 *
 * A running animation makes the browser draw every frame of the display for as long as it
 * runs, and that is what the motion costs. A display of ordinary speed is left to it: the
 * compositor runs the fade and the movements there, and the page has nothing to do. On a fast
 * display the motion is moved along in steps instead, so that it is drawn about as often as
 * streamed text would be, however fast the display is.
 *
 * Only the words take part. A block that paints a box of its own (a button, a table cell, a
 * heading with a rule under it) or holds an icon or a picture would flash as a whole, so there
 * only the text colour fades in.
 */

/**
 * A block that is still decoding this long after its first piece, or will be at the speed
 * blocks come on its page, is streamed instead. With sixteen requests decoded at a time, each
 * line of a screen of many lines takes several seconds on a fast GPU too (Hacker News: a
 * median of 5 s and up to 6.5 s per line). A shorter wait streamed nearly every block of such
 * a page letter by letter, which is what the reveal is there to replace. Past this the block
 * is slow enough that the reader is better off with a sign of progress.
 */
export const REVEAL_STREAM_AFTER_MS = 8000;
/** A finished translation older than this is written without motion (a tab that was hidden). */
const STALE_MS = 2500;
/** Motion would fight a reader who is scrolling. */
const INPUT_QUIET_MS = 180;
const INPUTS = ['wheel', 'touchmove', 'keydown'] as const;
/**
 * Translations off the screen are written this often at most. Nobody sees such a write, but
 * each one makes the browser lay the page out, and one in a table at the screen moves the
 * cells there. A page with a long table got several hundred of them, a few milliseconds
 * apart. They go along with the next swap on the screen, or together.
 */
const UNSEEN_EVERY_MS = 100;
/** A shorter way than this is not worth a movement: the element is at its place at once. */
const STILL_PX = 1.5;
/** Elements whose position is tracked for one swap. */
const MAX_MOVERS = 140;
const MAX_SIBLINGS = 80;
/** Rows of a table at the screen whose cells are tracked. */
const MAX_ROWS = 120;
/** A streamed block keeps its height this long at most. */
const KEEP_HEIGHT_MS = 30_000;
/** A block with more elements than this is not looked into; it moves as a whole. */
const SCAN_LIMIT = 160;
const INK_LIMIT = 60;
/** Longer text than this fades without the soft edge, which is painted every frame. */
const INK_SOFT_MAX_CHARS = 600;

/**
 * A display whose frames are shorter than this is a fast one (more than 200 a second). The
 * limit leaves room for a 165 Hz display whose frame times are rounded to a millisecond.
 * Measured on a 480 Hz display, running animations made the browser draw two to four times
 * the frames that streaming the text does, and its GPU process used half as much time again.
 */
const FAST_FRAME_MS = 5;
/**
 * How often the motion is moved along on a fast display. Half this step was tried for a few
 * animations at a time: a page of cards, where a few elements glide nearly all the time, then
 * drew 40 to 50 % more frames, and its process used more time than streaming the text does.
 */
const STEP_MS = 32;
/**
 * The time between two frames in a row is measured this often at most, to learn how fast the
 * display is: at the start, and then after each swap, until a fast display has shown itself.
 * A busy page skips frames, so one measurement can be a multiple of the truth, and on a page
 * that is busy when it is toggled a few in a row all were: with four of them, about half the
 * runs on a GitHub page took a display of 258 frames a second for an ordinary one, and the
 * page's process then worked twice as long.
 */
const PROBE_INTERVALS = 40;
/** No motion starts before this many of them are in. */
const FIRST_INTERVALS = 2;

const EASE_IN_FOCUS = 'cubic-bezier(0.2, 0.7, 0.2, 1)';
const EASE_GLIDE = 'cubic-bezier(0.25, 0.8, 0.25, 1)';
/**
 * One length for every movement, short or long. Shorter ones for short ways were tried: on a
 * page of rows, where each swap moves the rows under it by a few pixels, the movements then
 * no longer ran into one another, and a row moved more often (on Hacker News about five
 * times instead of three or four).
 */
const GLIDE_MS = 340;
export type RevealKind = 'body' | 'heading' | 'label';

interface Timing {
  /** How long the translation takes to come into focus. */
  in: number;
  /**
   * The opacity it starts from. Well above nothing: the source is gone in the frame of the
   * swap, and a paragraph that is nearly blank in that frame reads as a blink.
   */
  from: number;
  blur: number;
  rise: number;
  easing: string;
}

/**
 * A heading is the slow moment and body text is quick. A few words only fade in: they are too
 * short for a focus pull to read as anything but a flicker.
 */
const TIMING: Record<RevealKind, Timing> = {
  body: { in: 220, from: 0.4, blur: 4, rise: 4, easing: EASE_IN_FOCUS },
  heading: { in: 300, from: 0.4, blur: 6, rise: 4, easing: EASE_IN_FOCUS },
  label: { in: 140, from: 0.3, blur: 0, rise: 0, easing: 'ease-out' },
};

export interface RevealOffer {
  block: Element;
  kind: RevealKind;
  /** Writes the translation. Called once, or never when the offer is dropped. */
  apply: () => void;
  /**
   * For a translation that is added under its source instead of replacing it: the element
   * `apply` added. The source stays as it is and only this element fades in.
   */
  added?: () => Element | null;
  /**
   * The text is not finished and more of it will follow. The block keeps the height it has
   * until `settle`, so the text can fill in without the page under it moving.
   */
  keepHeight?: boolean;
  /**
   * Write this text without a reveal. Sentences of one block are written as they finish;
   * only the last one, in `settle`, comes into focus.
   */
  instant?: boolean;
  /**
   * Nothing else is being translated. Off the screen, the translation then has nothing to
   * wait for (see `UNSEEN_EVERY_MS`), and the page is finished no later than it was.
   */
  last?: boolean;
}

export interface RevealHost {
  now(): number;
  /**
   * Runs the callback in the next frame, with the time of that frame if the host knows it (as
   * `requestAnimationFrame` gives it). Without times every display is taken as an ordinary one.
   */
  frame(callback: (time?: number) => void): void;
  /** Runs the callback after about `ms`. */
  later(ms: number, callback: () => void): void;
  /** Every translation that was offered has been written or dropped. */
  settled(): void;
}

/** Which elements show the motion of one block. */
interface Plan {
  /**
   * `whole`: the block comes into focus. `ink`: the text colour of the block and of the
   * elements in it fades in, where the block paints a box or holds a picture.
   */
  mode: 'whole' | 'ink';
  targets: Element[];
  /** Icons that take the text colour; they keep it while the text fades. */
  pinned: Element[];
  /** Whether faded text gets a soft edge, which looks as the blur of other blocks does. */
  soft: boolean;
}

interface Entry {
  offer: RevealOffer;
  readyAt: number;
}

type Animatable = Element & {
  animate(keyframes: Keyframe[], options: KeyframeAnimationOptions): Animation;
};

function canAnimate(element: Element): element is Animatable {
  return typeof (element as Partial<Animatable>).animate === 'function';
}

function viewOf(element: Element): Window | null {
  return element.ownerDocument.defaultView;
}

function inOrder<T>(items: readonly T[], element: (item: T) => Element): T[] {
  return [...items].sort((a, b) => {
    const first = element(a);
    const second = element(b);
    if (first === second) return 0;
    const position = first.compareDocumentPosition(second);
    if ((position & Node.DOCUMENT_POSITION_FOLLOWING) !== 0) return -1;
    if ((position & Node.DOCUMENT_POSITION_PRECEDING) !== 0) return 1;
    return 0;
  });
}

/** Elements that are a picture or a control, whatever they contain. */
const GRAPHIC = new Set([
  'img',
  'svg',
  'picture',
  'video',
  'audio',
  'canvas',
  'iframe',
  'object',
  'embed',
  'input',
  'select',
  'textarea',
  'progress',
  'meter',
]);

function shows(color: string): boolean {
  if (color === '' || color === 'transparent') return false;
  return !/(?:,|\/)\s*0(?:\.0+)?%?\s*\)$/u.test(color);
}

/** Whether the element paints something besides its text. */
function paintsBox(style: CSSStyleDeclaration): boolean {
  if (style.backgroundImage !== '' && style.backgroundImage !== 'none') return true;
  if (shows(style.backgroundColor)) return true;
  if (style.boxShadow !== '' && style.boxShadow !== 'none') return true;
  const sides = [
    [style.borderTopStyle, style.borderTopWidth, style.borderTopColor],
    [style.borderRightStyle, style.borderRightWidth, style.borderRightColor],
    [style.borderBottomStyle, style.borderBottomWidth, style.borderBottomColor],
    [style.borderLeftStyle, style.borderLeftWidth, style.borderLeftColor],
  ] as const;
  return sides.some(
    ([line, width, color]) =>
      line !== '' && line !== 'none' && line !== 'hidden' && parseFloat(width) > 0 && shows(color),
  );
}

interface Scan {
  text: boolean;
  graphic: boolean;
  /** A graphic taller than a line of text. */
  big: boolean;
  /** An element under this one holds text and paints a box: a button, a badge, a code chip. */
  boxes: boolean;
  children: { element: Element; scan: Scan }[];
  graphics: Element[];
}

/** What an element holds. Null when there is more of it than `budget` allows. */
function scan(
  element: Element,
  bigAbove: number,
  budget: { left: number },
  view: Window,
): Scan | null {
  const found: Scan = {
    text: false,
    graphic: false,
    big: false,
    boxes: false,
    children: [],
    graphics: [],
  };
  for (const child of element.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      if (/\S/u.test(child.nodeValue ?? '')) found.text = true;
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    const inner = child as Element;
    const name = inner.localName;
    if (name === 'br' || name === 'wbr') continue;
    budget.left -= 1;
    if (budget.left < 0) return null;
    const below = GRAPHIC.has(name) ? null : scan(inner, bigAbove, budget, view);
    if (budget.left < 0) return null;
    if (below?.text) {
      found.text = true;
      found.children.push({ element: inner, scan: below });
      if (below.boxes || paintsBox(view.getComputedStyle(inner))) found.boxes = true;
      if (below.graphic) {
        found.graphic = true;
        found.big ||= below.big;
        found.graphics.push(...below.graphics);
      }
      continue;
    }
    // An element without text shows as a graphic if it takes up room: a picture, or an icon
    // drawn by a font or a background.
    const rect = inner.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    found.graphic = true;
    found.graphics.push(inner);
    if (rect.height > bigAbove) found.big = true;
  }
  return found;
}

function carriers(found: Scan, into: Element[]): void {
  for (const child of found.children) {
    if (into.length >= INK_LIMIT) return;
    into.push(child.element);
    carriers(child.scan, into);
  }
}

function planFor(block: Element, kind: RevealKind): Plan {
  const whole: Plan = { mode: 'whole', targets: [block], pinned: [], soft: false };
  const view = viewOf(block);
  if (!view) return whole;
  const style = view.getComputedStyle(block);
  const boxed = paintsBox(style);
  if (!boxed && !block.firstElementChild) return whole;

  const line = (parseFloat(style.fontSize) || 16) * 1.7;
  const found = scan(block, line, { left: SCAN_LIMIT }, view);
  // Too much to look into: a box is kept out of the motion all the same.
  if (!found) return boxed ? { mode: 'ink', targets: [block], pinned: [], soft: false } : whole;
  // A small icon in running text goes out of focus with the words around it. In a few words
  // it would be most of what flashes.
  const small = kind !== 'label';
  if (!boxed && !found.boxes && (!found.graphic || (small && !found.big))) return whole;

  const targets = [block];
  carriers(found, targets);
  // Text painted with a fill of its own does not follow the text colour, so a soft edge in
  // that colour would show beside it.
  const filled = style.webkitTextFillColor;
  const soft =
    (filled === undefined || filled === '' || filled === style.color) &&
    (block.textContent ?? '').length <= INK_SOFT_MAX_CHARS;
  return { mode: 'ink', targets, pinned: found.graphics, soft };
}

/**
 * The height of the block as a length that a `min-height` can keep: the one its style
 * resolves to. An inline box has none, and a `min-height` would not hold it either.
 */
function heightOf(block: Element): string | null {
  const used = parseFloat(viewOf(block)?.getComputedStyle(block).height ?? '');
  return used > 0 ? `${used.toFixed(2)}px` : null;
}

/** How long what was found about placed boxes is relied on: a page opens and closes them. */
const PLACED_FRESH_MS = 10_000;
/** Elements looked into for placed boxes within `PLACED_SLOT_MS`. */
const PLACED_LIMIT = 4000;
const PLACED_SLOT_MS = 50;
/** Something inside is fixed to the window. */
const HOLDS_FIXED = 1;
/** Something inside is placed absolutely, from the element or from a box further out. */
const HOLDS_OPEN = 2;
/** There was more to look into than the budget allowed: what is inside is not known. */
const HOLDS_UNKNOWN = 4;

/**
 * Whether a box of this style is the one its fixed and absolutely placed contents are placed
 * from, whatever its position. `gliding`: an offset this revealer gave it does not count.
 */
function containsPlaced(style: CSSStyleDeclaration, gliding = false): boolean {
  if (!gliding && (isSet(style.transform) || isSet(style.translate))) return true;
  if (isSet(style.rotate) || isSet(style.scale) || isSet(style.perspective)) return true;
  if (isSet(style.filter) || isSet(style.backdropFilter)) return true;
  if (/(?:layout|paint|strict|content)/u.test(style.contain || '')) return true;
  return /(?:transform|translate|rotate|scale|perspective|filter)/u.test(style.willChange || '');
}

/** Whether nothing of a box of this style is seen: neither it nor what is in it can jump. */
function unseen(style: CSSStyleDeclaration, placed: boolean): boolean {
  if (style.visibility === 'hidden' || style.visibility === 'collapse') return true;
  if (style.opacity === '0') return true;
  // Text for screen readers only: placed, and clipped to a pixel.
  return placed && parseFloat(style.width) <= 1 && parseFloat(style.height) <= 1;
}

/** What is known about placed boxes, and how much may still be looked into for now. */
interface Placed {
  /** The answer for every element that was looked into to the end. */
  known: WeakMap<Element, number>;
  /** Where the look into an element stopped for want of budget, and what it had found. */
  stopped: WeakMap<Node, { child: Element; bits: number }>;
  left: number;
}

function placedUnder(parent: ParentNode, view: Window, placed: Placed): number {
  const from = placed.stopped.get(parent);
  let bits = from?.bits ?? 0;
  const first = from?.child.parentNode === parent ? from.child : parent.firstElementChild;
  for (let child = first; child; child = child.nextElementSibling) {
    placed.left -= 1;
    if (placed.left < 0) {
      placed.stopped.set(parent, { child, bits });
      return HOLDS_UNKNOWN;
    }
    const style = view.getComputedStyle(child);
    if (style.display === 'none') continue;
    // A box that only passes its children on is itself no box that is placed.
    const position = style.display === 'contents' ? 'static' : style.position;
    const own = position === 'fixed' ? HOLDS_FIXED : position === 'absolute' ? HOLDS_OPEN : 0;
    // What is drawn inside a picture or a control is not placed on the page.
    const below = GRAPHIC.has(child.localName) ? 0 : placedIn(child, view, placed);
    if ((below & HOLDS_UNKNOWN) !== 0) {
      placed.stopped.set(parent, { child, bits });
      return HOLDS_UNKNOWN;
    }
    if (own === 0 && below === 0) continue;
    if (unseen(style, own !== 0)) continue;
    let inner = below;
    // A box that its contents are placed from keeps them: nothing further out re-places them.
    if (inner !== 0 && containsPlaced(style)) inner = 0;
    else if (position !== 'static' && position !== '') inner &= ~HOLDS_OPEN;
    bits |= own | inner;
  }
  placed.stopped.delete(parent);
  return bits;
}

/**
 * What `element` holds that is placed from a box outside its own parents: boxes fixed to the
 * window, and absolutely placed ones with no placed box between them and the element. When
 * there is more to look into than `placed.left` allows, the answer is `HOLDS_UNKNOWN`; the
 * next look goes on where this one stopped.
 */
function placedIn(element: Element, view: Window, placed: Placed): number {
  const had = placed.known.get(element);
  if (had !== undefined) return had;
  let bits = placedUnder(element, view, placed);
  // An open shadow tree is drawn inside the element as its own children are.
  const shadow = bits === HOLDS_UNKNOWN ? null : element.shadowRoot;
  if (shadow) bits |= placedUnder(shadow, view, placed);
  if ((bits & HOLDS_UNKNOWN) !== 0) return HOLDS_UNKNOWN;
  placed.known.set(element, bits);
  return bits;
}

function isSet(value: string | undefined): boolean {
  return value !== undefined && value !== '' && value !== 'none';
}

export class Revealer {
  private entries: Entry[] = [];
  /** Blocks whose height is kept while their text streams in. */
  private readonly keeps = new Map<Element, Animation>();
  private reduced: MediaQueryList | null = null;
  /** What each element holds that is placed from outside it (see `placedIn`). */
  private placed: Placed = { known: new WeakMap(), stopped: new WeakMap(), left: PLACED_LIMIT };
  private placedAt = Number.NEGATIVE_INFINITY;
  private placedSlot = Number.NaN;
  /** The last movement of each element. A new one takes over from where that one is. */
  private readonly glides = new WeakMap<Element, Animation>();
  /** Paused animations that are moved along in steps, with the time each one started at. */
  private readonly stepped = new Map<
    Animation,
    { from: number; duration: number; still: boolean }
  >();
  private pacing = false;
  /** The shortest time between two frames in a row: the frame of the display, once seen. */
  private frameMs = Number.POSITIVE_INFINITY;
  /** Frames that came, with a time or without. */
  private seen = 0;
  /** Frames that came with a time. */
  private timed = 0;
  /** Times between two frames in a row that were measured. */
  private measured = 0;
  private lastFrame = Number.NaN;
  private inFrame = false;
  private scheduled = false;
  /** When translations off the screen were last written. */
  private unseenAt = Number.NEGATIVE_INFINITY;
  /** What is waiting is off the screen, and a timer will ask for its frame. */
  private resting = false;
  private listening = false;
  private lastInput = Number.NEGATIVE_INFINITY;
  private scrollX = 0;
  private scrollY = 0;
  private readonly onInput = (): void => {
    this.lastInput = this.host.now();
    // What waits off the screen may be where the reader is going.
    if (this.resting) this.schedule();
  };
  private readonly onScroll = (event: Event): void => {
    const view = this.doc.defaultView;
    const target = event.target;
    // A list or a carousel that scrolls inside the page moves nothing that is shown here.
    if (!view || (target !== this.doc && target !== this.doc.documentElement)) return;
    // A write above the screen makes the browser hold the reader's place by scrolling. That
    // scroll ends where the last write left the page; one from the reader does not.
    const own =
      Math.abs(view.scrollX - this.scrollX) < 1 && Math.abs(view.scrollY - this.scrollY) < 1;
    this.scrollX = view.scrollX;
    this.scrollY = view.scrollY;
    if (!own) this.onInput();
  };

  constructor(
    private readonly doc: Document,
    private readonly host: RevealHost,
  ) {}

  /** What was offered and is not written yet. */
  get size(): number {
    return this.entries.length;
  }

  /** Finished translations that are not written yet. */
  get finished(): number {
    return this.entries.filter((entry) => entry.offer.keepHeight !== true).length;
  }

  /**
   * Learns how fast the display is before the first translation is there, so that one need
   * not wait for it. Asks for a few frames and nothing else.
   */
  prime(): void {
    if (this.seen > 0 || this.entries.length > 0 || !this.motionPossible()) return;
    this.schedule();
  }

  /** Takes a finished translation. It is written now, or with motion in the next frame. */
  offer(offer: RevealOffer): void {
    const waiting = this.entries.find((entry) => entry.offer.block === offer.block);
    if (waiting) {
      // The same block again: keep its place, write the newer text.
      waiting.offer = offer;
      return;
    }
    if (!this.motionPossible() || !canAnimate(offer.block)) {
      offer.apply();
      return;
    }
    this.entries.push({ offer, readyAt: this.host.now() });
    this.listen();
    // Off the screen while others wait there, it waits with them: their timer brings the frame.
    if (!this.resting || offer.last === true || this.onScreen(offer.block)) this.schedule();
  }

  /**
   * Reserves a block's current height while its text is filled in a sentence at a time.
   * Each sentence is written as soon as it is finished, but nothing under the block moves
   * until the reservation is let go by `settle` or `release`.
   */
  reserve(block: Element): void {
    if (!this.motionPossible() || !canAnimate(block) || this.keeps.has(block)) return;
    const height = heightOf(block);
    if (height === null) return;
    this.keep(block, height);
  }

  /**
   * Writes the finished text of a block that was streamed. If the block kept its height for
   * the stream, it lets go here and what sits under it glides to its place. With `motion`,
   * that final text also comes into focus once, as the one short reveal of the whole block.
   */
  settle(
    block: Element,
    apply: () => void,
    motion?: { kind: RevealKind; added?: () => Element | null },
  ): void {
    // A sentence that was still waiting for its frame is older than this final text. Letting
    // it through would write it back and reserve the height again after it was released.
    const waiting = this.entries.filter(
      (entry) => entry.offer.block === block && entry.offer.instant === true,
    );
    if (waiting.length > 0) {
      this.entries = this.entries.filter((entry) => !waiting.includes(entry));
      if (this.entries.length === 0) this.idle();
    }
    const keep = this.keeps.get(block);
    if (!keep) {
      apply();
      return;
    }
    this.keeps.delete(block);
    const shown = this.calm(this.host.now()) && this.onScreen(block) && this.moves();
    const before = shown ? this.movers([block]) : null;
    keep.cancel();
    try {
      apply();
    } finally {
      if (shown && motion) {
        const plan = planFor(block, motion.kind);
        const timing = TIMING[motion.kind];
        const lifts =
          plan.mode === 'whole' && timing.rise > 0
            ? new Map<Element, Timing>([[block, timing]])
            : new Map<Element, Timing>();
        if (before) this.glide(before, lifts, new Set([block]));
        const offer: RevealOffer = { block, kind: motion.kind, apply };
        if (motion.added) offer.added = motion.added;
        this.arrive({ offer, readyAt: this.host.now() }, plan);
      } else if (before) {
        this.glide(before);
      }
      this.noteScroll();
      if (this.entries.length === 0 && this.keeps.size === 0) this.unlisten();
    }
  }

  /** Ends the stream of a block whose text will not be finished by `settle`. */
  release(block: Element): void {
    this.settle(block, () => undefined);
  }

  /** Writes every waiting translation now, without motion. */
  flush(): void {
    const entries = this.take();
    try {
      this.write(entries);
    } finally {
      this.noteScroll();
      if (entries.length > 0) this.host.settled();
    }
  }

  /** Drops every waiting translation unwritten; the blocks keep what they show. */
  clear(): void {
    for (const keep of this.keeps.values()) keep.cancel();
    this.keeps.clear();
    // What is moved along in steps ends only when it is told to. The page is given back as
    // it is, so none of it may be left behind.
    for (const motion of this.stepped.keys()) motion.cancel();
    this.stepped.clear();
    if (this.take().length > 0) this.host.settled();
    else this.unlisten();
  }

  forget(block: Element): void {
    const keep = this.keeps.get(block);
    if (keep) {
      keep.cancel();
      this.keeps.delete(block);
    }
    const entry = this.entries.find((candidate) => candidate.offer.block === block);
    if (!entry) {
      if (keep && this.entries.length === 0 && this.keeps.size === 0) this.unlisten();
      return;
    }
    this.entries = this.entries.filter((candidate) => candidate !== entry);
    if (this.entries.length === 0) this.idle();
  }

  private take(): Entry[] {
    const entries = this.entries;
    this.entries = [];
    if (this.keeps.size === 0) this.unlisten();
    return entries;
  }

  private idle(): void {
    if (this.entries.length > 0) return;
    if (this.keeps.size === 0) this.unlisten();
    this.host.settled();
  }

  /** Every translation is written even when one of them fails; the first failure is thrown. */
  private write(entries: readonly Entry[]): void {
    let failed = false;
    let failure: unknown;
    for (const entry of inOrder(entries, (candidate) => candidate.offer.block)) {
      try {
        entry.offer.apply();
      } catch (error) {
        if (!failed) failure = error;
        failed = true;
      }
    }
    if (failed) throw failure;
  }

  /** Whether anything of the reveal can be seen: there is a window, and its tab is shown. */
  private motionPossible(): boolean {
    return this.doc.defaultView !== null && this.doc.visibilityState !== 'hidden';
  }

  /**
   * Whether things may move across the page. With reduced motion asked for they do not: a
   * translation still comes into focus, in place, but it does not rise, and what it displaces
   * is at its new place at once.
   */
  private moves(): boolean {
    const view = this.doc.defaultView;
    if (!view) return false;
    // The list is kept: it follows the setting when the reader changes it.
    this.reduced ??= view.matchMedia?.('(prefers-reduced-motion: reduce)') ?? null;
    return this.reduced?.matches !== true;
  }

  private calm(now: number): boolean {
    return this.motionPossible() && now - this.lastInput > INPUT_QUIET_MS;
  }

  private listen(): void {
    const view = this.doc.defaultView;
    if (this.listening || !view) return;
    this.listening = true;
    this.noteScroll();
    for (const type of INPUTS) view.addEventListener(type, this.onInput, { passive: true });
    this.doc.addEventListener('scroll', this.onScroll, { capture: true, passive: true });
  }

  private unlisten(): void {
    const view = this.doc.defaultView;
    if (!this.listening || !view) return;
    this.listening = false;
    for (const type of INPUTS) view.removeEventListener(type, this.onInput);
    this.doc.removeEventListener('scroll', this.onScroll, { capture: true });
  }

  /** Where the page is scrolled to after the last write. */
  private noteScroll(): void {
    const view = this.doc.defaultView;
    if (!view || !this.listening) return;
    this.scrollX = view.scrollX;
    this.scrollY = view.scrollY;
  }

  /** Asks for the next frame: what is waiting is swapped in it. */
  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    let inline = true;
    // Asked for from a frame, this frame is the next one of the display.
    const chained = this.inFrame;
    this.host.frame((time) => {
      this.scheduled = false;
      if (inline) {
        // A host that runs the callback at once has no frames to show a motion in.
        this.flush();
        return;
      }
      this.seen += 1;
      if (time !== undefined) {
        this.timed += 1;
        if (chained && time > this.lastFrame) {
          this.frameMs = Math.min(this.frameMs, time - this.lastFrame);
          this.measured += 1;
        }
        this.lastFrame = time;
      }
      this.inFrame = true;
      try {
        if (this.entries.length === 0) {
          // Flushed or cleared since the frame was asked for, or nothing was offered yet. The
          // display is still measured, for what comes next.
          if (this.probing(time)) this.schedule();
          return;
        }
        // One frame only tells the time. The ones after it tell how fast the display is,
        // which a motion has to know before it starts. A fast one has shown itself by then,
        // or by the first interval that is short enough.
        if (this.probing(time) && this.measured < FIRST_INTERVALS) {
          this.schedule();
          return;
        }
        let wait = 0;
        try {
          wait = this.tick();
        } finally {
          if (this.entries.length === 0) {
            this.idle();
            if (this.probing(time)) this.schedule();
          } else if (wait > 0) this.rest(wait);
          else this.schedule();
        }
      } finally {
        this.inFrame = false;
      }
    });
    inline = false;
  }

  /** Whether one more frame is worth asking for only to learn how fast the display is. */
  private probing(time: number | undefined): boolean {
    return time !== undefined && this.frameMs >= FAST_FRAME_MS && this.measured < PROBE_INTERVALS;
  }

  /**
   * Swaps in what is waiting. Returns how long what is left may still wait, in milliseconds:
   * that is only ever what is off the screen (see `UNSEEN_EVERY_MS`).
   */
  private tick(): number {
    const now = this.host.now();
    const calm = this.calm(now);
    const plain: Entry[] = [];
    const shown: Entry[] = [];
    // A reader who scrolls may be on the way to what is off the screen, and a translation
    // that has waited for a hidden tab has waited enough: those are written now.
    let pressing = false;
    for (const entry of this.entries) {
      const direct = !calm || now - entry.readyAt > STALE_MS;
      if (!direct && this.onScreen(entry.offer.block)) {
        shown.push(entry);
      } else {
        plain.push(entry);
        pressing ||= direct || entry.offer.last === true;
      }
    }
    const wait = this.unseenAt + UNSEEN_EVERY_MS - now;
    if (shown.length === 0 && !pressing && wait > 0) return wait;
    if (plain.length > 0) this.unseenAt = now;
    this.swap(shown, plain, calm);
    return 0;
  }

  /** Asks for a frame once `ms` have passed, for what is off the screen. */
  private rest(ms: number): void {
    if (this.resting) return;
    this.resting = true;
    this.host.later(ms, () => {
      this.resting = false;
      if (this.entries.length === 0) return;
      // A tab that was hidden meanwhile gets no frame: its translations are written now.
      if (this.motionPossible()) this.schedule();
      else this.flush();
    });
  }

  private onScreen(element: Element): boolean {
    const view = viewOf(element);
    if (!view) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    return rect.bottom > 0 && rect.top < view.innerHeight;
  }

  /**
   * Whether an offset or a filter on the element would place something inside it anew. Either
   * makes the element the box that its fixed and absolutely placed contents are placed from:
   * a menu that hangs from the header, a badge in the corner of a card, a button fixed to the
   * window would jump into the element and back when the animation ends. Null when there
   * was more inside the element than could be looked into now: then it is given no motion.
   */
  private anchors(element: Element): boolean | null {
    const view = viewOf(element);
    if (!view) return false;
    const now = this.host.now();
    if (now - this.placedAt > PLACED_FRESH_MS) {
      this.placed = { known: new WeakMap(), stopped: new WeakMap(), left: this.placed.left };
      this.placedAt = now;
    }
    const slot = Math.floor(now / PLACED_SLOT_MS);
    if (slot !== this.placedSlot) {
      this.placedSlot = slot;
      this.placed.left = PLACED_LIMIT;
    }
    const bits = placedIn(element, view, this.placed);
    if (bits === 0) return false;
    if ((bits & HOLDS_UNKNOWN) !== 0) return null;
    const style = view.getComputedStyle(element);
    // An element that is such a box already stays one. An offset that a glide gave it ends
    // with the glide, so that one does not count.
    const glide = this.glides.get(element)?.playState;
    if (containsPlaced(style, glide === 'running' || glide === 'paused')) return false;
    if ((bits & HOLDS_FIXED) !== 0) return true;
    return style.position === 'static' || style.position === '';
  }

  /**
   * Starts one animation. On a fast display it is paused at once and moved along in steps
   * (see `STEP_MS`); elsewhere the browser runs it.
   */
  private start(
    target: Element,
    keyframes: Keyframe[],
    options: KeyframeAnimationOptions & { duration: number },
    still = false,
  ): Animation | null {
    if (!canAnimate(target)) return null;
    let motion: Animation;
    try {
      motion = target.animate(keyframes, options);
      if (this.frameMs < FAST_FRAME_MS) {
        motion.pause();
        this.stepped.set(motion, { from: this.host.now(), duration: options.duration, still });
      }
    } catch {
      // The browser does not know this kind of animation; the text is swapped without it.
      return null;
    }
    this.pace();
    return motion;
  }

  /** Moves the paused animations along, and ends each one when its time is up. */
  private pace(): void {
    if (this.pacing || this.stepped.size === 0) return;
    this.pacing = true;
    this.host.later(STEP_MS, () => {
      this.pacing = false;
      const now = this.host.now();
      try {
        for (const [motion, at] of this.stepped) {
          const time = now - at.from;
          // One that was cancelled elsewhere must not be started again by giving it a time.
          if (time >= at.duration || motion.playState === 'idle') {
            this.stepped.delete(motion);
            motion.cancel();
          } else if (!at.still) {
            motion.currentTime = time;
          }
        }
      } finally {
        this.pace();
      }
    });
  }

  /**
   * What is drawn in the text colour without being text: icons, and borders that name no
   * colour of their own. Each is listed with the colour it has now, read before the text
   * colour starts to fade.
   */
  private pins(plan: Plan): [Element, Keyframe][] {
    const pins: [Element, Keyframe][] = [];
    for (const icon of plan.pinned) {
      const color = viewOf(icon)?.getComputedStyle(icon).color ?? '';
      if (color !== '') pins.push([icon, { color, textShadow: 'none' }]);
    }
    for (const target of plan.targets) {
      const style = viewOf(target)?.getComputedStyle(target);
      if (!style) continue;
      const frame: Keyframe = {};
      const edges = [
        ['borderTopColor', style.borderTopStyle, style.borderTopWidth, style.borderTopColor],
        [
          'borderRightColor',
          style.borderRightStyle,
          style.borderRightWidth,
          style.borderRightColor,
        ],
        [
          'borderBottomColor',
          style.borderBottomStyle,
          style.borderBottomWidth,
          style.borderBottomColor,
        ],
        ['borderLeftColor', style.borderLeftStyle, style.borderLeftWidth, style.borderLeftColor],
        ['outlineColor', style.outlineStyle, style.outlineWidth, style.outlineColor],
      ] as const;
      for (const [name, line, width, color] of edges) {
        if (line === '' || line === 'none' || line === 'auto' || !(parseFloat(width) > 0)) continue;
        if (color !== '') frame[name] = color;
      }
      if (Object.keys(frame).length > 0) pins.push([target, frame]);
    }
    return pins;
  }

  /** Holds each pinned colour for as long as the text colour is away. */
  private pin(pins: readonly [Element, Keyframe][], duration: number): void {
    for (const [element, frame] of pins) this.start(element, [frame, frame], { duration }, true);
  }

  /**
   * Writes the translations. What those in `gliding` displace moves smoothly to its place;
   * those in `plain` are written without motion. With `still` the reader is not scrolling:
   * a write without motion (under the screen, or one that waited too long) then still moves
   * the cells of its table that are on the screen smoothly, as a table sets its columns by
   * all of its rows.
   */
  private swap(gliding: readonly Entry[], plain: readonly Entry[], still: boolean): void {
    const all = [...gliding, ...plain];
    if (all.length === 0) return;
    const gone = new Set(all);
    this.entries = this.entries.filter((entry) => !gone.has(entry));

    const blocks = gliding.map((entry) => entry.offer.block);
    const moves = this.moves();
    const tables = new Set<Element>();
    if (still && moves) {
      for (const entry of plain) {
        const table = entry.offer.block.closest('table');
        if (table && !tables.has(table) && this.onScreen(table)) tables.add(table);
      }
    }
    // Everything is measured before anything is written, so a frame lays the page out once.
    const before =
      moves && (gliding.length > 0 || tables.size > 0) ? this.movers(blocks, tables) : null;
    const heights = new Map<Element, string>();
    for (const entry of all) {
      if (entry.offer.keepHeight !== true) continue;
      const height = heightOf(entry.offer.block);
      if (height !== null) heights.set(entry.offer.block, height);
    }
    let failed = false;
    let failure: unknown;
    try {
      this.write(all);
    } catch (error) {
      // What was written still gets its motion; the failure is reported after it.
      failed = true;
      failure = error;
    }
    for (const [block, height] of heights) this.keep(block, height);
    // Where the new text is, now that it is written.
    const plans = new Map<Entry, Plan>();
    for (const entry of gliding) {
      if (entry.offer.added || entry.offer.instant === true) continue;
      plans.set(entry, planFor(entry.offer.block, entry.offer.kind));
    }
    if (before) {
      const lifts = new Map<Element, Timing>();
      // Blocks that show new text. It comes into focus where it belongs, so they take their
      // place at once instead of gliding there.
      const fresh = new Set<Element>();
      for (const [entry, plan] of plans) {
        if (plan.mode !== 'whole') continue;
        fresh.add(entry.offer.block);
        const timing = TIMING[entry.offer.kind];
        if (timing.rise > 0) lifts.set(entry.offer.block, timing);
      }
      this.glide(before, lifts, fresh);
    }
    for (const entry of gliding) this.arrive(entry, plans.get(entry));
    this.noteScroll();
    if (failed) throw failure;
  }

  /** Brings the text that was just written into focus, by the elements that hold it. */
  private arrive(entry: Entry, plan: Plan | undefined): void {
    if (entry.offer.instant === true) return;
    if (entry.offer.added) {
      const line = entry.offer.added();
      if (line) {
        this.start(line, [{ opacity: 0, offset: 0 }], {
          duration: TIMING.body.in,
          easing: EASE_IN_FOCUS,
        });
      }
      return;
    }
    if (!plan) return;
    const timing = TIMING[entry.offer.kind];
    const options = { duration: timing.in, easing: timing.easing };
    if (plan.mode === 'ink') {
      // Read before the text colour starts to fade.
      const pins = this.pins(plan);
      const part = `${String(timing.from * 100)}%`;
      for (const target of plan.targets) {
        const ink = viewOf(target)?.getComputedStyle(target).color ?? '';
        const color =
          ink === '' ? 'transparent' : `color-mix(in srgb, ${ink} ${part}, transparent)`;
        const frame: Keyframe = { color, offset: 0 };
        if (timing.blur > 0 && plan.soft && ink !== '') {
          frame.textShadow = `0 0 ${String(timing.blur)}px ${ink}`;
        }
        this.start(target, [frame], options);
      }
      this.pin(pins, timing.in);
      return;
    }
    for (const target of plan.targets) {
      // A block the page shows fainter than that, or hides, must not flash up.
      const own = parseFloat(viewOf(target)?.getComputedStyle(target).opacity ?? '');
      if (!(own <= timing.from)) {
        this.start(target, [{ opacity: timing.from, offset: 0 }], options);
      }
      if (timing.blur > 0 && this.anchors(target) === false) {
        // A browser without additive animations fades without the blur.
        const blur = `blur(${String(timing.blur)}px)`;
        this.start(target, [{ filter: blur, offset: 0 }], { ...options, composite: 'add' });
      }
    }
  }

  private keep(block: Element, height: string): void {
    if (!canAnimate(block) || this.keeps.has(block)) return;
    let keep: Animation;
    try {
      // Paused, the animation holds the height without asking the page for a layout in every
      // frame, which a running one does.
      keep = block.animate([{ minHeight: height }, { minHeight: height }], { duration: 1000 });
      keep.pause();
    } catch {
      return;
    }
    this.keeps.set(block, keep);
    this.listen();
    this.host.later(KEEP_HEIGHT_MS, () => {
      // The text never finished. The height is let go so that nothing of this stays.
      if (this.keeps.get(block) === keep) this.release(block);
    });
  }

  /**
   * Moves every element from where it was before a write to where it is now. A block in
   * `lifts` holds a translation that comes into focus: it rises a little as it does. A block
   * in `fresh` shows new text: it is at its place from the start, and what is inside it is
   * not moved from where the old text had it.
   */
  private glide(
    before: ReadonlyMap<Element, DOMRect>,
    lifts: ReadonlyMap<Element, Timing> = new Map(),
    fresh: ReadonlySet<Element> = new Set(),
  ): void {
    // `before` saw each element where an earlier movement had brought it. That one ends here
    // and the new movement starts from the same place.
    for (const element of before.keys()) this.glides.get(element)?.cancel();
    const shift = new Map<Element, { x: number; y: number; free: boolean }>();
    for (const [element, was] of before) {
      // Taken off the page by the write: it has no place to go to.
      if (!element.isConnected) continue;
      const view = viewOf(element);
      const style = view?.getComputedStyle(element);
      if (style?.display === 'inline' || style?.display === 'contents') continue;
      // Moved as one, the element would take along what is placed from outside it. What is
      // in it is tracked by itself (see `movers`).
      if (this.anchors(element) !== false) continue;
      const rect = element.getBoundingClientRect();
      // What was off the screen and still is moves where nobody sees it.
      const height = view?.innerHeight ?? 0;
      if (
        (was.bottom <= 0 || was.top >= height) &&
        (rect.bottom <= 0 || rect.top >= height) &&
        !lifts.has(element)
      ) {
        continue;
      }
      shift.set(element, {
        x: was.left - rect.left,
        y: was.top - rect.top,
        free: style?.translate === 'none',
      });
    }
    for (const [element, moved] of shift) {
      let { x, y } = moved;
      // An element inside another one that glides is carried along by it.
      let carried = false;
      let renewed = false;
      for (let up = element.parentElement; up; up = up.parentElement) {
        if (fresh.has(up)) {
          renewed = true;
          break;
        }
        if (carried) {
          if (fresh.size === 0) break;
          continue;
        }
        const outer = shift.get(up);
        if (!outer) continue;
        x -= outer.x;
        y -= outer.y;
        carried = true;
      }
      // Inside a block that shows new text: where it was belonged to the old text.
      if (renewed) continue;
      const lift = lifts.get(element);
      if (fresh.has(element)) {
        x = 0;
        y = lift ? lift.rise : 0;
      }
      if (Math.abs(x) < STILL_PX && Math.abs(y) < STILL_PX) continue;
      if (lift) this.move(element, x, y, moved.free, lift.in, lift.easing);
      else this.move(element, x, y, moved.free, GLIDE_MS, EASE_GLIDE);
    }
    for (const [element, lift] of lifts) {
      if (shift.has(element)) continue;
      const style = viewOf(element)?.getComputedStyle(element);
      // A transform does not move an inline element. Animating one shows nothing, and the
      // compositor cannot run it, so it would only cost the page a frame for each frame shown.
      if (style?.display === 'inline' || style?.display === 'contents') continue;
      if (this.anchors(element) !== false) continue;
      this.move(element, 0, lift.rise, style?.translate === 'none', lift.in, lift.easing);
    }
  }

  /**
   * Brings an element from an offset to its place. `translate` is animated where the page has
   * not set it: the compositor runs that, and the page's own transform stays as it is. An
   * element that has a `translate` of its own, or a browser that does not know the property,
   * gets the offset added to its transform, which costs the page a frame for each frame shown.
   */
  private move(
    element: Element,
    x: number,
    y: number,
    free: boolean,
    duration: number,
    easing: string,
  ): void {
    const from = [`${x.toFixed(2)}px`, `${y.toFixed(2)}px`];
    const motion = free
      ? this.start(element, [{ translate: from.join(' ') }, { translate: '0px 0px' }], {
          duration,
          easing,
        })
      : this.start(
          element,
          [{ transform: `translate(${from.join(', ')})` }, { transform: 'none' }],
          { duration, easing, composite: 'add' },
        );
    if (motion) this.glides.set(element, motion);
  }

  /**
   * Where the elements that a change of these blocks can move are now: the blocks, and the
   * siblings of each block and of each of its ancestors. Siblings before a block count too,
   * because a centred or bottom-aligned layout moves them. Of those only what is near the
   * screen counts. The cells at the screen of the blocks' tables and of `tables` come last,
   * and where an element cannot be moved as one, its children are tracked too.
   */
  private movers(
    blocks: readonly Element[],
    tables: ReadonlySet<Element> = new Set(),
  ): Map<Element, DOMRect> {
    const found = new Map<Element, DOMRect>();
    const height = viewOf(blocks[0] ?? this.doc.documentElement)?.innerHeight ?? 0;
    const room = MAX_MOVERS;
    const add = (element: Element, rect: DOMRect): void => {
      if (found.size >= room || found.has(element)) return;
      const empty = rect.width === 0 || rect.height === 0;
      if (empty && !element.firstElementChild) return;
      // An inline box, or one that only passes its children on (a custom element is one or
      // the other unless the page styles it), cannot be moved; the boxes in it can.
      const display = viewOf(element)?.getComputedStyle(element).display;
      if (display !== 'inline' && display !== 'contents') {
        if (empty) return;
        found.set(element, rect);
        // An element that cannot be moved as one (see `anchors`): what is in it moves by
        // itself. Where that is not known, the room is not spent on what is in it.
        if (this.anchors(element) !== true) return;
      } else if (GRAPHIC.has(element.localName)) {
        return;
      }
      let seen = 0;
      for (let child = element.firstElementChild; child; child = child.nextElementSibling) {
        seen += 1;
        if (seen > MAX_SIBLINGS || found.size >= room) return;
        const inner = child.getBoundingClientRect();
        if (inner.bottom < -300 || inner.top > height + 300) continue;
        add(child, inner);
      }
    };
    for (const block of blocks) add(block, block.getBoundingClientRect());
    // A table sizes its columns by what is in them: text of another length in one cell
    // moves the cells of every row sideways, and those are no siblings of the block.
    const seen = new Set<Element>();
    const cells = (table: Element | null): void => {
      if (!table || seen.has(table)) return;
      seen.add(table);
      const rows = (table as Partial<HTMLTableElement>).rows;
      if (!rows) return;
      // The rows come from the top down. The first one that is not above the screen is found
      // by halving, so a long table that is scrolled far costs no more than a short one.
      let low = 0;
      let high = rows.length;
      while (low < high) {
        const middle = (low + high) >> 1;
        const row = rows[middle];
        if (row && row.getBoundingClientRect().bottom < -300) low = middle + 1;
        else high = middle;
      }
      for (let index = low; index < rows.length && index < low + MAX_ROWS; index += 1) {
        const row = rows[index];
        if (!row || found.size >= room) return;
        // Under the screen there is nothing more to track.
        if (row.getBoundingClientRect().top > height + 300) return;
        for (const cell of row.cells) add(cell, cell.getBoundingClientRect());
      }
    };
    const top = -300;
    const bottom = height + 300;
    const walk = (from: Element, step: (element: Element) => Element | null): void => {
      let seen = 0;
      for (let other = step(from); other; other = step(other)) {
        seen += 1;
        if (seen > MAX_SIBLINGS || found.size >= room) return;
        // Tracked already, from another block: its rectangle need not be read again.
        if (found.has(other)) continue;
        const rect = other.getBoundingClientRect();
        if (rect.top > bottom || (rect.bottom < top && rect.height > 0)) return;
        add(other, rect);
      }
    };
    // What comes after the blocks first: that is what a block of another height moves. What
    // comes before them moves only where the layout is centred or aligned to the bottom.
    const steps = [
      (other: Element): Element | null => other.nextElementSibling,
      (other: Element): Element | null => other.previousElementSibling,
    ];
    for (const step of steps) {
      for (const block of blocks) {
        const body = block.ownerDocument.body as Element | null;
        if (!viewOf(block) || !body) continue;
        let element: Element | null = block;
        while (element && element !== body) {
          walk(element, step);
          element = element.parentElement;
        }
      }
    }
    // The cells come last: what is beside and under the blocks moves further than a column.
    for (const block of blocks) cells(block.closest('table'));
    for (const table of tables) cells(table);
    return found;
  }
}
