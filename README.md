# nextjs-content-negotiation

HTTP content negotiation for Next.js 16.3+. Serve different variants of one URL,
chosen from the request's `Accept`, `Accept-Language` and `Accept-Encoding`
headers ([RFC 9110 §12](https://www.rfc-editor.org/rfc/rfc9110#section-12)).

```sh
curl localhost:3000/docs/intro                              # HTML
curl -H 'Accept: text/markdown' localhost:3000/docs/intro   # Markdown
curl -H 'Accept-Language: fr' localhost:3000/docs/intro     # French HTML
```

## Setup

1. Define the rules once:

   ```ts
   // negotiation.config.ts
   import { defineNegotiation } from "nextjs-content-negotiation";

   export default defineNegotiation({
     rules: [
       {
         source: "/docs/:path*",
         variants: [
           { type: "text/html", language: "en" }, // no destination: serve /docs/... as is
           {
             type: "text/html",
             language: "fr",
             destination: "/fr/docs/:path*",
           },
           { type: "text/markdown", destination: "/md/docs/:path*" },
         ],
       },
     ],
     // Needed for this rule, see "App Router navigations" below.
     skipProxyUrlNormalize: true,
   });
   ```

2. Wrap the Next.js config. This patches Next.js so that pages keep the `Vary`
   header that the proxy sets (see [Limitations](#limitations)). It does not
   change any other Next.js option.

   ```ts
   // next.config.ts
   import { withContentNegotiation } from "nextjs-content-negotiation";

   export default withContentNegotiation({
     skipProxyUrlNormalize: true /* , ...your config */,
   });
   ```

3. Add the proxy. This selects the variant and rewrites the request:

   ```ts
   // proxy.ts
   import { createNegotiationProxy } from "nextjs-content-negotiation/proxy";
   import negotiation from "./negotiation.config";

   export const proxy = createNegotiationProxy(negotiation);

   // Optional. Next.js reads this statically, so write the sources as literals.
   export const config = { matcher: ["/docs/:path*"] };
   ```

   If you already have a proxy, use `negotiateRequest` instead. It returns
   `undefined` when no rule matches:

   ```ts
   import { negotiateRequest } from "nextjs-content-negotiation/proxy";

   export function proxy(request: NextRequest) {
     const negotiated = negotiateRequest(request, negotiation);
     if (negotiated) return negotiated;
     // ...other proxy logic
   }
   ```

## Rules

| Field       | Description                                                                                                    |
| ----------- | -------------------------------------------------------------------------------------------------------------- |
| `source`    | Path pattern in Next.js `source` syntax, for example `/docs/:path*`. The first matching rule applies.          |
| `variants`  | Available variants, in server preference order. The first variant is the default.                              |
| `onNoMatch` | `'default'` (default) serves the first variant when nothing is acceptable. `406` returns `406 Not Acceptable`. |

Each variant can declare `type`, `language` and `encoding`, plus an optional
`destination`. The destination can use the parameters from `source`. A variant
without a `destination` serves the requested path unchanged.

## How a variant is selected

1. A variant is removed if it is not acceptable in one of its declared
   dimensions. For example, `q=0` removes it, and so does an `Accept` header
   with no matching range.
2. The remaining variants are ranked by media type, then language, then
   encoding. Within one dimension, the order is:
   - the q value;
   - the client's order of the ranges;
   - the specificity of the match, when one range matches several values
     (for `Accept-Language: en`, `en` before `en-AU`);
   - the server's order.

   The most specific matching range sets a value's q value (`text/html;q=0.5`
   overrides `*/*`), but specificity does not rank one value above another.

3. If a variant does not declare a `type` or `language`, it is neutral in that
   dimension: it is always acceptable, but a declared match ranks higher.
   A variant without an `encoding` is `identity`.
4. Language matching uses Basic Filtering (RFC 4647 §3.3.1). A range matches
   a tag that equals it or starts with it followed by `-`, so `en` matches
   `en-US`, but `en-AU` does not match `en`. Browsers usually send the base
   language too (`en-AU,en;q=0.9`).
5. If no variant matches any of the client's languages, a language mismatch
   does not remove a variant. Such variants rank below neutral ones, so a
   German browser still gets the default HTML page. An explicit `q=0` (for
   example `*;q=0`) still removes a variant.

A missing `Accept` or `Accept-Language` header, or an empty one, means the
client has no preference. The first variant then wins. A missing
`Accept-Encoding` header prefers `identity`, because the client may not
support any other encoding.

A `destination` parameter must fit the `source` parameter it copies:
`defineNegotiation` throws if the source parameter can be empty (`?`, `*`) and
the destination one cannot, or if the source parameter can repeat (`*`, `+`) and
the destination one cannot.

### App Router navigations

The App Router fetches pages for client-side navigation and prefetching with
`Accept: */*`. These requests must get the same variant as
`Accept: text/html`, or navigation breaks. `defineNegotiation` checks each rule
with no `Accept-Language` and `Accept-Encoding`, with each declared language
and encoding, and with a language and encoding that no variant offers. It
throws an error if `*/*` picks a different variant in any of these cases.

For example, the rule in [Setup](#setup) fails the check. For a German
browser, `*/*` picks the Markdown variant, because it has no language and so
ranks above the English and French HTML variants.

You can fix this in one of two ways:

- Change the variants. If no variant declares a language or an encoding,
  listing the HTML variant first is enough.
- Let the proxy recognize App Router requests. Set
  `skipProxyUrlNormalize: true` in `next.config` and in the negotiation config:

  ```ts
  // next.config.ts
  export default withContentNegotiation({ skipProxyUrlNormalize: true });

  // negotiation.config.ts
  export default defineNegotiation({
    rules: [/* ... */],
    skipProxyUrlNormalize: true,
  });
  ```

  Then requests with the `RSC: 1` header always negotiate as
  `Accept: text/html`. Language and encoding are still negotiated. This
  option changes Next.js for all proxy code: the proxy sees the `RSC`
  request headers and the `_rsc` search parameter, and Pages Router
  `/_next/data` URLs are not normalized.

Server Actions post to the page's URL with `Accept: text/x-component`. The
proxy always negotiates requests with a `Next-Action` header as
`Accept: text/html`, so an action reaches the variant the browser shows, and
`onNoMatch: 406` does not reject it. This does not need
`skipProxyUrlNormalize`.

The proxy sets a `Vary` header for the dimensions that the rule uses, so the
proxy `matcher` must cover every negotiated path. When the rule negotiates the
media type, `Vary` also lists `RSC`, because App Router navigations always get
the HTML variant. When
the request is rewritten, it also gets `Content-Location` with the variant's
own URL.

The negotiation functions do not depend on Next.js. You can use them directly:

```ts
import { negotiate, selectVariant } from "nextjs-content-negotiation/negotiate";

negotiate("type", "text/*;q=0.5, application/json", [
  "text/html",
  "application/json",
]);
// => ['application/json', 'text/html']
```

## Limitations

- **Next.js is patched at build time.** Next.js 16 replaces `Vary` on App
  Router page responses with its own value (`rsc, next-router-state-tree, …`)
  ([vercel/next.js#85999](https://github.com/vercel/next.js/issues/85999)). Then
  caches cannot tell the variants of a static or ISR page apart.
  `withContentNegotiation` adds a Turbopack and webpack loader that changes this
  one statement in `next/dist/…/app-page-runtime.js`, so it merges the existing
  value instead of replacing it. Nothing in `node_modules` is modified.
  - If a Next.js release changes that code, the build shows a
    `[content-negotiation] Could not find the Vary overwrite` warning, and page
    responses lose the negotiated `Vary` value again.
  - To turn the patch off, pass `{ patchVary: false }` as the second argument.
  - The patch does not cover the Edge runtime.
  - Next.js 16.3 is the minimum. Earlier versions build the page handler
    into a generated module, which a loader cannot target.
- **Encoding variants** only choose a destination. The destination must send
  the correct `Content-Encoding` header itself.

## Development

```sh
npm install
npm run build
npm test
```

`examples/basic` is a small Next.js app that uses the plugin. Its smoke test
checks negotiated responses end to end. CI runs it with Turbopack and webpack,
in `next dev`, with `basePath` and `trailingSlash`, with the oldest supported
Next.js version, and weekly with Next.js canary:

```sh
cd examples/basic
npm install
npm run build && npm run smoke
MODE=dev BUNDLER=webpack npm run smoke
```

## License

[MIT](LICENSE)
