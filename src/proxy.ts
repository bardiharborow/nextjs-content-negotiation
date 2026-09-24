import { NextResponse, type NextRequest } from "next/server.js";
import {
  compile,
  match,
  type MatchFunction,
  type PathFunction,
} from "path-to-regexp";
import type { NegotiationConfig, NegotiationRule } from "./config.js";
import { DIMENSION_HEADERS, type Dimension } from "./dimensions.js";
import type { HeaderSource, Variant } from "./negotiate.js";
import {
  negotiatedDimensions,
  resolveVariant,
  sharedDimensions,
} from "./resolve.js";

type Params = Record<string, string | string[]>;

interface CompiledRule {
  match: MatchFunction<Params>;
  destinations: Map<Variant, PathFunction<Params>>;
  /** Matchers for the variants' own URLs, to link back to `source`. */
  variantMatches: MatchFunction<Params>[];
  /** Builds the negotiated URL from the params of a variant's own URL. */
  source: PathFunction<Params>;
  /** Link to the negotiated URL, after the target: `rel` and fixed attributes. */
  negotiatedLinkParams: string;
  vary: string | null;
  /** Body of the `406 Not Acceptable` response, listing the variants. */
  notAcceptableBody: string;
}

const compiled = new WeakMap<NegotiationRule, CompiledRule>();

function compileRule(rule: NegotiationRule): CompiledRule {
  let result = compiled.get(rule);
  if (!result) {
    const dimensions = negotiatedDimensions(rule);
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
      variantMatches: rule.variants.flatMap((variant) =>
        variant.destination === undefined
          ? []
          : [match<Params>(variant.destination)],
      ),
      // Validate the params, because they come from a destination pattern
      // that can accept values the source pattern does not.
      source: compile<Params>(rule.source, { validate: true }),
      negotiatedLinkParams: negotiatedLinkParams(rule.variants),
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
 * The variant's own URL, for the rewrite, and its path and query. `href` adds
 * the base path, locale and trailing slash that the request had. The query is
 * part of the variant's URL (RFC 9110 §8.7).
 */
function variantUrl(
  request: NextRequest,
  path: PathFunction<Params>,
  params: Params,
): { url: URL; location: string } {
  const url = request.nextUrl.clone();
  url.pathname = path(params);
  const { pathname, search } = new URL(url.href);
  return { url, location: pathname + search };
}

/** A quoted string (RFC 9110 §5.6.4). */
const quote = (value: string) => `"${value.replace(/["\\]/g, "\\$&")}"`;

/**
 * Parameters of the link from a variant's own URL to the negotiated URL. The
 * negotiated URL can serve any variant, so it only gets a `type` or
 * `hreflang` that every variant shares.
 */
function negotiatedLinkParams(variants: readonly Variant[]): string {
  const shared = sharedDimensions(variants);
  const first = variants[0]!;
  let params = '; rel="alternate"';
  if (shared.includes("type")) params += `; type=${quote(first.type!)}`;
  if (shared.includes("language"))
    params += `; hreflang=${quote(first.language!)}`;
  return params;
}

/**
 * A response for a request to a variant's own URL that links to the
 * negotiated URL, or `undefined` if the path is not a variant's URL or the
 * negotiated URL cannot be built from it.
 */
function linkToNegotiated(
  request: NextRequest,
  compiledRule: CompiledRule,
): NextResponse | undefined {
  for (const variantMatch of compiledRule.variantMatches) {
    const matched = variantMatch(request.nextUrl.pathname);
    if (!matched) continue;
    let location: string;
    try {
      ({ location } = variantUrl(request, compiledRule.source, matched.params));
    } catch {
      // The source uses a param that the destination does not, or the
      // destination matched a value that the source pattern does not accept.
      continue;
    }
    const response = NextResponse.next();
    response.headers.append(
      "Link",
      `<${location}>${compiledRule.negotiatedLinkParams}`,
    );
    return response;
  }
  return undefined;
}

/**
 * A `Link` header value (RFC 8288) that lists every variant with its own URL
 * as an alternate, or `null` if no variant has one. It does not depend on the
 * selected variant, so every response from the URL gets the same value.
 */
function alternatesLink(
  request: NextRequest,
  compiledRule: CompiledRule,
  params: Params,
): string | null {
  const links = [...compiledRule.destinations].map(([variant, destination]) => {
    const { location } = variantUrl(request, destination, params);
    let link = `<${location}>; rel="alternate"`;
    if (variant.type !== undefined) link += `; type=${quote(variant.type)}`;
    if (variant.language !== undefined)
      link += `; hreflang=${quote(variant.language)}`;
    return link;
  });
  return links.length ? links.join(", ") : null;
}

/**
 * Negotiates a request against the configured rules.
 *
 * Returns a response that rewrites to the selected variant (or passes the
 * request through), or a 406 response. For a variant's own URL, returns a
 * response that passes the request through with a `Link` to the negotiated
 * URL. Returns `undefined` if the path is neither. Use it to compose
 * negotiation with other proxy logic.
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
        const { url, location } = variantUrl(
          request,
          destination,
          matched.params,
        );
        response = NextResponse.rewrite(url);
        response.headers.set("Content-Location", location);
      } else {
        response = NextResponse.next();
      }
      // A language-neutral variant has no language to declare
      // (RFC 9110 §8.5).
      if (variant.language !== undefined) {
        response.headers.set("Content-Language", variant.language);
      }
    }
    if (compiledRule.vary) response.headers.set("Vary", compiledRule.vary);
    const link = alternatesLink(request, compiledRule, matched.params);
    if (link) response.headers.append("Link", link);
    return response;
  }
  // A rule's `source` takes precedence over every variant's own URL.
  for (const rule of negotiation.rules) {
    const response = linkToNegotiated(request, compileRule(rule));
    if (response) return response;
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
