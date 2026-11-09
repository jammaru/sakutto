/**
 * Firefox WebGPU only polls completed GPU work about every 100ms (bug 1870699).
 * Submitting an empty queue while `mapAsync` waits shrinks that stall. Measured on
 * Windows Firefox 159.0 / RTX 4070 Ti SUPER with identical output: see
 * `docs/FIREFOX.md` and `bench/results/pages/firefox-webgpu-kick-20261109.md`.
 *
 * Default-on in Firefox. The worker still no-ops on other UAs. Any install or
 * `queue.submit` error restores the original GPU methods so inference falls back
 * to the unaccelerated path. Disable with `SAKUTTO_FIREFOX_WEBGPU_KICK=0` at wasm
 * build time (and in the extension bundle via the same env when Node runs tests).
 */
export const FIREFOX_WEBGPU_KICK = true;

export function firefoxWebGpuKickEnabled(): boolean {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env;
  const flag = env?.SAKUTTO_FIREFOX_WEBGPU_KICK;
  if (flag === '0' || flag === 'false') return false;
  if (flag === '1' || flag === 'true') return true;
  return FIREFOX_WEBGPU_KICK;
}

const GLOBAL_FLAG = '__SAKUTTO_FIREFOX_WEBGPU_KICK';

export function applyFirefoxWebGpuKickFlag(target: object = globalThis): void {
  (target as Record<string, unknown>)[GLOBAL_FLAG] = firefoxWebGpuKickEnabled();
}

/**
 * Cached wllama workers may still bake `enabled = false`. Inject the runtime
 * option into the worker URL so a Firefox session still gets the kick without
 * rebuilding wasm.
 */
export function withFirefoxWebGpuKickOption(scriptURL: string | URL): string | URL {
  try {
    const url = new URL(String(scriptURL));
    const raw = url.searchParams.get('options');
    if (!raw) return scriptURL;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed.firefoxWebGpuKick === true) return scriptURL;
    parsed.firefoxWebGpuKick = true;
    url.searchParams.set('options', JSON.stringify(parsed));
    return typeof scriptURL === 'string' ? url.href : url;
  } catch {
    return scriptURL;
  }
}

export function installFirefoxWebGpuKickWorkerOption(
  target: Pick<typeof globalThis, 'Worker'> = globalThis,
): void {
  if (!firefoxWebGpuKickEnabled()) return;
  const Original = target.Worker;
  if (typeof Original !== 'function') return;

  function WrappedWorker(scriptURL: string | URL, options?: WorkerOptions): Worker {
    const next = withFirefoxWebGpuKickOption(scriptURL);
    return options === undefined ? new Original(next) : new Original(next, options);
  }
  WrappedWorker.prototype = Original.prototype;
  Object.setPrototypeOf(WrappedWorker, Original);
  (target as { Worker: typeof Worker }).Worker = WrappedWorker as unknown as typeof Worker;
}

/** Classic-script bootstrap copied into the generated wllama worker. */
export function firefoxWebGpuKickWorkerBootstrap(): string {
  return `function sakuttoInstallFirefoxWebGpuKick() {
  var enabled = ${firefoxWebGpuKickEnabled() ? 'true' : 'false'};
  try {
    if (RUN_OPTIONS && RUN_OPTIONS.firefoxWebGpuKick === false) enabled = false;
    if (RUN_OPTIONS && RUN_OPTIONS.firefoxWebGpuKick === true) enabled = true;
  } catch (e) {}
  if (!enabled) return;
  if (typeof navigator === 'undefined' || !/Firefox/i.test(navigator.userAgent || '')) return;
  var GPUBuffer = globalThis.GPUBuffer;
  var GPUAdapter = globalThis.GPUAdapter;
  var GPUQueue = globalThis.GPUQueue;
  if (!GPUBuffer || !GPUAdapter || typeof GPUBuffer.prototype.mapAsync !== 'function') return;
  var originalRequestDevice = GPUAdapter.prototype.requestDevice;
  var originalMapAsync = GPUBuffer.prototype.mapAsync;
  var originalDone = GPUQueue && typeof GPUQueue.prototype.onSubmittedWorkDone === 'function'
    ? GPUQueue.prototype.onSubmittedWorkDone
    : null;
  try {
    var devices = new Set();
    GPUAdapter.prototype.requestDevice = function () {
      var result = originalRequestDevice.apply(this, arguments);
      return Promise.resolve(result).then(function (device) {
        if (device) devices.add(device);
        return device;
      });
    };
    function kickWhile(promise) {
      var delay = 0.5;
      var max = 8;
      var timer = 0;
      var kick = function () {
        devices.forEach(function (device) {
          try {
            device.queue.submit([]);
          } catch (e) {}
        });
        delay = Math.min(delay * 2, max);
        timer = setTimeout(kick, delay);
      };
      timer = setTimeout(kick, delay);
      var stop = function () {
        clearTimeout(timer);
      };
      return Promise.resolve(promise).then(
        function (value) {
          stop();
          return value;
        },
        function (error) {
          stop();
          throw error;
        },
      );
    }
    GPUBuffer.prototype.mapAsync = function () {
      return kickWhile(originalMapAsync.apply(this, arguments));
    };
    if (originalDone) {
      GPUQueue.prototype.onSubmittedWorkDone = function () {
        return kickWhile(originalDone.apply(this, arguments));
      };
    }
  } catch (e) {
    try { GPUAdapter.prototype.requestDevice = originalRequestDevice; } catch (e2) {}
    try { GPUBuffer.prototype.mapAsync = originalMapAsync; } catch (e2) {}
    if (originalDone) {
      try { GPUQueue.prototype.onSubmittedWorkDone = originalDone; } catch (e2) {}
    }
  }
}
sakuttoInstallFirefoxWebGpuKick();`;
}
