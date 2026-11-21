import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ORT_ASSETS, ORT_ASSET_DIRECTORY, ORT_VERSION } from '../src/engine/ocr/runtime-assets.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(
  readFileSync(join(root, 'node_modules/onnxruntime-web/package.json'), 'utf8'),
);
if (packageJson.version !== ORT_VERSION) {
  throw new Error(
    `onnxruntime-web ${String(packageJson.version)} does not match pin ${ORT_VERSION}`,
  );
}

const output = join(root, 'public', ORT_ASSET_DIRECTORY);
mkdirSync(output, { recursive: true });
for (const [name, pin] of Object.entries(ORT_ASSETS)) {
  const source = join(root, 'node_modules/onnxruntime-web/dist', name);
  const bytes = readFileSync(source);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (statSync(source).size !== pin.size || sha256 !== pin.sha256) {
    throw new Error(`ONNX Runtime artifact ${name} does not match its size/SHA-256 pin`);
  }
  copyFileSync(source, join(output, name));
}

// The npm package omits the repository's third-party notices. Keep the version-matched
// upstream text beside the runtime artifacts as well as in the packaged licenses directory.
copyFileSync(
  join(root, 'licenses', 'onnxruntime-ThirdPartyNotices.txt'),
  join(output, 'ThirdPartyNotices.txt'),
);
console.log(`Synced onnxruntime-web ${ORT_VERSION} WASM assets and third-party notices`);
