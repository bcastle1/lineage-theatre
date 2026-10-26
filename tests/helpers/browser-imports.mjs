// Transpiled browser modules in data URLs need absolute shared-data imports.
export function resolveBrowserTestImports(source) {
  return source.replaceAll("'../../shared/kling-voices.json'", JSON.stringify(new URL('../../shared/kling-voices.json', import.meta.url).href));
}
