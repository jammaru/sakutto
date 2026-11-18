<script lang="ts">
  /**
   * Line-break marks over the typed page's source textarea, shown only while the
   * "line breaks in the translation" setting is `wider`.
   *
   * A native textarea cannot draw anything per line, and the classic fix — mirror the
   * text behind a transparent textarea with wider per-line gaps — would leave the caret
   * and mouse selection on the textarea's un-gapped coordinate grid, so clicking the
   * visible text would land lines away from where the reader aimed. Editing accuracy is
   * the point of this mode, so this mirror never shifts a line: it paints marks over
   * the untouched input instead. A hairline marks a break the translation keeps, and a
   * "↵" chip marks a break inside a sentence — the one the translation will join.
   *
   * The textarea's value, caret, IME, undo, and selection are never touched, and
   * nothing renders or listens here while the mode is off.
   */
  import {
    segmentSourceText,
    sourceBreakMarksFromSegments,
    type SourceBreakMark,
    type SourceLineSegment,
  } from '@/shared/source-break-marks';

  interface Props {
    /** Live textarea value. Read-only here: the marks never modify the source. */
    text: string;
    /** True only while the setting is `wider`; nothing renders otherwise. */
    enabled: boolean;
    /** The real textarea whose geometry the mirror clones. */
    source: HTMLTextAreaElement | null;
  }

  let { text, enabled, source }: Props = $props();

  let boxWidth = $state(0);
  let scrollTop = $state(0);

  let segments = $derived<readonly SourceLineSegment[]>(enabled ? segmentSourceText(text) : []);
  let marks = $derived<readonly SourceBreakMark[]>(sourceBreakMarksFromSegments(segments));
  let markByLine = $derived(new Map(marks.map((mark) => [mark.lineIndex, mark])));

  // The mirror must wrap exactly like the textarea, so it copies the textarea's inner
  // width (clientWidth already excludes the scrollbar) instead of assuming 100%.
  $effect(() => {
    const area = source;
    if (!enabled || !area) return;
    const sync = () => {
      boxWidth = area.clientWidth;
      scrollTop = area.scrollTop;
    };
    sync();
    area.addEventListener('scroll', sync);
    const observer = new ResizeObserver(sync);
    observer.observe(area);
    return () => {
      area.removeEventListener('scroll', sync);
      observer.disconnect();
    };
  });
</script>

{#if enabled && source}
  <div class="break-layer" aria-hidden="true">
    <div class="break-scroll" style:transform="translateY(-{scrollTop}px)">
      <div class="break-mirror" style:width="{boxWidth}px">
        {#each segments as segment, index (index)}
          {@const mark = markByLine.get(index)}
          <div class="mirror-line">
            {segment.text.length > 0 ? segment.text : '\u00a0'}
            {#if mark?.kind === 'mid-sentence'}
              <span class="mirror-rule mid"></span>
              <span class="mirror-chip">↵</span>
            {:else if mark}
              <span class="mirror-rule"></span>
            {/if}
          </div>
        {/each}
      </div>
    </div>
  </div>
{/if}

<style>
  .break-layer {
    position: absolute;
    inset: 0;
    overflow: hidden;
    pointer-events: none;
  }

  .break-scroll {
    display: block;
  }

  /* Same typography and padding as the textarea, plus the shared right gutter the
     chips live in (the page defines --source-break-gutter on the source box). */
  .break-mirror {
    box-sizing: border-box;
    padding: 4px var(--source-break-gutter, 2em) 0 0;
    font: inherit;
    line-height: 1.75;
    white-space: pre-wrap;
    overflow-wrap: break-word;
    color: transparent;
  }

  .mirror-line {
    position: relative;
  }

  /* The rule sits on the boundary between two line boxes, which line-height 1.75
     keeps in the whitespace between the two rows of glyphs. */
  .mirror-rule {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    border-top: 1px solid color-mix(in srgb, var(--border) 55%, transparent);
  }

  .mirror-rule.mid {
    border-top-style: dashed;
    border-top-color: color-mix(in srgb, var(--danger) 45%, transparent);
  }

  /* Anchored to the line's bottom-right corner, so a line that wrapped to the
     right margin still gets its chip beside the last row, inside the gutter. */
  .mirror-chip {
    position: absolute;
    right: calc(-1 * var(--source-break-gutter, 2em) + 0.35em);
    bottom: 0.45em;
    padding: 0 0.35em;
    border: 1px solid color-mix(in srgb, var(--danger) 55%, transparent);
    border-radius: 999px;
    color: var(--danger);
    font-size: 0.75em;
    line-height: 1.3;
  }
</style>
