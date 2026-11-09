export type ComputeTier = 'g' | 'c8' | 'c4';

export type BackendKind = 'webgpu' | 'cpu-wasm';

export const CONTEXT_TOKENS = 2048;

export const WEBGPU_ALL_LAYERS = 99999;

/**
 * A WebGPU decode step costs about the same for one token as for many, so sequences advance
 * together. The scheduler starts them in waves, because a prompt that joins mid-wave makes
 * every step of the sequences already generating as slow as a prefill.
 *
 * The width depends on ggml's integer shaders, which only some GPUs get. Without them, up to
 * four rows still use the vector shader and a fifth falls to the tiled one. Long article on
 * an RTX 4090 with the integer shaders forced off: 1 slot 8.1 s, 4 slots 3.7 s, 16 slots 5.2 s.
 * Sixteen slots are kept to the GPUs they have been measured on; see `supportsFastBatches`.
 */
const WEBGPU_SLOTS_FAST = 16;
const WEBGPU_SLOTS_PLAIN = 4;
/** One sequence: smaller KV, used after a wide WebGPU load failed. */
const WEBGPU_SLOTS_CONSERVATIVE = 1;
// llama.cpp divides n_ctx across parallel slots. A piece of text fits well inside 1024.
const WEBGPU_CONTEXT_PER_SLOT = 1024;

export interface BackendProbe {
  webgpu: boolean;
  hardwareConcurrency: number;
  /** The GPU has been measured at the full width. Any other GPU gets the narrower one. */
  fastBatches?: boolean;
}

export interface BackendSelection {
  tier: ComputeTier;
  backend: BackendKind;
  nGpuLayers: number;
  nThreads: number;
  nParallel: number;
  nCtx: number;
}

function clampThreads(requested: number, hardwareConcurrency: number): number {
  const cores = Number.isFinite(hardwareConcurrency) ? Math.floor(hardwareConcurrency) : 4;
  return Math.max(1, Math.min(requested, Math.max(1, cores)));
}

/**
 * Half the logical cores, which is the physical core count on SMT CPUs, between 8 and 16.
 * On a 32-thread desktop, 16 threads decoded 60 tokens/s where 8 decoded 43 (SIMD build,
 * Q4_K_M), so a large CPU is not held to eight. A machine with 16 or fewer threads keeps 8.
 */
function largeCpuThreads(hardwareConcurrency: number): number {
  const cores = Number.isFinite(hardwareConcurrency) ? Math.floor(hardwareConcurrency) : 4;
  return clampThreads(Math.min(16, Math.max(8, Math.floor(cores / 2))), cores);
}

/** The CPU tiers keep one sequence: there, each sequence costs its full compute. */
export function selectBackend(probe: BackendProbe): BackendSelection {
  if (probe.webgpu) {
    const slots = probe.fastBatches === true ? WEBGPU_SLOTS_FAST : WEBGPU_SLOTS_PLAIN;
    return {
      tier: 'g',
      backend: 'webgpu',
      nGpuLayers: WEBGPU_ALL_LAYERS,
      nThreads: clampThreads(8, probe.hardwareConcurrency),
      nParallel: slots,
      nCtx: WEBGPU_CONTEXT_PER_SLOT * slots,
    };
  }

  if (probe.hardwareConcurrency >= 8) {
    return {
      tier: 'c8',
      backend: 'cpu-wasm',
      nGpuLayers: 0,
      nThreads: largeCpuThreads(probe.hardwareConcurrency),
      nParallel: 1,
      nCtx: CONTEXT_TOKENS,
    };
  }

  return {
    tier: 'c4',
    backend: 'cpu-wasm',
    nGpuLayers: 0,
    nThreads: clampThreads(4, probe.hardwareConcurrency),
    nParallel: 1,
    nCtx: CONTEXT_TOKENS,
  };
}

export type TierPreference = 'auto' | ComputeTier;

/** Resolves the settings choice. `auto` keeps the probe; the others force that tier. */
export function selectionForTier(
  preference: TierPreference,
  probe: BackendProbe,
): BackendSelection {
  if (preference === 'auto') return selectBackend(probe);
  if (preference === 'g') {
    return selectBackend({ ...probe, webgpu: true });
  }
  if (preference === 'c8') {
    return {
      tier: 'c8',
      backend: 'cpu-wasm',
      nGpuLayers: 0,
      nThreads: largeCpuThreads(probe.hardwareConcurrency),
      nParallel: 1,
      nCtx: CONTEXT_TOKENS,
    };
  }

  return {
    tier: 'c4',
    backend: 'cpu-wasm',
    nGpuLayers: 0,
    nThreads: clampThreads(4, probe.hardwareConcurrency),
    nParallel: 1,
    nCtx: CONTEXT_TOKENS,
  };
}

export function cpuFallback(selection: BackendSelection): BackendSelection | null {
  if (selection.backend === 'cpu-wasm') return null;
  return selectBackend({
    webgpu: false,
    hardwareConcurrency: selection.nThreads,
  });
}

/**
 * The next lighter place to run after `selection` failed: four slots, then one
 * conservative WebGPU slot, then the CPU.
 */
export function lighterSelection(selection: BackendSelection): BackendSelection | null {
  if (selection.backend === 'webgpu' && selection.nParallel > WEBGPU_SLOTS_PLAIN) {
    return {
      ...selection,
      nParallel: WEBGPU_SLOTS_PLAIN,
      nCtx: WEBGPU_CONTEXT_PER_SLOT * WEBGPU_SLOTS_PLAIN,
    };
  }
  if (selection.backend === 'webgpu' && selection.nParallel > WEBGPU_SLOTS_CONSERVATIVE) {
    return {
      ...selection,
      nParallel: WEBGPU_SLOTS_CONSERVATIVE,
      nCtx: WEBGPU_CONTEXT_PER_SLOT * WEBGPU_SLOTS_CONSERVATIVE,
    };
  }
  return cpuFallback(selection);
}

/** Losses further apart than this are unrelated, such as a driver update or a resume from sleep. */
export const GPU_LOSS_WINDOW_MS = 120_000;

/** A lone GPU loss reloads the same way. A second soon after means this load is too heavy. */
export function selectionAfterGpuLoss(
  selection: BackendSelection,
  sinceLastLossMs: number,
): BackendSelection {
  if (sinceLastLossMs >= GPU_LOSS_WINDOW_MS) return selection;
  return lighterSelection(selection) ?? selection;
}
