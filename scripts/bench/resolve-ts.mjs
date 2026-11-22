/**
 * Node's type stripper requires explicit .ts extensions. Source files in src/ still use
 * extensionless relative imports and the '@/' alias, so this resolver handles both for bench
 * scripts that import the shipped modules directly.
 */
import { dirname, resolve as pathResolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = pathResolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('@/')) {
    const relative = specifier.slice(2);
    const withExtension = /\.(?:js|ts|mjs|cjs|json)$/u.test(relative) ? relative : relative + '.ts';
    return nextResolve(pathToFileURL(pathResolve(ROOT, 'src', withExtension)).href, context);
  }
  if (specifier.startsWith('.') && !/\.(?:js|ts|mjs|cjs|json)$/u.test(specifier)) {
    try {
      return await nextResolve(`${specifier}.ts`, context);
    } catch {
      // Fall through to the original specifier.
    }
  }
  return nextResolve(specifier, context);
}
