// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Revealer, type RevealHost, type RevealKind } from '@/dom/reveal';

interface Stage {
  revealer: Revealer;
  settled: ReturnType<typeof vi.fn>;
  /** Moves the clock and runs the frame that was asked for, if any. */
  frame(ms: number): void;
  /** Moves the clock and runs the timers that are due, as in a tab that is not shown. */
  timers(ms: number): void;
  idle(): boolean;
  /** How many frames the revealer has asked for. */
  asked(): number;
}

/** `timed`: the host gives each frame its time, as a browser does. */
function stage(timed = false): Stage {
  let now = 0;
  let pending: ((time?: number) => void) | null = null;
  let timers: { at: number; run: () => void }[] = [];
  let asked = 0;
  const settled = vi.fn();
  const host: RevealHost = {
    now: () => now,
    frame: (callback) => {
      asked += 1;
      pending = callback;
    },
    later: (ms, run) => {
      timers.push({ at: now + ms, run });
    },
    settled,
  };
  return {
    revealer: new Revealer(document, host),
    settled,
    frame(ms) {
      now += ms;
      const due = timers.filter((timer) => timer.at <= now);
      timers = timers.filter((timer) => timer.at > now);
      for (const timer of due) timer.run();
      const run = pending;
      pending = null;
      run?.(timed ? now : undefined);
    },
    timers(ms) {
      now += ms;
      const due = timers.filter((timer) => timer.at <= now);
      timers = timers.filter((timer) => timer.at > now);
      for (const timer of due) timer.run();
    },
    idle: () => pending === null && timers.length === 0,
    asked: () => asked,
  };
}

interface MotionMock {
  cancel: ReturnType<typeof vi.fn>;
  pause: ReturnType<typeof vi.fn>;
  currentTime: number;
  playState?: string;
}

function motionMock(): ReturnType<typeof vi.fn> {
  return vi.fn(() => ({ cancel: vi.fn(), pause: vi.fn(), currentTime: 0 }) as unknown as Animation);
}

/** Makes the computed style of every element answer with `extra` on top of what it has. */
function computed(extra: (element: Element) => Record<string, string>): void {
  const real = window.getComputedStyle.bind(window);
  vi.spyOn(window, 'getComputedStyle').mockImplementation((element, pseudo) => {
    const more = extra(element);
    return new Proxy(real(element, pseudo), {
      get: (style, key) =>
        typeof key === 'string' && key in more ? more[key] : Reflect.get(style, key, style),
    });
  });
}

function block(text: string, top = 10): { element: HTMLElement; motion: ReturnType<typeof vi.fn> } {
  const element = document.createElement('p');
  element.textContent = text;
  document.body.append(element);
  element.getBoundingClientRect = () => new DOMRect(0, top, 300, 40);
  const motion = motionMock();
  element.animate = motion as unknown as typeof element.animate;
  return { element, motion };
}

function offer(
  target: Stage,
  element: HTMLElement,
  index: number,
  kind: RevealKind = 'body',
): ReturnType<typeof vi.fn> {
  const apply = vi.fn(() => {
    element.textContent = `訳${String(index)}`;
  });
  target.revealer.offer({ block: element, kind, apply });
  return apply;
}

afterEach(() => {
  document.body.innerHTML = '';
  Reflect.deleteProperty(document, 'visibilityState');
  vi.restoreAllMocks();
});

/** Makes the window answer the question for reduced motion; `asked.reduce` can be changed. */
function reducedMotion(): { reduce: boolean } {
  const asked = { reduce: true };
  const list = {
    get matches(): boolean {
      return asked.reduce;
    },
  } as MediaQueryList;
  vi.spyOn(window, 'matchMedia').mockImplementation(() => list);
  return asked;
}

describe('Revealer', () => {
  it('writes a finished translation in the next frame and moves nothing before it', () => {
    const target = stage();
    const { element, motion } = block('Source');
    const apply = offer(target, element, 0);

    // Nothing happens to the source while it waits for the frame.
    expect(apply).not.toHaveBeenCalled();
    expect(motion).not.toHaveBeenCalled();
    expect(target.revealer.size).toBe(1);
    expect(target.settled).not.toHaveBeenCalled();

    target.frame(16);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(element.textContent).toBe('訳0');
    expect(motion).toHaveBeenCalled();
    // Every motion is the translation's: none of them starts before it is written.
    for (const order of motion.mock.invocationCallOrder) {
      expect(order).toBeGreaterThan(apply.mock.invocationCallOrder[0] ?? Infinity);
    }
    expect(target.idle()).toBe(true);
    expect(target.revealer.size).toBe(0);
    expect(target.settled).toHaveBeenCalledTimes(1);
  });

  /** A second block on a display whose frames are `frameMs` apart, as its motion starts. */
  function onDisplay(frameMs: number): {
    target: Stage;
    element: HTMLElement;
    motion: ReturnType<typeof vi.fn>;
    fade: MotionMock;
    blur: MotionMock;
  } {
    const target = stage(true);
    offer(target, block('First').element, 0);
    // The first frame tells the time, the next two how fast the display is.
    for (let frame = 0; frame < 3; frame += 1) target.frame(frameMs);
    const { element, motion } = block('Second', 60);
    offer(target, element, 1);
    target.frame(frameMs);
    const calls = motion.mock.calls as [Keyframe[]][];
    const of = (name: string): MotionMock =>
      motion.mock.results[calls.findIndex(([frames]) => frames.some((frame) => name in frame))]
        ?.value as MotionMock;
    return { target, element, motion, fade: of('opacity'), blur: of('filter') };
  }

  it('knows how fast the display is before the first motion starts', () => {
    const target = stage(true);
    const { element, motion } = block('Source');
    const apply = offer(target, element, 0);

    target.frame(16);
    target.frame(16);
    // Not swapped before two intervals between frames are measured: one of them may be
    // several frames of the display long.
    expect(apply).not.toHaveBeenCalled();
    expect(motion).not.toHaveBeenCalled();
    target.frame(16);
    expect(apply).toHaveBeenCalledTimes(1);
    const started = motion.mock.results as { value: MotionMock }[];
    expect(started.length).toBeGreaterThan(0);
    for (const { value } of started) expect(value.pause).not.toHaveBeenCalled();
  });

  it('starts the first motion as soon as a fast display has shown itself', () => {
    const target = stage(true);
    const { element, motion } = block('Source');
    const apply = offer(target, element, 0);

    target.frame(2);
    expect(apply).not.toHaveBeenCalled();
    // One interval this short is enough: no display skips frames into a shorter one.
    target.frame(2);
    expect(apply).toHaveBeenCalledTimes(1);
    const started = motion.mock.results as { value: MotionMock }[];
    expect(started.length).toBeGreaterThan(0);
    for (const { value } of started) expect(value.pause).toHaveBeenCalledTimes(1);
  });

  it('measures the display to the end when everything was written at once', () => {
    const target = stage(true);
    const word = block('Home');
    offer(target, word.element, 0, 'label');
    // Three frames measure two intervals, and the word is swapped. Two more are measured
    // with nothing left to write.
    for (let frame = 0; frame < 3; frame += 1) target.frame(2);
    expect(target.revealer.size).toBe(0);
    expect(target.idle()).toBe(false);
    for (let frame = 0; frame < 20; frame += 1) target.frame(32);
    expect(target.idle()).toBe(true);

    const { element, motion } = block('Source', 60);
    offer(target, element, 1);
    target.frame(2);
    const started = motion.mock.results as { value: MotionMock }[];
    expect(started.length).toBeGreaterThan(0);
    for (const { value } of started) expect(value.pause).toHaveBeenCalledTimes(1);
  });

  it('ends what is moved along in steps when it is cleared', () => {
    const { target, fade, blur } = onDisplay(2);

    target.revealer.clear();
    expect(fade.cancel).toHaveBeenCalled();
    expect(blur.cancel).toHaveBeenCalled();
    for (let frame = 0; frame < 4; frame += 1) target.frame(32);
    expect(target.idle()).toBe(true);
  });

  it('lets the browser run the motion on a display of ordinary speed', () => {
    const { target, fade, blur } = onDisplay(16);

    expect(fade.pause).not.toHaveBeenCalled();
    expect(blur.pause).not.toHaveBeenCalled();
    target.frame(16);
    expect(blur.currentTime).toBe(0);
  });

  it('moves the motion along in steps on a fast display, and ends it', () => {
    // Frames 2 ms apart: the first block is swapped at 6, the second at 8. A step comes 32 ms
    // after the one before, and the clock of the stage is at 40, 72, 104, ... when it runs.
    const { target, element, fade, blur } = onDisplay(2);

    expect(element.textContent).toBe('訳1');
    expect(fade.pause).toHaveBeenCalledTimes(1);
    expect(blur.pause).toHaveBeenCalledTimes(1);
    target.frame(32);
    expect(fade.currentTime).toBe(32);
    expect(blur.currentTime).toBe(32);
    target.frame(32);
    expect(fade.currentTime).toBe(64);
    expect(blur.currentTime).toBe(64);
    // The focus-in of a paragraph takes 220 ms: the step at 200 is still inside it.
    for (let step = 0; step < 4; step += 1) target.frame(32);
    expect(fade.currentTime).toBe(192);
    expect(fade.cancel).not.toHaveBeenCalled();
    expect(blur.cancel).not.toHaveBeenCalled();
    // The step at 232 is past it: both end, and nothing is asked for any more.
    target.frame(32);
    expect(fade.cancel).toHaveBeenCalledTimes(1);
    expect(blur.cancel).toHaveBeenCalledTimes(1);
    for (let step = 0; step < 10; step += 1) target.frame(32);
    expect(fade.cancel).toHaveBeenCalledTimes(1);
    expect(target.idle()).toBe(true);
  });

  it('does not start a stepped motion again that was cancelled', () => {
    const { target, element, blur } = onDisplay(2);

    target.revealer.forget(element);
    blur.playState = 'idle';
    blur.currentTime = -1;
    target.frame(32);
    expect(blur.currentTime).toBe(-1);
  });

  it('writes the other translations when one of them fails, then reports the failure', () => {
    const target = stage();
    const first = block('First');
    const second = block('Second');
    target.revealer.offer({
      block: first.element,
      kind: 'label',
      apply: () => {
        throw new Error('moved');
      },
    });
    const apply = offer(target, second.element, 1, 'label');

    expect(() => target.frame(16)).toThrow('moved');
    expect(apply).toHaveBeenCalledTimes(1);
    expect(target.revealer.size).toBe(0);
  });

  it('keeps one motion for a block that is offered twice and writes the newer text', () => {
    const target = stage();
    const { element, motion } = block('Source');
    const first = offer(target, element, 0);
    const second = offer(target, element, 1);

    target.frame(16);
    const fades = motion.mock.calls.filter(([frames]) =>
      (frames as Keyframe[]).some((frame) => 'opacity' in frame),
    );
    expect(fades).toHaveLength(1);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    expect(element.textContent).toBe('訳1');
  });

  /** The calls of a mocked `animate` that animate `name`. */
  function callsOf(
    motion: ReturnType<typeof vi.fn>,
    name: string,
  ): [Keyframe[], KeyframeAnimationOptions][] {
    return (motion.mock.calls as [Keyframe[], KeyframeAnimationOptions][]).filter(([frames]) =>
      frames.some((frame) => name in frame),
    );
  }

  it('names only where the translation starts, so it ends at the opacity the page gave it', () => {
    const target = stage();
    const { element, motion } = block('Source');
    offer(target, element, 0);
    target.frame(16);

    const fades = callsOf(motion, 'opacity');
    const blurs = callsOf(motion, 'filter');
    expect(fades).toHaveLength(1);
    expect(blurs).toHaveLength(1);
    const [fade, blur] = [fades[0], blurs[0]];
    // One keyframe at the start: the end is the page's own opacity and filter.
    expect(fade?.[0]).toEqual([{ opacity: 0.4, offset: 0 }]);
    expect(fade?.[1]).toEqual({ duration: 220, easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)' });
    // The blur is an animation of its own, added on top of the page's filter.
    expect(blur?.[0]).toEqual([{ filter: 'blur(4px)', offset: 0 }]);
    expect(blur?.[1]).toEqual({
      duration: 220,
      easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)',
      composite: 'add',
    });
    expect(fade?.[1].composite).toBeUndefined();
    for (const call of [fade, blur]) expect(call?.[1].fill).toBeUndefined();
  });

  it('brings a heading into focus more slowly and with more blur, and only fades a label', () => {
    const target = stage();
    const heading = block('A heading');
    const label = block('Home', 60);
    offer(target, heading.element, 0, 'heading');
    offer(target, label.element, 1, 'label');
    target.frame(16);

    expect(callsOf(heading.motion, 'opacity')).toEqual([
      [[{ opacity: 0.4, offset: 0 }], { duration: 300, easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)' }],
    ]);
    expect(callsOf(heading.motion, 'filter')[0]?.[0]).toEqual([{ filter: 'blur(6px)', offset: 0 }]);
    expect(callsOf(heading.motion, 'filter')[0]?.[1].duration).toBe(300);
    // A few words start fainter, with no blur and no rise.
    expect(callsOf(label.motion, 'opacity')).toEqual([
      [[{ opacity: 0.3, offset: 0 }], { duration: 140, easing: 'ease-out' }],
    ]);
    expect(callsOf(label.motion, 'filter')).toHaveLength(0);
    expect(callsOf(label.motion, 'translate')).toHaveLength(0);
    expect(callsOf(label.motion, 'transform')).toHaveLength(0);
  });

  it('swaps a menu word at once and only fades it in', () => {
    const target = stage();
    const { element, motion } = block('Home');
    const apply = offer(target, element, 0, 'label');
    target.frame(16);

    expect(apply).toHaveBeenCalledTimes(1);
    const [keyframes] = motion.mock.calls[0] as [Keyframe[]];
    expect(keyframes).toEqual([{ opacity: 0.3, offset: 0 }]);
  });

  it('writes a block that is off the screen at once and without motion', () => {
    const target = stage();
    const { element, motion } = block('Source', window.innerHeight + 500);
    const apply = offer(target, element, 0);

    target.frame(16);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(motion).not.toHaveBeenCalled();
  });

  it('writes a translation without motion when its frame came long after it', () => {
    const target = stage();
    const { element, motion } = block('Source');
    const apply = offer(target, element, 0);

    // A tab that was behind another window gets its next frame when it is looked at again.
    target.frame(3000);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(motion).not.toHaveBeenCalled();
  });

  it('glides what the new text displaced with a translate, which the compositor runs', () => {
    computed(() => ({ translate: 'none' }));
    const target = stage();
    const { element, motion } = block('A long source paragraph');
    const below = block('Below');
    let top = 100;
    element.getBoundingClientRect = () => new DOMRect(0, 0, 300, 80);
    below.element.getBoundingClientRect = () => new DOMRect(0, top, 300, 20);
    target.revealer.offer({
      block: element,
      kind: 'body',
      apply: () => {
        top = 60;
      },
    });

    target.frame(16);
    target.frame(200);
    const [keyframes, options] = below.motion.mock.calls[0] as [
      Keyframe[],
      KeyframeAnimationOptions,
    ];
    expect(keyframes).toEqual([{ translate: '0.00px 40.00px' }, { translate: '0px 0px' }]);
    expect(options.composite).toBeUndefined();
    // The block does not move, but its translation rises as it comes into focus.
    const rise = (motion.mock.calls as [Keyframe[]][]).find(([frames]) =>
      frames.some((frame) => 'translate' in frame),
    );
    expect(rise?.[0][0]?.translate).toBe('0.00px 4.00px');
  });

  it('takes over from a glide that is still running', () => {
    computed(() => ({ translate: 'none' }));
    const target = stage();
    const first = block('First');
    const second = block('Second');
    const below = block('Below');
    let top = 200;
    first.element.getBoundingClientRect = () => new DOMRect(0, 0, 300, 80);
    second.element.getBoundingClientRect = () => new DOMRect(0, 90, 300, 80);
    below.element.getBoundingClientRect = () => new DOMRect(0, top, 300, 20);
    target.revealer.offer({
      block: first.element,
      kind: 'label',
      apply: () => {
        top = 160;
      },
    });
    target.frame(16);
    const earlier = below.motion.mock.results[0]?.value as { cancel: ReturnType<typeof vi.fn> };
    expect(earlier.cancel).not.toHaveBeenCalled();

    target.revealer.offer({
      block: second.element,
      kind: 'label',
      apply: () => {
        top = 130;
      },
    });
    target.frame(200);
    expect(earlier.cancel).toHaveBeenCalledTimes(1);
    expect(below.motion).toHaveBeenCalledTimes(2);
    // The earlier glide is ended before the new one is measured and started.
    expect(earlier.cancel.mock.invocationCallOrder[0]).toBeLessThan(
      below.motion.mock.invocationCallOrder[1] ?? 0,
    );
    const [keyframes] = below.motion.mock.calls[1] as [Keyframe[]];
    expect(keyframes[0]?.translate).toBe('0.00px 30.00px');
  });

  it('does not try to move an inline element, which a transform cannot move', () => {
    const target = stage();
    const { element } = block('A long source paragraph');
    const below = block('Below');
    computed((other) => (other === below.element ? { display: 'inline' } : {}));
    let top = 100;
    element.getBoundingClientRect = () => new DOMRect(0, 0, 300, 80);
    below.element.getBoundingClientRect = () => new DOMRect(0, top, 300, 20);
    target.revealer.offer({
      block: element,
      kind: 'body',
      apply: () => {
        top = 60;
      },
    });

    target.frame(16);
    target.frame(200);
    expect(below.motion).not.toHaveBeenCalled();
  });

  it('does not move what is off the screen before and after', () => {
    const target = stage();
    const { element } = block('A long source paragraph');
    const below = block('Below');
    let top = window.innerHeight + 100;
    element.getBoundingClientRect = () => new DOMRect(0, 0, 300, 80);
    below.element.getBoundingClientRect = () => new DOMRect(0, top, 300, 20);
    target.revealer.offer({
      block: element,
      kind: 'body',
      apply: () => {
        top = window.innerHeight + 60;
      },
    });

    target.frame(16);
    target.frame(200);
    expect(below.motion).not.toHaveBeenCalled();
  });

  it('adds the glide to the transform of an element that has a translate of its own', () => {
    const target = stage();
    const { element } = block('A long source paragraph');
    const below = block('Below');
    let top = 100;
    element.getBoundingClientRect = () => new DOMRect(0, 0, 300, 80);
    below.element.getBoundingClientRect = () => new DOMRect(0, top, 300, 20);
    const apply = vi.fn(() => {
      top = 60;
    });
    target.revealer.offer({ block: element, kind: 'body', apply });

    target.frame(16);
    target.frame(200);
    expect(apply).toHaveBeenCalledTimes(1);
    const [keyframes, options] = below.motion.mock.calls[0] as [
      Keyframe[],
      KeyframeAnimationOptions,
    ];
    expect(keyframes[0]?.transform).toBe('translate(0.00px, 40.00px)');
    expect(options.composite).toBe('add');
  });

  /** The names of what the calls of a mocked `animate` animated. */
  function animated(motion: ReturnType<typeof vi.fn>): Set<string> {
    const names = new Set<string>();
    for (const [frames] of motion.mock.calls as [Keyframe[]][]) {
      for (const frame of frames) {
        for (const name of Object.keys(frame)) names.add(name);
      }
    }
    return names;
  }

  it('fades a block that holds something placed from outside it without a filter or a rise', () => {
    computed(() => ({ translate: 'none' }));
    const target = stage();
    const { element, motion } = block('The morning boat leaves from the east pier');
    // The badge sits in the corner of the card around the heading, not in the heading.
    const badge = document.createElement('span');
    badge.style.position = 'absolute';
    badge.textContent = 'New';
    element.append(badge);
    offer(target, element, 0);

    target.frame(16);
    target.frame(200);
    expect(element.textContent).toBe('訳0');
    const names = animated(motion);
    expect(names.has('opacity')).toBe(true);
    // Either would make the heading the box the badge is placed from, and it would jump there.
    expect(names.has('filter')).toBe(false);
    expect(names.has('translate')).toBe(false);
    expect(names.has('transform')).toBe(false);
  });

  it('blurs and lifts a block that is itself the box its contents are placed from', () => {
    computed(() => ({ translate: 'none' }));
    const target = stage();
    const { element, motion } = block('The morning boat leaves from the east pier');
    element.style.position = 'relative';
    const badge = document.createElement('span');
    badge.style.position = 'absolute';
    badge.textContent = 'New';
    element.append(badge);
    offer(target, element, 0);

    target.frame(16);
    target.frame(200);
    const names = animated(motion);
    expect(names.has('filter')).toBe(true);
    expect(names.has('translate')).toBe(true);
  });

  it('does not take a hidden box for one that would jump', () => {
    computed(() => ({ translate: 'none' }));
    const target = stage();
    const { element, motion } = block('Plan your crossing');
    const menu = document.createElement('span');
    menu.style.display = 'none';
    const entry = document.createElement('span');
    entry.style.position = 'fixed';
    menu.append(entry);
    element.append(menu);
    offer(target, element, 0);

    target.frame(16);
    target.frame(200);
    expect(animated(motion).has('filter')).toBe(true);
  });

  it('moves what is inside an element that holds a box fixed to the window, not the element', () => {
    computed(() => ({ translate: 'none' }));
    const target = stage();
    const { element } = block('A long source paragraph');
    const footer = document.createElement('div');
    const footerMotion = motionMock();
    footer.animate = footerMotion as unknown as typeof footer.animate;
    document.body.append(footer);
    const line = block('The office is open every day');
    const button = block('Back to top');
    button.element.style.position = 'fixed';
    footer.append(line.element, button.element);
    let top = 100;
    element.getBoundingClientRect = () => new DOMRect(0, 0, 300, 80);
    footer.getBoundingClientRect = () => new DOMRect(0, top, 300, 60);
    line.element.getBoundingClientRect = () => new DOMRect(0, top, 300, 20);
    // Fixed to the window: it is where it was whatever the text above does.
    button.element.getBoundingClientRect = () => new DOMRect(200, 500, 80, 30);
    target.revealer.offer({
      block: element,
      kind: 'body',
      apply: () => {
        top = 60;
      },
    });

    target.frame(16);
    target.frame(200);
    // An offset on the footer would bring the button from the window into the footer.
    expect(footerMotion).not.toHaveBeenCalled();
    expect(button.motion).not.toHaveBeenCalled();
    const [keyframes] = line.motion.mock.calls[0] as [Keyframe[]];
    expect(keyframes).toEqual([{ translate: '0.00px 40.00px' }, { translate: '0px 0px' }]);
  });

  it('glides the cells of other rows when the table sets its columns anew', () => {
    computed(() => ({ translate: 'none' }));
    const target = stage();
    const table = document.createElement('table');
    table.innerHTML =
      '<tbody><tr><td>1.</td><td>A long title in the first row</td></tr>' +
      '<tr><td>2.</td><td>Second</td></tr></tbody>';
    document.body.append(table);
    const cells = [...table.querySelectorAll('td')];
    const title = cells[1] as HTMLElement;
    const other = cells[3] as HTMLElement;
    const otherMotion = motionMock();
    title.animate = motionMock() as unknown as typeof title.animate;
    other.animate = otherMotion as unknown as typeof other.animate;
    let left = 100;
    title.getBoundingClientRect = () => new DOMRect(left, 0, 300, 20);
    // Not a sibling of the swapped cell, nor of one of its parents: the column carries it.
    other.getBoundingClientRect = () => new DOMRect(left, 20, 300, 20);
    target.revealer.offer({
      block: title,
      kind: 'body',
      apply: () => {
        left = 80;
      },
    });

    target.frame(16);
    target.frame(200);
    const [keyframes] = otherMotion.mock.calls[0] as [Keyframe[]];
    expect(keyframes).toEqual([{ translate: '20.00px 0.00px' }, { translate: '0px 0px' }]);
  });

  /** A table of two columns that is longer than the screen; the last row is under it. */
  function longTable(): {
    cells: HTMLElement[];
    shown: ReturnType<typeof vi.fn>;
    move: () => void;
  } {
    const table = document.createElement('table');
    table.innerHTML =
      '<tbody><tr><td>June 26</td><td>A title on the screen</td></tr>' +
      '<tr><td>September 30</td><td>A title far down the page</td></tr></tbody>';
    document.body.append(table);
    const cells = [...table.querySelectorAll('td')] as HTMLElement[];
    const shown = motionMock();
    for (const cell of cells) cell.animate = motionMock() as unknown as typeof cell.animate;
    (cells[1] as HTMLElement).animate = shown as unknown as typeof table.animate;
    let left = 100;
    const under = window.innerHeight + 2000;
    table.getBoundingClientRect = () => new DOMRect(0, 0, 400, under + 20);
    (cells[0] as HTMLElement).getBoundingClientRect = () => new DOMRect(0, 0, left, 20);
    (cells[1] as HTMLElement).getBoundingClientRect = () => new DOMRect(left, 0, 300, 20);
    (cells[2] as HTMLElement).getBoundingClientRect = () => new DOMRect(0, under, left, 20);
    (cells[3] as HTMLElement).getBoundingClientRect = () => new DOMRect(left, under, 300, 20);
    return {
      cells,
      shown,
      move: () => {
        left = 93;
      },
    };
  }

  it('glides the cells on the screen when text is written into their table under it', () => {
    computed(() => ({ translate: 'none' }));
    const target = stage();
    const { cells, shown, move } = longTable();
    // The date of a row far down gets shorter, and the column with it.
    target.revealer.offer({ block: cells[2] as HTMLElement, kind: 'label', apply: move });

    target.frame(16);
    const [keyframes] = shown.mock.calls[0] as [Keyframe[]];
    expect(keyframes).toEqual([{ translate: '7.00px 0.00px' }, { translate: '0px 0px' }]);
  });

  it('writes under the screen without motion while the reader scrolls, in a table too', () => {
    computed(() => ({ translate: 'none' }));
    const target = stage();
    const { cells, shown, move } = longTable();
    target.revealer.offer({ block: cells[2] as HTMLElement, kind: 'label', apply: move });
    window.dispatchEvent(new Event('wheel'));

    target.frame(16);
    expect((cells[2] as HTMLElement).getBoundingClientRect().width).toBe(93);
    expect(shown).not.toHaveBeenCalled();
  });

  it('does not take a box that is not shown for one that would jump', () => {
    computed(() => ({ translate: 'none' }));
    const target = stage();
    const { element, motion } = block('Read the timetable');
    // A menu that is closed, a tip that has faded out, and words for screen readers only.
    for (const style of [
      'position: absolute; visibility: hidden',
      'position: absolute; opacity: 0',
      'position: absolute; width: 1px; height: 1px; overflow: hidden',
    ]) {
      const hidden = document.createElement('span');
      hidden.style.cssText = style;
      hidden.textContent = 'opens in a new tab';
      element.append(hidden);
    }
    offer(target, element, 0);

    target.frame(16);
    target.frame(200);
    expect(animated(motion).has('filter')).toBe(true);
  });

  it('leaves a placed box to the box in between that it is placed from', () => {
    computed((element) =>
      element.classList.contains('track')
        ? { translate: 'none', transform: 'matrix(1, 0, 0, 1, 0, 0)' }
        : { translate: 'none' },
    );
    const target = stage();
    const { element, motion } = block('The gallery of the harbour');
    // A transform makes the track the box its contents are placed from, fixed ones too.
    const track = document.createElement('span');
    track.className = 'track';
    const zoom = document.createElement('span');
    zoom.style.position = 'fixed';
    track.append(zoom);
    element.append(track);
    offer(target, element, 0);

    target.frame(16);
    target.frame(200);
    expect(animated(motion).has('filter')).toBe(true);
  });

  it('finds a placed box in an open shadow tree', () => {
    computed(() => ({ translate: 'none' }));
    const target = stage();
    const { element, motion } = block('Back to the start');
    const host = document.createElement('span');
    const button = document.createElement('span');
    button.style.position = 'fixed';
    host.attachShadow({ mode: 'open' }).append(button);
    element.append(host);
    offer(target, element, 0);

    target.frame(16);
    target.frame(200);
    expect(animated(motion).has('opacity')).toBe(true);
    expect(animated(motion).has('filter')).toBe(false);
  });

  it('gives no motion to an element it could not look into to the end, and goes on from there', () => {
    computed(() => ({ translate: 'none' }));
    const target = stage();
    const first = block('A long source paragraph');
    // A listing of more parts than are looked into in one go.
    const listing = document.createElement('div');
    listing.innerHTML = '<span></span>'.repeat(4500);
    const listingMotion = motionMock();
    listing.animate = listingMotion as unknown as typeof listing.animate;
    document.body.append(listing);
    const part = listing.firstElementChild as HTMLElement;
    const partMotion = motionMock();
    part.animate = partMotion as unknown as typeof part.animate;
    let top = 100;
    first.element.getBoundingClientRect = () => new DOMRect(0, 0, 300, 80);
    listing.getBoundingClientRect = () => new DOMRect(0, top, 300, 60);
    part.getBoundingClientRect = () => new DOMRect(0, top, 10, 10);
    const move = (to: number): void => {
      target.revealer.offer({
        block: first.element,
        kind: 'body',
        apply: () => {
          top = to;
        },
      });
      target.frame(16);
      target.frame(200);
    };

    // What is in it is not known yet: it is not moved, and its parts are not tracked one by
    // one, which would leave no room for what comes after it.
    move(60);
    expect(listingMotion).not.toHaveBeenCalled();
    expect(partMotion).not.toHaveBeenCalled();

    // The next look goes on where the first one stopped, and finds nothing placed.
    move(30);
    const [keyframes] = listingMotion.mock.calls[0] as [Keyframe[]];
    expect(keyframes).toEqual([{ translate: '0.00px 30.00px' }, { translate: '0px 0px' }]);
  });

  it('finds the cells at the screen of a long table that is scrolled far', () => {
    computed(() => ({ translate: 'none' }));
    const target = stage();
    const table = document.createElement('table');
    table.innerHTML = `<tbody>${'<tr><td>June 26</td><td>A title</td></tr>'.repeat(600)}</tbody>`;
    document.body.append(table);
    const rows = [...table.rows];
    let reads = 0;
    let left = 100;
    // The reader is 500 rows down.
    rows.forEach((row, index) => {
      const top = (index - 500) * 20;
      row.getBoundingClientRect = () => {
        reads += 1;
        return new DOMRect(0, top, 400, 20);
      };
      const [date, title] = [...row.cells] as HTMLElement[];
      if (!date || !title) return;
      date.getBoundingClientRect = () => new DOMRect(0, top, left, 20);
      title.getBoundingClientRect = () => new DOMRect(left, top, 300, 20);
    });
    table.getBoundingClientRect = () => new DOMRect(0, -10_000, 400, 12_000);
    const shown = rows[505]?.cells[1] as HTMLElement;
    const shownMotion = motionMock();
    shown.animate = shownMotion as unknown as typeof shown.animate;
    // The date of the last row, far under the screen, gets shorter, and the column with it.
    const last = rows[599]?.cells[0] as HTMLElement;
    last.animate = motionMock() as unknown as typeof last.animate;
    target.revealer.offer({
      block: last,
      kind: 'label',
      apply: () => {
        left = 93;
      },
    });

    target.frame(16);
    const [keyframes] = shownMotion.mock.calls[0] as [Keyframe[]];
    expect(keyframes).toEqual([{ translate: '7.00px 0.00px' }, { translate: '0px 0px' }]);
    // Not every row was read to find those at the screen.
    expect(reads).toBeLessThan(150);
  });

  it('does not take its own glide for a transform that the page gave the element', () => {
    let gliding = false;
    const target = stage();
    const { element } = block('A long source paragraph');
    const below = block('Below');
    // While a glide runs, the style of the element shows the offset of that glide.
    computed((other) => ({ translate: other === below.element && gliding ? '0px 12px' : 'none' }));
    let top = 100;
    element.getBoundingClientRect = () => new DOMRect(0, 0, 300, 80);
    below.element.getBoundingClientRect = () => new DOMRect(0, top, 300, 20);
    const move = (to: number): void => {
      target.revealer.offer({
        block: element,
        kind: 'body',
        apply: () => {
          top = to;
        },
      });
      target.frame(16);
      target.frame(200);
    };
    move(60);
    expect(below.motion).toHaveBeenCalledTimes(1);

    // The page opens a box fixed to the window inside `below`, and what was known is old.
    const fixed = document.createElement('span');
    fixed.style.position = 'fixed';
    below.element.append(fixed);
    target.frame(11_000);
    gliding = true;
    const glide = below.motion.mock.results[0]?.value as MotionMock;
    glide.playState = 'running';
    move(30);
    // The offset is that of the glide, which ends: `below` is not a box that keeps the
    // fixed one, so it gets no new movement.
    expect(below.motion).toHaveBeenCalledTimes(1);

    // The glide is over, and the offset that the style still shows is the page's own: now
    // `below` is the box the fixed one is placed from, and it can be moved as one.
    glide.playState = 'finished';
    move(10);
    expect(below.motion).toHaveBeenCalledTimes(2);
  });

  it('looks again for placed boxes after a while, as a page opens and closes them', () => {
    computed(() => ({ translate: 'none' }));
    const target = stage();
    const first = block('The first paragraph');
    offer(target, first.element, 0);
    target.frame(16);
    target.frame(200);
    expect(animated(first.motion).has('filter')).toBe(true);

    // The page opens a note in the paragraph, placed from the article around it.
    const note = document.createElement('span');
    note.style.position = 'absolute';
    first.element.append(note);
    first.motion.mockClear();
    target.frame(11_000);
    offer(target, first.element, 1);
    target.frame(16);
    target.frame(200);
    expect(animated(first.motion).has('opacity')).toBe(true);
    expect(animated(first.motion).has('filter')).toBe(false);
  });

  it('writes at once while the reader is scrolling', () => {
    const target = stage();
    const { element, motion } = block('Source');
    const apply = offer(target, element, 0);
    window.dispatchEvent(new Event('wheel'));

    target.frame(16);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(motion).not.toHaveBeenCalled();
  });

  it('writes at once in a hidden tab', () => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    const target = stage();
    const { element, motion } = block('Source');
    const apply = offer(target, element, 0);

    expect(apply).toHaveBeenCalledTimes(1);
    expect(motion).not.toHaveBeenCalled();
    expect(target.idle()).toBe(true);
  });

  it('fades a block in place when reduced motion is asked for, and moves nothing', () => {
    computed(() => ({ translate: 'none' }));
    reducedMotion();
    const target = stage();
    const { element, motion } = block('A long source paragraph');
    const below = block('Below');
    let top = 100;
    element.getBoundingClientRect = () => new DOMRect(0, 0, 300, 80);
    below.element.getBoundingClientRect = () => new DOMRect(0, top, 300, 20);
    const apply = vi.fn(() => {
      top = 60;
    });
    target.revealer.offer({ block: element, kind: 'body', apply });

    target.frame(16);
    expect(apply).toHaveBeenCalledTimes(1);
    const names = animated(motion);
    expect(names.has('opacity')).toBe(true);
    expect(names.has('filter')).toBe(true);
    // Nothing rises and nothing glides: what the new text displaced is at its place at once.
    expect(names.has('translate')).toBe(false);
    expect(names.has('transform')).toBe(false);
    expect(below.motion).not.toHaveBeenCalled();
    expect(target.settled).toHaveBeenCalledTimes(1);
  });

  it('ends a stream without a movement when reduced motion is asked for', () => {
    computed(() => ({ translate: 'none', display: 'block', height: '40px' }));
    reducedMotion();
    const target = stage();
    const streamed = block('A block that streams', 0);
    const below = block('Below', 100);
    let top = 100;
    below.element.getBoundingClientRect = () => new DOMRect(0, top, 300, 20);
    target.revealer.offer({
      block: streamed.element,
      kind: 'body',
      keepHeight: true,
      apply: () => undefined,
    });
    for (let frame = 0; frame < 12; frame += 1) target.frame(16);
    // The height is kept while the text streams in: that keeps the page still.
    expect(animated(streamed.motion).has('minHeight')).toBe(true);

    target.revealer.settle(streamed.element, () => {
      top = 70;
    });
    expect(below.motion).not.toHaveBeenCalled();
  });

  it('moves things again when the request for reduced motion is taken back', () => {
    computed(() => ({ translate: 'none' }));
    const asked = reducedMotion();
    const target = stage();
    const { element } = block('A long source paragraph');
    const below = block('Below');
    let top = 100;
    element.getBoundingClientRect = () => new DOMRect(0, 0, 300, 80);
    below.element.getBoundingClientRect = () => new DOMRect(0, top, 300, 20);
    const move = (to: number): void => {
      target.revealer.offer({
        block: element,
        kind: 'body',
        apply: () => {
          top = to;
        },
      });
      target.frame(16);
      target.frame(200);
    };
    move(60);
    expect(below.motion).not.toHaveBeenCalled();

    asked.reduce = false;
    move(30);
    const [keyframes] = below.motion.mock.calls[0] as [Keyframe[]];
    expect(keyframes).toEqual([{ translate: '0.00px 30.00px' }, { translate: '0px 0px' }]);
  });

  it('writes at once when the host runs frames inline', () => {
    const { element, motion } = block('Source');
    const apply = vi.fn();
    const revealer = new Revealer(document, {
      now: () => 0,
      frame: (callback) => callback(),
      later: (_ms, callback) => callback(),
      settled: () => undefined,
    });
    revealer.offer({ block: element, kind: 'body', apply });

    expect(apply).toHaveBeenCalledTimes(1);
    expect(motion).not.toHaveBeenCalled();
  });

  it('drops a waiting translation unwritten when it is cleared', () => {
    const target = stage();
    const { element, motion } = block('Source');
    const apply = offer(target, element, 0);

    target.revealer.clear();
    expect(target.settled).toHaveBeenCalledTimes(1);
    target.frame(500);
    expect(apply).not.toHaveBeenCalled();
    expect(motion).not.toHaveBeenCalled();
    expect(element.textContent).toBe('Source');
    expect(target.revealer.size).toBe(0);
  });

  it('writes every waiting translation in document order when it is flushed', () => {
    const target = stage();
    const order: number[] = [];
    const blocks = [block('Source 0'), block('Source 1')];
    for (const index of [1, 0]) {
      const element = blocks[index]?.element;
      if (!element) continue;
      target.revealer.offer({ block: element, kind: 'body', apply: () => order.push(index) });
    }

    target.revealer.flush();
    expect(order).toEqual([0, 1]);
  });

  it('swaps every block that was offered since the last frame in one frame', () => {
    const target = stage();
    const first = block('First');
    const second = block('Second', 60);
    const applyFirst = offer(target, first.element, 0);
    const applySecond = offer(target, second.element, 1);

    target.frame(16);
    expect(applyFirst).toHaveBeenCalledTimes(1);
    expect(applySecond).toHaveBeenCalledTimes(1);
    expect(target.settled).toHaveBeenCalledTimes(1);
    expect(target.idle()).toBe(true);
  });

  it('asks for no frame and no timer once everything is written', () => {
    const { element } = block('Source');
    const frames = vi.fn();
    const apply = vi.fn();
    let now = 0;
    let pending: (() => void) | null = null;
    let timer: { at: number; run: () => void } | null = null;
    const revealer = new Revealer(document, {
      now: () => now,
      frame: (callback) => {
        frames();
        pending = callback;
      },
      later: (ms, run) => {
        timer = { at: now + ms, run };
      },
      settled: () => undefined,
    });
    const step = (ms: number): void => {
      now += ms;
      const run = pending as (() => void) | null;
      pending = null;
      run?.();
    };
    revealer.offer({ block: element, kind: 'body', apply });
    step(16);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(frames).toHaveBeenCalledTimes(1);
    expect(pending).toBeNull();
    // Nothing is left to wait for: no timer is set.
    expect(timer).toBeNull();
  });

  it('lets a kept height go when the text never finishes', () => {
    computed(() => ({ height: '40px' }));
    const target = stage();
    const { element, motion } = block('A long source paragraph');
    target.revealer.offer({ block: element, kind: 'body', apply: vi.fn(), keepHeight: true });
    target.frame(16);
    target.frame(120);
    const calls = motion.mock.calls as [Keyframe[], KeyframeAnimationOptions][];
    const kept = calls.findIndex(([frames]) => frames.some((frame) => 'minHeight' in frame));
    const keep = motion.mock.results[kept]?.value as {
      cancel: ReturnType<typeof vi.fn>;
      pause: ReturnType<typeof vi.fn>;
    };
    expect(keep.pause).toHaveBeenCalledTimes(1);

    target.frame(61_000);
    expect(keep.cancel).toHaveBeenCalledTimes(1);
  });

  it('fades the text colour of a few words that sit beside an icon, and the icon stays', () => {
    const target = stage();
    const { element, motion } = block('', 10);
    const icon = document.createElement('i');
    icon.style.color = 'rgb(0, 90, 200)';
    icon.getBoundingClientRect = () => new DOMRect(0, 10, 16, 16);
    const iconMotion = motionMock();
    icon.animate = iconMotion as unknown as typeof icon.animate;
    const words = document.createElement('span');
    words.textContent = 'Settings';
    const wordsMotion = motionMock();
    words.animate = wordsMotion as unknown as typeof words.animate;
    element.append(icon, words);
    target.revealer.offer({ block: element, kind: 'label', apply: () => undefined });

    target.frame(16);
    for (const faded of [motion, wordsMotion]) {
      expect(callsOf(faded, 'opacity')).toHaveLength(0);
      expect(callsOf(faded, 'color')[0]?.[0]).toEqual([{ color: 'transparent', offset: 0 }]);
    }
    // An icon drawn in the text colour keeps the colour it has while the words fade.
    expect(callsOf(iconMotion, 'opacity')).toHaveLength(0);
    expect(callsOf(iconMotion, 'color')).toEqual([
      [
        [
          { color: 'rgb(0, 90, 200)', textShadow: 'none' },
          { color: 'rgb(0, 90, 200)', textShadow: 'none' },
        ],
        expect.anything(),
      ],
    ]);
  });

  it('fades the text colour of a block that paints a box, not the box', () => {
    const target = stage();
    const { element, motion } = block('Sign up');
    element.style.backgroundColor = 'rgb(0, 90, 200)';
    element.style.color = 'rgb(255, 255, 255)';
    offer(target, element, 0);

    target.frame(16);
    expect(element.textContent).toBe('訳0');
    expect(callsOf(motion, 'opacity')).toHaveLength(0);
    expect(callsOf(motion, 'filter')).toHaveLength(0);
    // Only the start is named: the text comes from a part of its colour to all of it, as
    // far in as the opacity of other blocks starts, with a soft edge where they have a blur.
    expect(callsOf(motion, 'color')).toEqual([
      [
        [
          {
            color: 'color-mix(in srgb, rgb(255, 255, 255) 40%, transparent)',
            textShadow: '0 0 4px rgb(255, 255, 255)',
            offset: 0,
          },
        ],
        { duration: 220, easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)' },
      ],
    ]);
  });

  it('does not let a block flash up that the page shows fainter than the fade starts', () => {
    computed((element) => ({ translate: 'none', opacity: element.id === 'faint' ? '0.2' : '1' }));
    const target = stage();
    const faint = block('A note the page has dimmed');
    faint.element.id = 'faint';
    const plain = block('A paragraph');
    offer(target, faint.element, 0);
    offer(target, plain.element, 1);

    target.frame(16);
    expect(callsOf(plain.motion, 'opacity')).toHaveLength(1);
    // From 0.4 it would be painted brighter than the page made it, and a hidden one would show.
    expect(callsOf(faint.motion, 'opacity')).toHaveLength(0);
    expect(callsOf(faint.motion, 'filter')).toHaveLength(1);
  });

  it('keeps a button inside a block out of the motion', () => {
    const target = stage();
    const { element, motion } = block('', 10);
    const button = document.createElement('a');
    button.textContent = 'Sign up for the newsletter today';
    button.style.backgroundColor = 'rgb(0, 90, 200)';
    const buttonMotion = motionMock();
    button.animate = buttonMotion as unknown as typeof button.animate;
    element.append(button);
    const apply = vi.fn(() => {
      button.textContent = 'ニュースレターに登録する';
    });
    target.revealer.offer({ block: element, kind: 'body', apply });

    target.frame(16);
    expect(apply).toHaveBeenCalledTimes(1);
    for (const name of ['opacity', 'filter']) {
      expect(callsOf(motion, name)).toHaveLength(0);
      expect(callsOf(buttonMotion, name)).toHaveLength(0);
    }
    // The button's text fades in by its colour; its box stays as it is.
    expect(callsOf(buttonMotion, 'color')[0]?.[0][0]).toMatchObject({
      color: 'transparent',
      offset: 0,
    });
  });

  it('fades in text that was written outside the elements that were to show it', () => {
    const target = stage();
    const { element, motion } = block('', 10);
    element.style.backgroundColor = 'rgb(240, 240, 240)';
    const words = document.createElement('span');
    words.textContent = 'A sentence that is long enough to be body text.';
    const wordsMotion = motionMock();
    words.animate = wordsMotion as unknown as typeof words.animate;
    element.append(words);
    target.revealer.offer({
      block: element,
      kind: 'body',
      apply: () => {
        words.textContent = '';
        element.prepend('訳文はブロックの直下に書かれました。');
      },
    });

    // Before the write the words were in the span, which would have faded alone. Where the
    // motion goes is found after the write: the text is now in the block, beside its box.
    target.frame(16);
    expect(callsOf(wordsMotion, 'opacity')).toHaveLength(0);
    expect(callsOf(motion, 'opacity')).toHaveLength(0);
    expect(callsOf(motion, 'color')[0]?.[0][0]).toMatchObject({
      color: 'transparent',
      offset: 0,
    });
  });

  it('fades the text colour of the elements that hold the new text after the write', () => {
    const target = stage();
    const { element, motion } = block('', 10);
    element.style.backgroundColor = 'rgb(240, 240, 240)';
    const words = document.createElement('span');
    const wordsMotion = motionMock();
    words.animate = wordsMotion as unknown as typeof words.animate;
    element.append('The source sits directly in the block, beside its box.', words);
    target.revealer.offer({
      block: element,
      kind: 'body',
      apply: () => {
        (element.firstChild as Text).nodeValue = '';
        words.textContent = '訳文は内側の要素に書かれました。';
      },
    });

    // The span was empty before the write; it holds the text now, so its colour fades too.
    target.frame(16);
    for (const faded of [motion, wordsMotion]) {
      expect(callsOf(faded, 'opacity')).toHaveLength(0);
      expect(callsOf(faded, 'filter')).toHaveLength(0);
      expect(callsOf(faded, 'color')[0]?.[0]).toEqual([{ color: 'transparent', offset: 0 }]);
    }
  });

  it('counts only finished translations as finished', () => {
    const target = stage();
    const done = block('Done');
    const streaming = block('Streaming', 60);
    offer(target, done.element, 0);
    target.revealer.offer({
      block: streaming.element,
      kind: 'body',
      apply: vi.fn(),
      keepHeight: true,
    });

    expect(target.revealer.size).toBe(2);
    expect(target.revealer.finished).toBe(1);
  });

  it('holds the colour of a border that takes the text colour while the text fades', () => {
    const target = stage();
    const { element, motion } = block('Read more');
    element.style.color = 'rgb(0, 90, 200)';
    element.style.borderBottom = '2px solid rgb(0, 90, 200)';
    offer(target, element, 0);

    target.frame(16);
    const calls = motion.mock.calls as [Keyframe[], KeyframeAnimationOptions][];
    const held = calls.find(([frames]) => frames.some((frame) => 'borderBottomColor' in frame));
    expect(held?.[0]).toHaveLength(2);
    expect(held?.[0].every((frame) => frame.borderBottomColor === 'rgb(0, 90, 200)')).toBe(true);
    expect(held?.[0].some((frame) => 'color' in frame)).toBe(false);
  });

  it('keeps the height of a block that streams, and lets go when its text is finished', () => {
    const target = stage();
    const { element, motion } = block('A long source paragraph');
    computed((candidate) => (candidate === element ? { height: '80px' } : {}));
    const below = block('Below', 100);
    let top = 100;
    element.getBoundingClientRect = () => new DOMRect(0, 0, 300, 80);
    below.element.getBoundingClientRect = () => new DOMRect(0, top, 300, 20);
    const partial = vi.fn();
    target.revealer.offer({ block: element, kind: 'body', apply: partial, keepHeight: true });
    target.frame(16);
    target.frame(120);

    expect(partial).toHaveBeenCalledTimes(1);
    const calls = motion.mock.calls as [Keyframe[], KeyframeAnimationOptions][];
    const kept = calls.findIndex(([frames]) => frames.some((frame) => 'minHeight' in frame));
    expect(calls[kept]?.[0][0]?.minHeight).toBe('80.00px');
    const keep = motion.mock.results[kept]?.value as { cancel: ReturnType<typeof vi.fn> };

    const moved = below.motion.mock.calls.length;
    target.revealer.settle(element, () => {
      top = 60;
    });
    expect(keep.cancel).toHaveBeenCalledTimes(1);
    const glide = below.motion.mock.calls[moved] as [Keyframe[], KeyframeAnimationOptions];
    expect(glide[0][0]?.transform).toBe('translate(0.00px, 40.00px)');
  });

  it('writes the finished text of a block that kept no height at once', () => {
    const target = stage();
    const { element } = block('Source');
    const apply = vi.fn();
    target.revealer.settle(element, apply);
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('fades in a line that was added under its source and leaves the source alone', () => {
    const target = stage();
    const { element, motion } = block('Source');
    const line = document.createElement('sakutto-line');
    const lineMotion = motionMock();
    line.animate = lineMotion as unknown as typeof line.animate;
    target.revealer.offer({
      block: element,
      kind: 'body',
      apply: () => element.append(line),
      added: () => line,
    });

    target.frame(16);
    expect(line.parentElement).toBe(element);
    expect(lineMotion).toHaveBeenCalledWith([{ opacity: 0, offset: 0 }], expect.anything());
    expect(motion).not.toHaveBeenCalled();
  });

  it('tells a scroll of the reader from the one its own write caused', () => {
    const target = stage();
    const first = block('First');
    const applyFirst = offer(target, first.element, 0);
    // A scroll that ends where the page was: the browser holding the reader's place.
    document.dispatchEvent(new Event('scroll'));
    target.frame(16);
    expect(applyFirst).toHaveBeenCalledTimes(1);
    expect(first.motion).toHaveBeenCalled();

    const second = block('Second', 60);
    const applySecond = offer(target, second.element, 1);
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 240 });
    try {
      // The reader scrolled: the text is written without motion.
      document.dispatchEvent(new Event('scroll'));
      target.frame(16);
      expect(applySecond).toHaveBeenCalledTimes(1);
      expect(second.motion).not.toHaveBeenCalled();
    } finally {
      Reflect.deleteProperty(window, 'scrollY');
    }
  });
});

describe('Revealer, the display', () => {
  it('learns the speed of a fast display from two frames and then asks for no more', () => {
    const target = stage(true);
    target.revealer.prime();
    for (let frame = 0; frame < 2; frame += 1) {
      expect(target.idle()).toBe(false);
      target.frame(2);
    }
    expect(target.idle()).toBe(true);
    expect(target.settled).not.toHaveBeenCalled();

    // The first motion needs no frames of its own to learn the display: it is in steps.
    const { element, motion } = block('Source');
    offer(target, element, 0);
    target.frame(2);
    const started = motion.mock.results as { value: MotionMock }[];
    expect(started.length).toBeGreaterThan(0);
    for (const { value } of started) expect(value.pause).toHaveBeenCalledTimes(1);
  });

  it('stops measuring a display that never shows itself fast', () => {
    const target = stage(true);
    target.revealer.prime();
    for (let frame = 0; frame < 41; frame += 1) {
      expect(target.idle()).toBe(false);
      target.frame(16);
    }
    expect(target.idle()).toBe(true);

    // An ordinary display: the browser runs the motion.
    const { element, motion } = block('Source');
    offer(target, element, 0);
    target.frame(16);
    const started = motion.mock.results as { value: MotionMock }[];
    expect(started.length).toBeGreaterThan(0);
    for (const { value } of started) expect(value.pause).not.toHaveBeenCalled();
  });

  it('finds a fast display later, when the page was too busy to show it at the start', () => {
    const target = stage(true);
    const first = block('First');
    offer(target, first.element, 0, 'label');
    // A busy page skips frames: the first ones are several frames of the display apart.
    for (let frame = 0; frame < 3; frame += 1) target.frame(12);
    const early = first.motion.mock.results as { value: MotionMock }[];
    expect(early.length).toBeGreaterThan(0);
    for (const { value } of early) expect(value.pause).not.toHaveBeenCalled();

    // After the swap one more frame is asked for, only to measure. It comes on time.
    target.frame(2);
    const second = block('Second', 60);
    offer(target, second.element, 1, 'label');
    target.frame(2);
    const late = second.motion.mock.results as { value: MotionMock }[];
    expect(late.length).toBeGreaterThan(0);
    for (const { value } of late) expect(value.pause).toHaveBeenCalledTimes(1);
  });
});

describe('Revealer, what a swap displaces', () => {
  type Motion = ReturnType<typeof vi.fn>;

  const glidesOf = (motion: Motion): Keyframe[][] =>
    (motion.mock.calls as [Keyframe[]][])
      .map(([frames]) => frames)
      .filter((frames) => frames.some((frame) => 'translate' in frame));

  /** The options of the first movement that was started on the element. */
  const glideOptions = (motion: Motion): KeyframeAnimationOptions | undefined =>
    (motion.mock.calls as [Keyframe[], KeyframeAnimationOptions][]).find(([frames]) =>
      frames.some((frame) => 'translate' in frame),
    )?.[1];

  it('glides what is under a swapped block at once, and keeps no height on the block', () => {
    computed(() => ({ translate: 'none', display: 'block' }));
    const target = stage();
    const first = block('A long source paragraph', 0);
    const below = block('Below', 100);
    const later = block('Further down', 200);
    let short = false;
    first.element.getBoundingClientRect = () => new DOMRect(0, 0, 300, short ? 40 : 80);
    below.element.getBoundingClientRect = () => new DOMRect(0, short ? 60 : 100, 300, 20);
    later.element.getBoundingClientRect = () => new DOMRect(0, short ? 160 : 200, 300, 40);
    target.revealer.offer({
      block: first.element,
      kind: 'body',
      apply: () => {
        short = true;
      },
    });

    target.frame(16);
    for (const moved of [below, later]) {
      expect(glidesOf(moved.motion)).toEqual([
        [{ translate: '0.00px 40.00px' }, { translate: '0px 0px' }],
      ]);
      expect(glideOptions(moved.motion)).toMatchObject({
        duration: 340,
        easing: 'cubic-bezier(0.25, 0.8, 0.25, 1)',
      });
    }
    // Nothing keeps the old height or the old places for a later movement.
    const names = new Set(
      (first.motion.mock.calls as [Keyframe[]][]).flatMap(([frames]) =>
        frames.flatMap((frame) => Object.keys(frame)),
      ),
    );
    expect(names.has('minHeight')).toBe(false);
    expect(target.idle()).toBe(true);
    for (let frame = 0; frame < 4; frame += 1) target.frame(100);
    expect(glidesOf(below.motion)).toHaveLength(1);
  });

  it('gives a glide to what was written when another write of the same swap fails', () => {
    computed(() => ({ translate: 'none', display: 'block' }));
    const target = stage();
    const first = block('A long source paragraph', 0);
    const below = block('Below', 100);
    const broken = block('Cannot be written', 200);
    let short = false;
    below.element.getBoundingClientRect = () => new DOMRect(0, short ? 60 : 100, 300, 20);
    target.revealer.offer({
      block: first.element,
      kind: 'body',
      apply: () => {
        short = true;
      },
    });
    target.revealer.offer({
      block: broken.element,
      kind: 'body',
      apply: () => {
        throw new Error('write failed');
      },
    });
    expect(() => {
      target.frame(16);
    }).toThrow('write failed');
    expect(glidesOf(below.motion)).toHaveLength(1);
  });

  it('puts a block whose new text fades in at its place at once', () => {
    computed(() => ({ translate: 'none', display: 'block' }));
    const target = stage();
    // A heading that gets a line taller, the paragraph under it, a few words under that, and a
    // block that is not swapped. The three are swapped in the same frame.
    const heading = block('Heading', 0);
    const body = block('A paragraph under the heading', 50);
    const word = block('Home', 100);
    const rest = block('Not translated here', 150);
    let down = 0;
    heading.element.getBoundingClientRect = () => new DOMRect(0, 0, 300, 40 + down);
    body.element.getBoundingClientRect = () => new DOMRect(0, 50 + down, 300, 40);
    word.element.getBoundingClientRect = () => new DOMRect(0, 100 + down, 300, 20);
    rest.element.getBoundingClientRect = () => new DOMRect(0, 150 + down, 300, 40);
    target.revealer.offer({
      block: heading.element,
      kind: 'heading',
      apply: () => {
        down = 20;
      },
    });
    offer(target, body.element, 1);
    offer(target, word.element, 2, 'label');
    target.frame(16);
    expect(body.element.textContent).toBe('訳1');
    expect(word.element.textContent).toBe('訳2');
    // The paragraph and the heading only rise, each with the time of its focus-in; the few
    // words do not move at all, though the heading pushed them down.
    expect(glidesOf(body.motion).map((frames) => frames[0]?.translate)).toEqual(['0.00px 4.00px']);
    expect(glideOptions(body.motion)?.duration).toBe(220);
    expect(glidesOf(heading.motion).map((frames) => frames[0]?.translate)).toEqual([
      '0.00px 4.00px',
    ]);
    expect(glideOptions(heading.motion)?.duration).toBe(300);
    expect(glidesOf(word.motion)).toHaveLength(0);
    // What keeps its text glides from where it was.
    expect(glidesOf(rest.motion)[0]?.[0]?.translate).toBe('0.00px -20.00px');
  });

  it('does not move what is inside a block that shows new text from where the old text had it', () => {
    computed(() => ({ translate: 'none', display: 'block' }));
    const target = stage();
    const first = block('Above', 0);
    const second = block('A block with a part inside', 100);
    // A note placed from outside `second`: the block is not moved as one, so what is in it
    // is tracked by itself.
    const note = document.createElement('span');
    note.style.position = 'absolute';
    const inside = document.createElement('span');
    const insideMotion = motionMock();
    inside.animate = insideMotion as unknown as typeof inside.animate;
    second.element.append(note, inside);
    let down = 0;
    first.element.getBoundingClientRect = () => new DOMRect(0, 0, 300, 80 + down);
    second.element.getBoundingClientRect = () => new DOMRect(0, 100 + down, 300, 40);
    inside.getBoundingClientRect = () => new DOMRect(0, 110 + down, 50, 10);
    const words = second.element.firstChild as Text;
    // `first` gets taller and pushes `second` down, which is swapped in the same frame. Its new
    // text comes into focus at its place: the part inside does not glide there from where the
    // old text was.
    target.revealer.offer({
      block: first.element,
      kind: 'body',
      apply: () => {
        down = 3;
      },
    });
    target.revealer.offer({
      block: second.element,
      kind: 'body',
      apply: () => {
        words.nodeValue = '訳1';
      },
    });
    target.frame(16);
    expect(second.element.textContent).toBe('訳1');
    expect(inside.isConnected).toBe(true);
    expect(glidesOf(insideMotion)).toHaveLength(0);
    expect(glidesOf(second.motion)).toHaveLength(0);
    // The block above, whose text is new too, only rises.
    expect(glidesOf(first.motion).map((frames) => frames[0]?.translate)).toEqual(['0.00px 4.00px']);
  });

  it('glides the part inside a block that keeps its text', () => {
    computed(() => ({ translate: 'none', display: 'block' }));
    const target = stage();
    const first = block('Above', 0);
    const second = block('A block with a part inside', 100);
    const note = document.createElement('span');
    note.style.position = 'absolute';
    const inside = document.createElement('span');
    const insideMotion = motionMock();
    inside.animate = insideMotion as unknown as typeof inside.animate;
    second.element.append(note, inside);
    let down = 0;
    first.element.getBoundingClientRect = () => new DOMRect(0, 0, 300, 80 + down);
    second.element.getBoundingClientRect = () => new DOMRect(0, 100 + down, 300, 40);
    inside.getBoundingClientRect = () => new DOMRect(0, 110 + down, 50, 10);
    // The same page, but only `first` is swapped: the part is displaced and glides.
    target.revealer.offer({
      block: first.element,
      kind: 'body',
      apply: () => {
        down = 3;
      },
    });
    target.frame(16);
    expect(second.motion).not.toHaveBeenCalled();
    expect(glidesOf(insideMotion)).toEqual([
      [{ translate: '0.00px -3.00px' }, { translate: '0px 0px' }],
    ]);
  });

  it('starts no movement on an element that the new text has replaced', () => {
    computed(() => ({ translate: 'none', display: 'block' }));
    const target = stage();
    const first = block('A long source paragraph', 0);
    const below = block('Below', 100);
    const after = block('After', 200);
    let short = false;
    first.element.getBoundingClientRect = () => new DOMRect(0, 0, 300, short ? 40 : 80);
    below.element.getBoundingClientRect = () => new DOMRect(0, short ? 60 : 100, 300, 20);
    after.element.getBoundingClientRect = () => new DOMRect(0, short ? 160 : 200, 300, 20);
    // The write takes `below` off the page: there is nowhere for it to glide to.
    target.revealer.offer({
      block: first.element,
      kind: 'body',
      apply: () => {
        short = true;
        below.element.remove();
      },
    });
    target.frame(16);
    expect(first.element.isConnected).toBe(true);
    expect(glidesOf(below.motion)).toHaveLength(0);
    expect(glidesOf(after.motion)).toHaveLength(1);
  });
});

describe('Revealer, what is off the screen', () => {
  const under = (): number => window.innerHeight + 500;

  it('writes the first translation there at once and the ones that follow together', () => {
    const target = stage();
    const one = offer(target, block('One', under()).element, 1);
    target.frame(16);
    expect(one).toHaveBeenCalledTimes(1);

    const two = offer(target, block('Two', under()).element, 2);
    target.frame(16);
    const three = offer(target, block('Three', under()).element, 3);
    target.frame(16);
    // Nobody sees them, and each write lays the page out: they wait for each other.
    expect(two).not.toHaveBeenCalled();
    expect(three).not.toHaveBeenCalled();
    expect(target.revealer.size).toBe(2);
    expect(target.settled).toHaveBeenCalledTimes(1);
    // A timer brings their frame: none is asked for while they wait.
    const asked = target.asked();
    target.frame(16);
    target.frame(16);
    expect(target.asked()).toBe(asked);

    target.frame(100);
    expect(two).toHaveBeenCalledTimes(1);
    expect(three).toHaveBeenCalledTimes(1);
    expect(target.settled).toHaveBeenCalledTimes(2);
    expect(target.idle()).toBe(true);
  });

  it('writes what waits there along with a swap on the screen', () => {
    const target = stage();
    offer(target, block('One', under()).element, 1);
    target.frame(16);
    const two = offer(target, block('Two', under()).element, 2);
    target.frame(16);
    expect(two).not.toHaveBeenCalled();

    const seen = offer(target, block('Seen').element, 3);
    target.frame(16);
    expect(seen).toHaveBeenCalledTimes(1);
    expect(two).toHaveBeenCalledTimes(1);
  });

  it('keeps nothing from a reader who scrolls', () => {
    const target = stage();
    offer(target, block('One', under()).element, 1);
    target.frame(16);
    const two = offer(target, block('Two', under()).element, 2);
    target.frame(16);
    expect(two).not.toHaveBeenCalled();

    // The reader may be on the way to it: the next frame writes it, not the timer.
    window.dispatchEvent(new Event('wheel'));
    target.frame(16);
    expect(two).toHaveBeenCalledTimes(1);
  });

  it('asks for no frame for a translation that joins the ones waiting there', () => {
    const target = stage();
    offer(target, block('One', under()).element, 1);
    target.frame(16);
    offer(target, block('Two', under()).element, 2);
    target.frame(16);
    const asked = target.asked();
    const three = offer(target, block('Three', under()).element, 3);
    expect(target.asked()).toBe(asked);
    // One on the screen does not wait for them.
    const seen = offer(target, block('Seen').element, 4);
    expect(target.asked()).toBe(asked + 1);
    target.frame(16);
    expect(seen).toHaveBeenCalledTimes(1);
    expect(three).toHaveBeenCalledTimes(1);
  });

  it('does not keep the last translations of a page waiting', () => {
    const target = stage();
    offer(target, block('One', under()).element, 1);
    target.frame(16);
    const two = offer(target, block('Two', under()).element, 2);
    target.frame(16);
    expect(two).not.toHaveBeenCalled();

    // Nothing else is being translated: there is nothing to write it together with.
    const asked = target.asked();
    const last = block('Last', under());
    const apply = vi.fn();
    target.revealer.offer({ block: last.element, kind: 'body', apply, last: true });
    expect(target.asked()).toBe(asked + 1);
    target.frame(16);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(two).toHaveBeenCalledTimes(1);
  });

  it('writes what waits there when the tab is hidden before the timer comes', () => {
    const target = stage();
    offer(target, block('One', under()).element, 1);
    target.frame(16);
    const two = offer(target, block('Two', under()).element, 2);
    target.frame(16);
    expect(two).not.toHaveBeenCalled();

    // A hidden tab gets no frames, so nothing may be left to one.
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    const asked = target.asked();
    target.timers(100);
    expect(two).toHaveBeenCalledTimes(1);
    expect(target.asked()).toBe(asked);
    expect(target.revealer.size).toBe(0);
  });
});

describe('Revealer, how far things move', () => {
  function displaced(from: number, to: number): { motion: ReturnType<typeof vi.fn> } {
    const target = stage();
    const { element } = block('A long source paragraph');
    const below = block('Below');
    let top = from;
    element.getBoundingClientRect = () => new DOMRect(0, 0, 300, 80);
    below.element.getBoundingClientRect = () => new DOMRect(0, top, 300, 20);
    target.revealer.offer({
      block: element,
      kind: 'label',
      apply: () => {
        top = to;
      },
    });
    target.frame(16);
    return below;
  }

  it('puts an element that moved by a pixel at its place without a movement', () => {
    computed(() => ({ translate: 'none' }));
    expect(displaced(100, 99).motion).not.toHaveBeenCalled();
    expect(displaced(100, 98).motion).toHaveBeenCalledTimes(1);
  });

  it('glides what a taller block pushed down all the way from where it was', () => {
    computed(() => ({ translate: 'none' }));
    const start = (below: { motion: ReturnType<typeof vi.fn> }): unknown =>
      (below.motion.mock.calls[0] as [Keyframe[]])[0][0]?.translate;
    expect(start(displaced(100, 170))).toBe('0.00px -70.00px');
    expect(start(displaced(170, 100))).toBe('0.00px 70.00px');
  });

  for (const display of ['inline', 'contents']) {
    it(`glides the blocks inside a box of display ${display}, not the box`, () => {
      const target = stage();
      const { element } = block('A long source paragraph');
      const wrapper = document.createElement('span');
      const wrapperMotion = motionMock();
      wrapper.animate = wrapperMotion as unknown as typeof wrapper.animate;
      document.body.append(wrapper);
      const inside = block('Inside the wrapper');
      wrapper.append(inside.element);
      computed((other) => ({ translate: 'none', display: other === wrapper ? display : 'block' }));
      let top = 100;
      element.getBoundingClientRect = () => new DOMRect(0, 0, 300, 80);
      wrapper.getBoundingClientRect = () => new DOMRect(0, top, 300, 20);
      inside.element.getBoundingClientRect = () => new DOMRect(0, top, 300, 20);
      target.revealer.offer({
        block: element,
        kind: 'label',
        apply: () => {
          top = 60;
        },
      });

      target.frame(16);
      // A transform does not move an inline box, and the text in it would jump to its place.
      expect(wrapperMotion).not.toHaveBeenCalled();
      expect((inside.motion.mock.calls[0] as [Keyframe[]] | undefined)?.[0]).toEqual([
        { translate: '0.00px 40.00px' },
        { translate: '0px 0px' },
      ]);
    });
  }

  it('keeps no height for a block whose style gives none, as an inline box', () => {
    computed(() => ({ display: 'inline', height: 'auto' }));
    const target = stage();
    const { element, motion } = block('A long source paragraph');
    const partial = vi.fn();
    target.revealer.offer({ block: element, kind: 'body', apply: partial, keepHeight: true });
    target.frame(16);

    expect(partial).toHaveBeenCalledTimes(1);
    // A `min-height` does not hold an inline box: it would only cost the page a layout.
    const kept = (motion.mock.calls as [Keyframe[]][]).filter(([frames]) =>
      frames.some((frame) => 'minHeight' in frame),
    );
    expect(kept).toHaveLength(0);
  });
});
