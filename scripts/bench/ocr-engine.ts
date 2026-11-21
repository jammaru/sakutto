import { createHash } from 'node:crypto';
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ort from 'onnxruntime-web/wasm';
import { OcrPipeline } from '../../src/engine/ocr/pipeline.ts';
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
    const pipeline = new OcrPipeline({
      runner: makeRunner(det, rec),
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
      detectionPreprocess: { maxSide: 960, multiple: 32 },
      recognitionPreprocess: { height: 48, maxWidth: 320 },
    });
    return {
      pipeline,
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
export async function readRgbaFixture(
  directory: string,
  id: string,
  width: number,
  height: number,
): Promise<ImageDataLike> {
  const bytes = await readFile(join(directory, id + '.rgba'));
  if (bytes.byteLength !== width * height * 4) throw new Error('RGBA size mismatch for ' + id);
  return {
    data: new Uint8ClampedArray(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    width,
    height,
  };
}
export async function runTimed(
  pipeline: OcrPipeline,
  image: ImageDataLike,
): Promise<{ result: OcrResult; wallMs: number }> {
  const started = performance.now();
  const result = await pipeline.run(image);
  return { result, wallMs: performance.now() - started };
}
