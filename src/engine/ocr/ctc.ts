import type { CtcDecodeResult, CtcOutput } from './types';

export interface CtcDecodeOptions {
  /** Append the PP-OCR dictionary's final ASCII-space class after all dictionary entries. */
  readonly useSpaceChar?: boolean;
}

function outputShape(dims: readonly number[]): { timeSteps: number; classCount: number } {
  const shape =
    dims.length === 2 ? dims : dims.length === 3 && dims[0] === 1 ? dims.slice(1) : undefined;
  if (!shape)
    throw new RangeError('CTC output must have shape [time, classes] or [1, time, classes]');
  const timeSteps = shape[0];
  const classCount = shape[1];
  if (timeSteps === undefined || !Number.isSafeInteger(timeSteps) || timeSteps <= 0) {
    throw new RangeError('CTC time dimension must be a positive integer');
  }
  if (classCount === undefined || !Number.isSafeInteger(classCount) || classCount <= 1) {
    throw new RangeError('CTC class dimension must be an integer greater than one');
  }
  return { timeSteps, classCount };
}

/**
 * Greedy single-batch CTC decoding. Dictionary entry zero is class 1; class 0 is always blank.
 * When useSpaceChar is enabled, one ASCII space is appended after the supplied dictionary.
 */
export function decodeCtcGreedy(
  output: CtcOutput,
  dictionary: readonly string[],
  options: CtcDecodeOptions = {},
): CtcDecodeResult {
  const { timeSteps, classCount } = outputShape(output.dims);
  if (output.data.length !== timeSteps * classCount) {
    throw new RangeError('CTC data length does not match its dimensions');
  }
  if (dictionary.some((symbol) => symbol.length === 0)) {
    throw new RangeError('CTC dictionary entries must not be empty');
  }
  const symbols = options.useSpaceChar ? [...dictionary, ' '] : dictionary;
  const expectedClasses = symbols.length + 1;
  if (classCount !== expectedClasses) {
    throw new RangeError(`CTC output has ${classCount} classes; expected ${expectedClasses}`);
  }

  let text = '';
  let previous = 0;
  let confidence = 0;
  const symbolScores: number[] = [];
  const symbolIndices: number[] = [];

  for (let time = 0; time < timeSteps; time += 1) {
    let bestIndex = 0;
    let bestScore = Number.NEGATIVE_INFINITY;
    const offset = time * classCount;
    for (let classIndex = 0; classIndex < classCount; classIndex += 1) {
      const score = output.data[offset + classIndex];
      if (score === undefined || !Number.isFinite(score) || score < 0 || score > 1) {
        throw new RangeError(`CTC probability at time ${time}, class ${classIndex} is invalid`);
      }
      if (score > bestScore) {
        bestIndex = classIndex;
        bestScore = score;
      }
    }

    if (bestIndex !== 0 && bestIndex !== previous) {
      const symbol = symbols[bestIndex - 1];
      if (symbol === undefined) throw new RangeError('CTC class is missing from the dictionary');
      text += symbol;
      symbolScores.push(bestScore);
      symbolIndices.push(bestIndex);
      confidence += bestScore;
    }
    previous = bestIndex;
  }

  return {
    text,
    confidence: symbolScores.length === 0 ? 0 : confidence / symbolScores.length,
    symbolScores,
    symbolIndices,
  };
}
