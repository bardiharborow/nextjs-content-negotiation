import { NextResponse, type NextRequest } from "next/server.js";
import {
  compile,
  match,
  type MatchFunction,
  type PathFunction,
} from "path-to-regexp";
import type { NegotiationConfig, NegotiationRule } from "./config.js";
import {
  DIMENSION_HEADERS,
  variantDimensions,
  type Dimension,
} from "./dimensions.js";
import type { HeaderSource, Variant } from "./negotiate.js";
import { resolveVariant } from "./resolve.js";

type Params = Record<string, string | string[]>;

interface CompiledRule {
  match: MatchFunction<Params>;
  destinations: Map<Variant, PathFunction<Params>>;
  vary: string | null;
  /** Body of the `406 Not Acceptable` response, listing the variants. */
  notAcceptableBody: string;
}

const compiled = new WeakMap<NegotiationRule, CompiledRule>();

function compileRule(rule: NegotiationRule): CompiledRule {
  let result = compiled.get(rule);
  if (!result) {
    const dimensions = variantDimensions(rule.variants);
    const vary = dimensions.map((dimension) => DIMENSION_HEADERS[dimension]);
    // `negotiationHeaders` reads the `RSC` header to pick the media type, so
    // caches must key on it too (RFC 9110 §12.5.5). Otherwise a variant
    // stored for `Accept: *\/*` would be served to App Router navigations.
    if (dimensions.includes("type")) vary.push("RSC");
    result = {
      // Params keep the request's percent-encoding and are copied into the
      // destination as is, so an encoded `%2F` stays one segment and a `/`
      // matched by a custom pattern such as `:path(.*)` stays a separator.
      match: match<Params>(rule.source),
      destinations: new Map(
        rule.variants.flatMap((variant) =>
          // Params come from matching `source`; `defineNegotiation` checks that
          // their modifiers fit the destination. Do not re-check them against
          // the destination's own patterns, which would throw at request time.
          variant.destination === undefined
            ? []
            : [
                [
                  variant,
                  compile<Params>(variant.destination, { validate: false }),
                ] as const,
              ],
        ),
      ),
      vary: vary.length ? vary.join(", ") : null,
      notAcceptableBody: notAcceptableBody(rule.variants, dimensions),
    };
    compiled.set(rule, result);
  }
  return result;
}

function notAcceptableBody(
  variants: readonly Variant[],
  dimensions: readonly Dimension[],
): string {
  const lines = variants.map((variant) =>
    dimensions
      .filter((dimension) => variant[dimension] !== undefined)
      .map(
        (dimension) => `${DIMENSION_HEADERS[dimension]}: ${variant[dimension]}`,
      )
      .join("; "),
  );
  return `406 Not Acceptable\n\nAvailable variants:\n${lines.join("\n")}\n`;
}

/**
 * Headers to negotiate with. The App Router fetches RSC payloads for
 * client-side navigation and prefetching without an `Accept` header, so the
 * browser sends `*\/*`. Server Actions post to the page's URL with
 * `Accept: text/x-component`. Both want the HTML page, so treat them as
 * `Accept: text/html` instead of letting them select another media type (or
 * none, which would send the action to the default variant or respond 406).
 *
 * Next.js only passes the `RSC` header to the proxy when `skipProxyUrlNormalize`
 * is enabled. Without it, `defineNegotiation` makes sure that `*\/*` already
 * picks the same variant as `text/html`. The `Next-Action` header always
 * reaches the proxy.
 */
function negotiationHeaders(request: NextRequest): HeaderSource {
  const wantsPage =
    request.headers.get("rsc") === "1" || request.headers.has("next-action");
  if (!wantsPage) return request.headers;
  return {
    get: (name) =>
      name.toLowerCase() === "accept" ? "text/html" : request.headers.get(name),
  };
}

/**
 * Negotiates a request against the configured rules.
 *
 * Returns a response that rewrites to the selected variant (or passes the
 * request through), a 406 response, or `undefined` if no rule matches the
 * path. Use it to compose negotiation with other proxy logic.
 */
export function negotiateRequest(
  request: NextRequest,
  negotiation: NegotiationConfig,
): NextResponse | undefined {
  for (const rule of negotiation.rules) {
    const compiledRule = compileRule(rule);
    const matched = compiledRule.match(request.nextUrl.pathname);
    if (!matched) continue;

    const variant = resolveVariant(rule, negotiationHeaders(request));
    let response: NextResponse;
    if (variant === 406) {
      response = new NextResponse(compiledRule.notAcceptableBody, {
        status: 406,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    } else {
      const destination = compiledRule.destinations.get(variant);
      if (destination) {
        const url = request.nextUrl.clone();
        url.pathname = destination(matched.params);
        response = NextResponse.rewrite(url);
        // `href` adds the base path, locale and trailing slash that the
        // request had. The query is part of the variant's URL (RFC 9110 §8.7).
        const { pathname, search } = new URL(url.href);
        response.headers.set("Content-Location", pathname + search);
      } else {
        response = NextResponse.next();
      }
    }
    if (compiledRule.vary) response.headers.set("Vary", compiledRule.vary);
    return response;
  }
  return undefined;
}

/**
 * Creates a Next.js proxy that negotiates matching requests and passes all
 * others through.
 *
 * ```ts
 * // proxy.ts
 * export const proxy = createNegotiationProxy(negotiation);
 * ```
 */
export function createNegotiationProxy(negotiation: NegotiationConfig) {
  return function proxy(request: NextRequest): NextResponse {
    return negotiateRequest(request, negotiation) ?? NextResponse.next();
  };
}
