/**
 * Word-box simulation for the scan fixture of the PDF quality bench.
 *
 * Kept separate from the bench runner so the geometry can be unit-tested without loading
 * pdf.js or the fake translation engine. The boxes are derived from paper.pdf's native text
 * layer; the scan fixture's page size and background come from scan.pdf.
 */

export interface ScanSourceLine {
  readonly text: string;
  readonly height: number;
  readonly box: { readonly x: number; readonly y: number; readonly width: number };
}

export interface SimulatedScanRegion {
  readonly text: string;
  readonly quad: readonly { readonly x: number; readonly y: number }[];
  readonly confidence: number;
  readonly vertical: boolean;
  readonly recognitionConfidence: number;
  readonly symbolScores: readonly number[];
}

/** Simulated detector output: perfect word boxes from a native text line. */
export function pseudoOcrRegions(lines: readonly ScanSourceLine[]): SimulatedScanRegion[] {
  const regions: SimulatedScanRegion[] = [];
  for (const line of lines) {
    const words = line.text.split(/\s+/u).filter(Boolean);
    if (words.length === 0) continue;
    // Count the single-space gaps in `total` as well as in `offset`; otherwise every word after
    // the first shifts right and the last box extends past the source line (and off the page).
    const total = words.reduce((sum, word) => sum + word.length, 0) + Math.max(0, words.length - 1);
    let offset = 0;
    for (const word of words) {
      const start = line.box.x + (offset / total) * line.box.width;
      const end = line.box.x + ((offset + word.length) / total) * line.box.width;
      const top = line.box.y;
      const bottom = top + Math.max(4, line.height);
      regions.push({
        text: word,
        quad: [
          { x: start, y: top },
          { x: end, y: top },
          { x: end, y: bottom },
          { x: start, y: bottom },
        ],
        confidence: 0.99,
        vertical: false,
        recognitionConfidence: 0.99,
        symbolScores: [],
      });
      offset += word.length + 1;
    }
  }
  // A detector has no document order. Reverse the source sequence so reading order is learned
  // from geometry, never inherited from the fixture.
  return regions.reverse();
}
