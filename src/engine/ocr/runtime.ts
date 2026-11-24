import { browser } from 'wxt/browser';
import dictionaryText from '../../../public/ocr/pp-ocrv6-chars.txt?raw';
import { abortError, EngineError, isAbortError, isEngineError } from '@/engine/errors';
import type { OcrRuntimeLike } from './host';
import type { AssetManager } from '@/engine/model/asset-manager';
import { OCR_CHARSET, OCR_TIER_CATALOG, type OcrTier } from './catalog';
import type { DecodedOcrImage } from './codec';
import { DEFAULT_RECOGNITION_MAX_WIDTH } from './image';
import { OcrPipeline, throwIfOcrAborted } from './pipeline';
import { ORT_ASSET_DIRECTORY } from './runtime-assets';
import type { OcrResult, OcrRunner } from './types';

type OrtModule = typeof import('onnxruntime-web/wasm');
type OrtSession = import('onnxruntime-web/wasm').InferenceSession;

let ortTask: Promise<OrtModule> | null = null;

function extensionAssetUrl(path: string): string {
  return (browser.runtime.getURL as (asset: string) => string)(
    path.startsWith('/') ? path : `/${path}`,
  );
}

/** Loads only extension-origin code and WASM; MV3 never fetches a remote runtime. */
function loadOrt(): Promise<OrtModule> {
  if (!ortTask) {
    ortTask = (async () => {
      const moduleUrl = extensionAssetUrl(`${ORT_ASSET_DIRECTORY}/ort.wasm.min.mjs`);
      const ort = (await import(/* @vite-ignore */ moduleUrl)) as OrtModule;
      ort.env.wasm.wasmPaths = extensionAssetUrl(`${ORT_ASSET_DIRECTORY}/`);
      ort.env.wasm.numThreads = 1;
      // WASM stays on this thread. ORT's proxy mode would move inference to a worker and
      // change how the models and WASM paths resolve inside an extension; we keep the
      // proven setup and instead let OcrPipeline yield a macrotask between text-box
      // recognitions. That keeps the offscreen host's port responsive without touching
      // recognition output (see docs/design/ocr-host-responsiveness.md).
      ort.env.wasm.proxy = false;
      return ort;
    })().catch((error: unknown) => {
      ortTask = null;
      throw error;
    });
  }
  return ortTask;
}

function loadDictionary(signal: AbortSignal): string[] {
  throwIfOcrAborted(signal);
  const dictionary = dictionaryText.endsWith('\n')
    ? dictionaryText.slice(0, -1).split('\n')
    : dictionaryText.split('\n');
  if (dictionary.length !== OCR_CHARSET.entries) {
    throw new Error(`OCR dictionary has ${String(dictionary.length)} entries`);
  }
  return dictionary;
}

function sessionTensor(
  session: OrtSession,
  output: Record<string, unknown>,
): {
  data: Float32Array;
  dims: readonly number[];
} {
  const name = session.outputNames[0];
  const tensor = name ? output[name] : undefined;
  if (!tensor || typeof tensor !== 'object' || !('data' in tensor) || !('dims' in tensor)) {
    throw new Error('ONNX Runtime returned no output tensor');
  }
  const data = tensor.data;
  const dims = tensor.dims;
  if (!(data instanceof Float32Array) || !Array.isArray(dims)) {
    throw new Error('ONNX Runtime returned a non-float output tensor');
  }
  return { data, dims };
}

function makeRunner(ort: OrtModule, det: OrtSession, rec: OrtSession): OcrRunner {
  const run = async (session: OrtSession, input: Parameters<OcrRunner['detect']>[0]) => {
    const name = session.inputNames[0] ?? 'x';
    const tensor = new ort.Tensor('float32', input.data, [...input.dims]);
    return sessionTensor(session, await session.run({ [name]: tensor }));
  };
  return {
    detect: async (input, signal) => {
      throwIfOcrAborted(signal);
      const output = await run(det, input);
      throwIfOcrAborted(signal);
      if (
        output.dims.length !== 4 ||
        output.dims[0] !== 1 ||
        output.dims[1] !== 1 ||
        output.dims[2] !== input.dims[2] ||
        output.dims[3] !== input.dims[3]
      ) {
        throw new Error(`Unexpected detector output shape [${output.dims.join(',')}]`);
      }
      return { data: output.data, height: input.dims[2], width: input.dims[3] };
    },
    recognize: async (input, signal) => {
      throwIfOcrAborted(signal);
      const output = await run(rec, input);
      throwIfOcrAborted(signal);
      if (
        output.dims.length !== 3 ||
        output.dims[0] !== 1 ||
        output.dims[2] !== OCR_CHARSET.classes
      ) {
        throw new Error(`Unexpected recognizer output shape [${output.dims.join(',')}]`);
      }
      return output;
    },
  };
}

/** Warm detector/recognizer sessions and the pure PP-OCRv6 pipeline. */
export class OcrRuntime {
  private constructor(
    private readonly det: OrtSession,
    private readonly rec: OrtSession,
    private readonly pipeline: OcrPipeline,
  ) {}

  static async create(
    assets: AssetManager<OcrTier>,
    tier: OcrTier,
    signal: AbortSignal,
  ): Promise<OcrRuntimeLike> {
    // The e2e build exercises the real message pipeline but deliberately skips the 15 MB ORT
    // wasm download: shared CI runners cannot reliably fetch it from an extension origin. The
    // release build always takes the real path below.
    if (__SAKUTTO_FAKE_ENGINE__) return fakeRuntime(signal);

    const entry = OCR_TIER_CATALOG[tier];
    let det: OrtSession | null = null;
    let rec: OrtSession | null = null;
    try {
      const [ort, detBlob, recBlob, dictionary] = await Promise.all([
        loadOrt(),
        assets.readFile(tier, `${entry.det.id}.onnx`, signal),
        assets.readFile(tier, `${entry.rec.id}.onnx`, signal),
        loadDictionary(signal),
      ]);
      throwIfOcrAborted(signal);
      det = await ort.InferenceSession.create(new Uint8Array(await detBlob.arrayBuffer()), {
        executionProviders: ['wasm'],
      });
      throwIfOcrAborted(signal);
      rec = await ort.InferenceSession.create(new Uint8Array(await recBlob.arrayBuffer()), {
        executionProviders: ['wasm'],
      });
      throwIfOcrAborted(signal);
      const pipeline = new OcrPipeline({
        runner: makeRunner(ort, det, rec),
        dictionary,
        useSpaceChar: true,
        detection: {
          threshold: 0.2,
          boxThreshold: tier === 'standard' ? 0.4 : 0.45,
          unclipRatio: 1.4,
          maxCandidates: 3000,
          minSize: 3,
          verticalRatio: 1.5,
        },
        // PDF OCR rasters are rendered at 2x page scale. A 960px cap threw that detail away
        // before detection; 1600 keeps a full A4 scan (about 1224x1584) at native resolution.
        detectionPreprocess: { maxSide: 1600, multiple: 32 },
        recognitionPreprocess: { height: 48, maxWidth: DEFAULT_RECOGNITION_MAX_WIDTH },
      });
      return new OcrRuntime(det, rec, pipeline);
    } catch (error) {
      if (det) await det.release().catch(() => undefined);
      if (rec && rec !== det) await rec.release().catch(() => undefined);
      if (isAbortError(error) || signal.aborted) throw abortError();
      if (isEngineError(error)) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new EngineError('model-load-failed', `OCR runtime could not start: ${message}`, {
        cause: error,
        retryable: true,
      });
    }
  }

  recognize(image: DecodedOcrImage, signal: AbortSignal): Promise<OcrResult> {
    return this.pipeline.run(image, signal);
  }

  async release(): Promise<void> {
    await Promise.all([this.det.release(), this.rec.release()]);
  }
}
/** Deterministic OCR text for the fake-engine e2e build. Never compiled into the release. */
function fakeRuntime(signal: AbortSignal): OcrRuntimeLike {
  const lines = [
    'LOCAL TRANSLATION NOTES',
    'A private tool for every reader.',
    'Open a page and choose a language.',
    'The text stays on this device.',
  ];
  return {
    recognize: async (image, runSignal) => {
      throwIfOcrAborted(signal);
      throwIfOcrAborted(runSignal);
      const regions = lines.map((text, index) => {
        const top = 12 + index * 18;
        return {
          text,
          confidence: 1,
          recognitionConfidence: 1,
          symbolScores: [],
          vertical: false,
          quad: [
            { x: 10, y: top },
            { x: Math.max(20, image.width - 10), y: top },
            { x: Math.max(20, image.width - 10), y: top + 14 },
            { x: 10, y: top + 14 },
          ] as const,
        };
      });
      return { regions, lines: [], text: lines.join('\n') };
    },
    release: () => undefined,
  };
}
