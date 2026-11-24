import { createHash } from 'node:crypto';
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import * as ort from 'onnxruntime-web/wasm';
import { DEFAULT_RECOGNITION_MAX_WIDTH } from '../../src/engine/ocr/image.ts';
import { OcrPipeline, type OcrPipelineConfig } from '../../src/engine/ocr/pipeline.ts';
import type { ImageDataLike, OcrResult, OcrRunner, OcrTensor } from '../../src/engine/ocr/types.ts';

export const PAIRINGS = [
  'tiny_det+small_rec',
  'small_det+small_rec',
  'medium_det+medium_rec',
] as const;
export type Pairing = (typeof PAIRINGS)[number];
export interface ModelPin {
  id: string;
  commit: string;
  size: number;
  sha256: string;
  url: string;
}
export interface LoadedPairing {
  readonly pipeline: OcrPipeline;
  readonly runner: OcrRunner;
  readonly dictionary: readonly string[];
  readonly detection: NonNullable<OcrPipelineConfig['detection']>;
  readonly initializationMs: number;
  readonly models: readonly ModelPin[];
  release(): Promise<void>;
}
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const DEFAULT_MODEL_DIRECTORY = '/tmp/sakutto-ppocrv6-verify';

export async function catalogPins(): Promise<Record<string, ModelPin>> {
  const catalog = await readFile(join(ROOT, 'src/engine/ocr/catalog.ts'), 'utf8');
  const pins: Record<string, ModelPin> = {};
  for (const id of ['tiny_det', 'small_det', 'medium_det', 'small_rec', 'medium_rec']) {
    const block = new RegExp('  ' + id + ': model\\(([\\s\\S]*?)\\n  \\),').exec(catalog)?.[1];
    if (!block) throw new Error('Catalog entry not found: ' + id);
    const strings = [...block.matchAll(/'([0-9a-f]{40}|[0-9a-f]{64})'/g)].map((match) => match[1]);
    const commit = strings.find((value) => value?.length === 40);
    const sha256 = strings.find((value) => value?.length === 64);
    const sizeText = /,\s*\n\s*([\d_]+),\s*\n\s*'[0-9a-f]{64}'/.exec(block)?.[1];
    if (!commit || !sha256 || !sizeText) throw new Error('Incomplete catalog pin: ' + id);
    pins[id] = {
      id,
      commit,
      sha256,
      size: Number(sizeText.replaceAll('_', '')),
      url:
        'https://huggingface.co/PaddlePaddle/PP-OCRv6_' +
        id +
        '_onnx/resolve/' +
        commit +
        '/inference.onnx',
    };
  }
  return pins;
}
async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
export async function verifyModel(
  pin: ModelPin,
  directory = process.env.OCR_MODEL_DIR ?? DEFAULT_MODEL_DIRECTORY,
): Promise<string> {
  const path = join(directory, pin.id + '.onnx');
  if (!(await exists(path))) {
    await mkdir(directory, { recursive: true });
    console.log('Downloading pinned ' + pin.id + ' from ' + pin.url);
    const response = await fetch(pin.url);
    if (!response.ok)
      throw new Error('Model download failed (' + response.status + '): ' + pin.url);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const temporary = path + '.download-' + process.pid;
    await writeFile(temporary, bytes);
    await rename(temporary, path);
  }
  const bytes = await readFile(path);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (bytes.byteLength !== pin.size || sha256 !== pin.sha256) {
    throw new Error(
      pin.id +
        ' pin mismatch: size ' +
        bytes.byteLength +
        '/' +
        pin.size +
        ', sha256 ' +
        sha256 +
        '/' +
        pin.sha256,
    );
  }
  return path;
}
export async function loadDictionary(): Promise<string[]> {
  const text = await readFile(join(ROOT, 'public/ocr/pp-ocrv6-chars.txt'), 'utf8');
  const dictionary = (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n');
  if (dictionary.length !== 18708)
    throw new Error('Unexpected OCR dictionary length: ' + dictionary.length);
  return dictionary;
}
function outputTensor(
  session: ort.InferenceSession,
  outputs: Record<string, unknown>,
): { data: Float32Array; dims: readonly number[] } {
  const name = session.outputNames[0];
  const tensor = name ? outputs[name] : undefined;
  if (!tensor || typeof tensor !== 'object' || !('data' in tensor) || !('dims' in tensor))
    throw new Error('Missing ONNX output');
  if (!(tensor.data instanceof Float32Array) || !Array.isArray(tensor.dims))
    throw new Error('Expected float32 ONNX output');
  return { data: tensor.data, dims: tensor.dims };
}
function makeRunner(det: ort.InferenceSession, rec: ort.InferenceSession): OcrRunner {
  const run = async (session: ort.InferenceSession, input: OcrTensor) => {
    const name = session.inputNames[0] ?? 'x';
    const tensor = new ort.Tensor('float32', input.data, [...input.dims]);
    return outputTensor(session, await session.run({ [name]: tensor }));
  };
  return {
    detect: async (input) => {
      const output = await run(det, input);
      if (
        output.dims.length !== 4 ||
        output.dims[0] !== 1 ||
        output.dims[1] !== 1 ||
        output.dims[2] !== input.dims[2] ||
        output.dims[3] !== input.dims[3]
      ) {
        throw new Error('Unexpected detector output: [' + output.dims.join(',') + ']');
      }
      return { data: output.data, height: input.dims[2], width: input.dims[3] };
    },
    recognize: async (input) => {
      const output = await run(rec, input);
      if (output.dims.length !== 3 || output.dims[0] !== 1 || output.dims[2] !== 18710) {
        throw new Error('Unexpected recognizer output: [' + output.dims.join(',') + ']');
      }
      return output;
    },
  };
}
export async function loadPairing(pairing: Pairing): Promise<LoadedPairing> {
  const [detId, recId] = pairing.split('+');
  if (!detId || !recId) throw new Error('Invalid pairing: ' + pairing);
  const pins = await catalogPins();
  const detPin = pins[detId];
  const recPin = pins[recId];
  if (!detPin || !recPin) throw new Error('Pairing is absent from catalog: ' + pairing);
  const started = performance.now();
  const [detPath, recPath, dictionary] = await Promise.all([
    verifyModel(detPin),
    verifyModel(recPin),
    loadDictionary(),
  ]);
  const wasmDirectory = dirname(fileURLToPath(import.meta.resolve('onnxruntime-web/wasm')));
  ort.env.wasm.wasmPaths = wasmDirectory + '/';
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  const options: ort.InferenceSession.SessionOptions = {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
  };
  const det = await ort.InferenceSession.create(await readFile(detPath), options);
  try {
    const rec = await ort.InferenceSession.create(await readFile(recPath), options);
    const runner = makeRunner(det, rec);
    const pipeline = new OcrPipeline({
      runner,
      dictionary,
      useSpaceChar: true,
      detection: {
        threshold: 0.2,
        boxThreshold: detId === 'tiny_det' ? 0.4 : 0.45,
        unclipRatio: 1.4,
        maxCandidates: 3000,
        minSize: 3,
        verticalRatio: 1.5,
      },
      // Match the shipped OCR runtime so this bench measures the real default.
      detectionPreprocess: { maxSide: 1600, multiple: 32 },
      recognitionPreprocess: { height: 48, maxWidth: DEFAULT_RECOGNITION_MAX_WIDTH },
    });
    return {
      pipeline,
      runner,
      dictionary,
      detection: {
        threshold: 0.2,
        boxThreshold: detId === 'tiny_det' ? 0.4 : 0.45,
        unclipRatio: 1.4,
        maxCandidates: 3000,
        minSize: 3,
        verticalRatio: 1.5,
      },
      initializationMs: performance.now() - started,
      models: [detPin, recPin],
      release: async () => {
        await Promise.all([det.release(), rec.release()]);
      },
    };
  } catch (error) {
    await det.release();
    throw error;
  }
}
/** Decodes the 8-bit non-interlaced PNGs generated by bench:ocr:render. */
export async function decodePngImage(path: string): Promise<ImageDataLike> {
  const bytes = await readFile(path);
  if (bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a')
    throw new Error('Not a PNG: ' + path);
  let offset = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat: Buffer[] = [];
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.subarray(offset + 4, offset + 8).toString('ascii');
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const bitDepth = data[8];
      const colorType = data[9];
      const interlace = data[12];
      if (bitDepth !== 8 || interlace !== 0 || (colorType !== 2 && colorType !== 6))
        throw new Error('Unsupported PNG encoding: ' + path);
      channels = colorType === 6 ? 4 : 3;
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }
    offset += length + 12;
  }
  if (!width || !height || channels === 0 || idat.length === 0)
    throw new Error('Incomplete PNG: ' + path);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  if (raw.length !== (stride + 1) * height) throw new Error('Malformed PNG scanlines: ' + path);
  const rgba = new Uint8ClampedArray(width * height * 4);
  let previous = Buffer.alloc(stride);
  let cursor = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[cursor++] ?? 0;
    const current = Buffer.from(raw.subarray(cursor, cursor + stride));
    cursor += stride;
    for (let index = 0; index < stride; index += 1) {
      const value = current[index] ?? 0;
      const left = index >= channels ? (current[index - channels] ?? 0) : 0;
      const above = previous[index] ?? 0;
      const upperLeft = index >= channels ? (previous[index - channels] ?? 0) : 0;
      let decoded = value;
      if (filter === 1) decoded = value + left;
      else if (filter === 2) decoded = value + above;
      else if (filter === 3) decoded = value + Math.floor((left + above) / 2);
      else if (filter === 4) {
        const predictor = left + above - upperLeft;
        const distanceLeft = Math.abs(predictor - left);
        const distanceAbove = Math.abs(predictor - above);
        const distanceCorner = Math.abs(predictor - upperLeft);
        const prediction =
          distanceLeft <= distanceAbove && distanceLeft <= distanceCorner
            ? left
            : distanceAbove <= distanceCorner
              ? above
              : upperLeft;
        decoded = value + prediction;
      } else if (filter !== 0) {
        throw new Error('Unsupported PNG filter: ' + path);
      }
      current[index] = decoded & 0xff;
    }
    const rowOffset = y * width * 4;
    for (let x = 0; x < width; x += 1) {
      const source = x * channels;
      rgba[rowOffset + x * 4] = current[source] ?? 0;
      rgba[rowOffset + x * 4 + 1] = current[source + 1] ?? 0;
      rgba[rowOffset + x * 4 + 2] = current[source + 2] ?? 0;
      rgba[rowOffset + x * 4 + 3] = channels === 4 ? (current[source + 3] ?? 0) : 255;
    }
    previous = current;
  }
  return { data: rgba, width, height };
}

export async function decodePngRgba(path: string): Promise<Uint8ClampedArray> {
  return (await decodePngImage(path)).data;
}

export async function readRgbaFixture(
  directory: string,
  id: string,
  width: number,
  height: number,
): Promise<ImageDataLike> {
  const rawPath = join(directory, id + '.rgba');
  if (await exists(rawPath)) {
    const bytes = await readFile(rawPath);
    if (bytes.byteLength !== width * height * 4) throw new Error('RGBA size mismatch for ' + id);
    return {
      data: new Uint8ClampedArray(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      width,
      height,
    };
  }
  // The large .rgba files are generated artifacts, not source; decode the committed PNG instead.
  const data = await decodePngRgba(join(directory, id + '.png'));
  if (data.length !== width * height * 4) throw new Error('PNG size mismatch for ' + id);
  return { data, width, height };
}
export async function runTimed(
  pipeline: OcrPipeline,
  image: ImageDataLike,
): Promise<{ result: OcrResult; wallMs: number }> {
  const started = performance.now();
  const result = await pipeline.run(image);
  return { result, wallMs: performance.now() - started };
}
