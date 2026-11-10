/**
 * Node's type stripper requires explicit .ts extensions. Source files in src/ still use
 * extensionless relative imports, so this resolver retries those as .ts.
 */
export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('.') && !/\.(?:js|ts|mjs|cjs|json)$/u.test(specifier)) {
    try {
      return await nextResolve(`${specifier}.ts`, context);
    } catch {
      // Fall through to the original specifier.
    }
  }
  return nextResolve(specifier, context);
}
