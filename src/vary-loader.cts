/**
 * Bundler loader that stops Next.js from discarding `Vary` values on App
 * Router page responses.
 *
 * Next.js 16.3+ calls `res.setHeader('Vary', varyHeader)` in its app page
 * runtime, which replaces any `Vary` value set by the proxy or by `next.config`
 * headers (https://github.com/vercel/next.js/issues/85999). This rewrites that
 * call to merge the existing value with Next.js's own. The merge removes
 * duplicates, so it stays correct if Next.js starts merging itself.
 */

interface LoaderContext {
  resourcePath: string;
  emitWarning(warning: Error): void;
  callback(error: Error | null, content?: string, sourceMap?: unknown): void;
}

const OVERWRITE = /res\.setHeader\((['"])Vary\1,\s*varyHeader\)/g;

// Kept on one line so that the input source map stays valid.
const MERGE =
  "res.setHeader('Vary', ((existing, next) => { const seen = new Set(); return [].concat(existing ?? [], next).join(',').split(',').map((field) => field.trim()).filter((field) => field && !seen.has(field.toLowerCase()) && seen.add(field.toLowerCase())).join(', '); })(res.getHeader('Vary'), varyHeader))";

function varyLoader(
  this: LoaderContext,
  source: string,
  sourceMap?: unknown,
): void {
  let count = 0;
  const patched = source.replace(OVERWRITE, () => {
    count++;
    return MERGE;
  });
  if (count === 0) {
    this.emitWarning(
      new Error(
        `[content-negotiation] Could not find the Vary overwrite in ${this.resourcePath}. ` +
          "Vary headers from the proxy may be missing from page responses.",
      ),
    );
  }
  this.callback(null, patched, sourceMap);
}

export = varyLoader;
