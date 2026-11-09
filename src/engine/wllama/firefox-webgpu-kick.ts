/**
 * Firefox WebGPU only polls completed GPU work about every 100ms (bug 1870699).
 * Submitting an empty queue while `mapAsync` waits can shrink that stall. This
 * has not been measured in Sakutto yet, so the switch stays off.
 *
 * Owner A/B:
 * 1. Set `SAKUTTO_FIREFOX_WEBGPU_KICK=1` and run `pnpm build:wllama`, or
 * 2. Flip `FIREFOX_WEBGPU_KICK` below, apply
 *    `scripts/wllama/patches/optional/0007-firefox-webgpu-kick.patch`, rebuild.
 * Leave it off for AMO until a Windows Firefox 153+ GPU run records a speedup.
 */
export const FIREFOX_WEBGPU_KICK = false;

export function firefoxWebGpuKickEnabled(): boolean {
  if (FIREFOX_WEBGPU_KICK) return true;
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env;
  return env?.SAKUTTO_FIREFOX_WEBGPU_KICK === '1';
}

const GLOBAL_FLAG = '__SAKUTTO_FIREFOX_WEBGPU_KICK';

export function applyFirefoxWebGpuKickFlag(target: object = globalThis): void {
  (target as Record<string, unknown>)[GLOBAL_FLAG] = FIREFOX_WEBGPU_KICK;
}

/** Classic-script bootstrap copied into the generated wllama worker. */
export function firefoxWebGpuKickWorkerBootstrap(): string {
  return `function sakuttoInstallFirefoxWebGpuKick() {
  var enabled = ${firefoxWebGpuKickEnabled() ? 'true' : 'false'};
  try {
    if (RUN_OPTIONS && RUN_OPTIONS.firefoxWebGpuKick === true) enabled = true;
  } catch (e) {}
  if (!enabled) return;
  if (typeof navigator === 'undefined' || !/Firefox/i.test(navigator.userAgent || '')) return;
  var GPUBuffer = globalThis.GPUBuffer;
  var GPUAdapter = globalThis.GPUAdapter;
  var GPUQueue = globalThis.GPUQueue;
  if (!GPUBuffer || !GPUAdapter || typeof GPUBuffer.prototype.mapAsync !== 'function') return;
  var devices = new Set();
  var originalRequestDevice = GPUAdapter.prototype.requestDevice;
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
  var originalMapAsync = GPUBuffer.prototype.mapAsync;
  GPUBuffer.prototype.mapAsync = function () {
    return kickWhile(originalMapAsync.apply(this, arguments));
  };
  if (GPUQueue && typeof GPUQueue.prototype.onSubmittedWorkDone === 'function') {
    var originalDone = GPUQueue.prototype.onSubmittedWorkDone;
    GPUQueue.prototype.onSubmittedWorkDone = function () {
      return kickWhile(originalDone.apply(this, arguments));
    };
  }
}
sakuttoInstallFirefoxWebGpuKick();`;
}
