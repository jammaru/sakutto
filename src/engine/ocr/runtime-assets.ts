/** Packaged ONNX Runtime files. scripts/sync-ocr-runtime.mjs verifies these pins. */
export const ORT_VERSION = '1.31.1';
export const ORT_ASSET_DIRECTORY = 'ocr/ort';
export const ORT_ASSETS = Object.freeze({
  'ort.wasm.min.mjs': {
    size: 53_725,
    sha256: 'c21d9c326d453a4a61398270c804d5979e118540597cb0c07f7b3d64e6098234',
  },
  'ort-wasm-simd-threaded.mjs': {
    size: 24_738,
    sha256: '30ed0b5cd1182ede931fea448afb567d4dc705ec957af09f108a2be5f770dac3',
  },
  'ort-wasm-simd-threaded.wasm': {
    size: 14_848_852,
    sha256: '4b884c203b0fa48d057be3332c65513ff85aa3c5bddd6946acc0fab7ecda001d',
  },
});
