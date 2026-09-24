import type { NextConfig } from "next";
import { parse, type Key } from "path-to-regexp";
import { selectVariant, type Variant } from "./negotiate.js";
import { resolveVariant } from "./resolve.js";

export interface NegotiationRule {
  /** Path pattern to negotiate, using Next.js `source` syntax, e.g. `/docs/:path*`. */
  source: string;
  /**
   * Available representations, in server preference order. The first variant
   * is the default when the client has no preference.
   */
  variants: Variant[];
  /**
   * What to do when no variant is acceptable to the client: serve the first
   * variant (`'default'`, the default) or respond `406 Not Acceptable`.
   */
  onNoMatch?: "default" | 406;
}

export interface NegotiationConfig {
  /** Rules are tried in order; the first whose `source` matches is used. */
  rules: NegotiationRule[];
  /**
   * Set to `true` if `next.config` also sets `skipProxyUrlNormalize: true`.
   * Only then can the proxy see the `RSC` header of App Router navigations
   * and serve them the HTML page. `defineNegotiation` requires this when a
   * rule would pick a different variant for `Accept: *\/*` than for
   * `Accept: text/html`.
   */
  skipProxyUrlNormalize?: boolean;
}

function params(pattern: string): Map<string, Key> {
  return new Map(
    parse(pattern)
      .filter((token): token is Key => typeof token === "object")
      .map((key) => [String(key.name), key]),
  );
}

interface NavigationHeaders {
  "accept-language"?: string;
  "accept-encoding"?: string;
}

/** The variant a request gets, or `406`, as the proxy resolves it. */
function outcome(
  rule: NegotiationRule,
  accept: string,
  headers: NavigationHeaders,
): Variant | 406 {
  return resolveVariant(rule, new Headers({ accept, ...headers }));
}

/** A language or encoding that no variant declares. */
const UNLISTED = "x-unlisted";

/**
 * Header values that cover every case in which the ranking of a dimension can
 * change: no header, one declared value, all declared values, and only
 * undeclared values (which starts the language fallback and leaves only
 * `identity` acceptable).
 */
function headerCases(values: string[]): (string | undefined)[] {
  if (values.length === 0) return [undefined];
  return [undefined, ...values, values.join(", "), UNLISTED];
}

function declared(
  rule: NegotiationRule,
  dimension: "language" | "encoding",
): string[] {
  return [
    ...new Set(
      rule.variants.flatMap((v) => (v[dimension] ? [v[dimension]] : [])),
    ),
  ];
}

/**
 * Returns the request headers for which an App Router navigation to this
 * rule's paths needs the `RSC` header, or `null` if it never does. Without
 * the `RSC` header, the client router's requests have `Accept: *\/*`. That is
 * only a problem if the rule serves HTML and picks something else for `*\/*`.
 */
function rscHeaderNeededFor(rule: NegotiationRule): NavigationHeaders | null {
  if (!selectVariant(rule.variants, new Headers({ accept: "text/html" })))
    return null;
  for (const language of headerCases(declared(rule, "language"))) {
    for (const encoding of headerCases(declared(rule, "encoding"))) {
      const headers: NavigationHeaders = {};
      if (language !== undefined) headers["accept-language"] = language;
      if (encoding !== undefined) headers["accept-encoding"] = encoding;
      if (outcome(rule, "*/*", headers) !== outcome(rule, "text/html", headers))
        return headers;
    }
  }
  return null;
}

function describeHeaders(headers: NavigationHeaders): string {
  const entries = Object.entries(headers).map(
    ([name, value]) => `${name}: ${value}`,
  );
  return entries.length ? ` (with ${entries.join(", ")})` : "";
}

const isOptional = (key: Key) => key.modifier === "?" || key.modifier === "*";
const isRepeating = (key: Key) => key.modifier === "*" || key.modifier === "+";

/**
 * Validates and returns a negotiation config. Share the result between
 * `next.config` and `proxy.ts`.
 */
export function defineNegotiation<const C extends NegotiationConfig>(
  config: C,
): C {
  for (const rule of config.rules) {
    if (!rule.source.startsWith("/")) {
      throw new Error(
        `[content-negotiation] source must start with "/": ${rule.source}`,
      );
    }
    if (rule.variants.length === 0) {
      throw new Error(
        `[content-negotiation] rule "${rule.source}" has no variants`,
      );
    }
    const rscHeaders = config.skipProxyUrlNormalize
      ? null
      : rscHeaderNeededFor(rule);
    if (rscHeaders) {
      throw new Error(
        `[content-negotiation] rule "${rule.source}" picks a different variant for "Accept: */*" than for ` +
          `"Accept: text/html"${describeHeaders(rscHeaders)}, so App Router navigations could get a non-HTML ` +
          "variant. Change the variants so that both pick the same one, or set `skipProxyUrlNormalize: true` in both next.config and the negotiation config.",
      );
    }
    const sourceParams = params(rule.source);
    for (const variant of rule.variants) {
      if (variant.destination === undefined) continue;
      if (!variant.destination.startsWith("/")) {
        throw new Error(
          `[content-negotiation] destination must start with "/": ${variant.destination}`,
        );
      }
      for (const [name, key] of params(variant.destination)) {
        const sourceKey = sourceParams.get(name);
        const problem = !sourceKey
          ? "does not define it"
          : isOptional(sourceKey) && !isOptional(key)
            ? "can leave it empty"
            : isRepeating(sourceKey) && !isRepeating(key)
              ? "can match several segments"
              : null;
        if (problem) {
          throw new Error(
            `[content-negotiation] destination "${variant.destination}" uses ":${name}", but "${rule.source}" ${problem}`,
          );
        }
      }
    }
  }
  return config;
}

type NextConfigFunction = (
  phase: string,
  context: { defaultConfig: NextConfig },
) => NextConfig | Promise<NextConfig>;

export interface ContentNegotiationOptions {
  /**
   * Patch Next.js at build time so that App Router page responses keep the
   * `Vary` header (https://github.com/vercel/next.js/issues/85999). Without
   * it, Next.js replaces `Vary` on pages and caches cannot tell variants
   * apart. Defaults to `true`.
   */
  patchVary?: boolean;
}

// Resolved by the bundler from the app's node_modules. A file path computed
// here would be evaluated in the proxy bundle too, which imports this module.
const VARY_LOADER = "nextjs-content-negotiation/vary-loader";
const APP_PAGE_RUNTIME =
  /[\\/]next[\\/]dist[\\/](?:esm[\\/])?build[\\/]templates[\\/]app-page-runtime\.js$/;

type TurbopackRules = NonNullable<
  NonNullable<NextConfig["turbopack"]>["rules"]
>;
type TurbopackRuleItem = Exclude<TurbopackRules[string], unknown[]>;
type TurbopackListItem = Exclude<
  TurbopackRules[string],
  TurbopackRuleItem
>[number];
type TurbopackLoaderItem = Exclude<TurbopackListItem, TurbopackRuleItem>;

// Same test as Next.js uses when it reads a list of loaders and rule items.
function isRuleItem(item: TurbopackListItem): item is TurbopackRuleItem {
  return (
    typeof item !== "string" &&
    ("loaders" in item || "type" in item || "condition" in item)
  );
}

function isLoaderItem(item: TurbopackListItem): item is TurbopackLoaderItem {
  return !isRuleItem(item);
}

/**
 * Converts a rule value to a list of rule items. A shorthand list of loaders
 * becomes one rule item, so that it stays separate from rules added after it.
 */
function toRuleItems(value: TurbopackRules[string]): TurbopackRuleItem[] {
  if (!Array.isArray(value)) return [value];
  const loaders = value.filter(isLoaderItem);
  const rules = value.filter(isRuleItem);
  return loaders.length ? [{ loaders }, ...rules] : rules;
}

/** Registers the `Vary` loader with Turbopack and webpack. */
function withVaryPatch(nextConfig: NextConfig): NextConfig {
  const rules: TurbopackRules = { ...nextConfig.turbopack?.rules };
  const key = "**/app-page-runtime.js";
  const rule = {
    loaders: [VARY_LOADER],
    condition: { path: APP_PAGE_RUNTIME },
  };
  const existing = rules[key];
  rules[key] = existing === undefined ? rule : [...toRuleItems(existing), rule];

  const userWebpack = nextConfig.webpack;
  return {
    ...nextConfig,
    turbopack: { ...nextConfig.turbopack, rules },
    webpack(config, context) {
      const result = userWebpack ? userWebpack(config, context) : config;
      result.module.rules.push({
        test: APP_PAGE_RUNTIME,
        use: [{ loader: VARY_LOADER }],
      });
      return result;
    },
  };
}

function applyNegotiation(
  nextConfig: NextConfig,
  options: ContentNegotiationOptions,
): NextConfig {
  return options.patchVary === false ? nextConfig : withVaryPatch(nextConfig);
}

/**
 * Prepares a Next.js config for content negotiation.
 *
 * This patches Next.js so that pages keep the `Vary` header the proxy sets
 * (see `ContentNegotiationOptions.patchVary`). The variant selection and the
 * `Vary` header come from `proxy.ts`; see
 * `createNegotiationProxy` in `nextjs-content-negotiation/proxy`.
 */
export function withContentNegotiation<
  C extends NextConfig | NextConfigFunction,
>(
  nextConfig: C,
  options?: ContentNegotiationOptions,
): C extends NextConfigFunction ? NextConfigFunction : NextConfig;
export function withContentNegotiation(
  nextConfig: NextConfig | NextConfigFunction,
  options: ContentNegotiationOptions = {},
): NextConfig | NextConfigFunction {
  if (typeof nextConfig === "function") {
    return async (phase, context) =>
      applyNegotiation(await nextConfig(phase, context), options);
  }
  return applyNegotiation(nextConfig, options);
}
