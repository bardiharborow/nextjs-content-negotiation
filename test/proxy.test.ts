import { NextRequest } from "next/server.js";
import { describe, expect, it } from "vitest";
import { defineNegotiation } from "../src/config.js";
import { createNegotiationProxy, negotiateRequest } from "../src/proxy.js";

const negotiation = defineNegotiation({
  rules: [
    {
      source: "/docs/:path*",
      variants: [
        { type: "text/html", language: "en" },
        { type: "text/markdown", destination: "/md/docs/:path*" },
        { type: "text/html", language: "fr", destination: "/fr/docs/:path*" },
      ],
    },
    {
      source: "/api/items/:id",
      variants: [
        { type: "application/json", destination: "/api/json/items/:id" },
        { type: "text/csv", destination: "/api/csv/items/:id" },
      ],
      onNoMatch: 406,
    },
  ],
  // The language-neutral Markdown variant wins `*/*` for unoffered languages.
  skipProxyUrlNormalize: true,
});

function request(
  path: string,
  headers: Record<string, string> = {},
  nextConfig?: { basePath?: string; trailingSlash?: boolean },
) {
  return new NextRequest(new URL(path, "http://localhost:3000"), {
    headers,
    nextConfig,
  });
}

function rewrite(response: Response | undefined) {
  return response?.headers.get("x-middleware-rewrite") ?? null;
}

describe("negotiateRequest", () => {
  it("passes through the default variant with Vary set", () => {
    const response = negotiateRequest(request("/docs/intro"), negotiation);
    expect(response?.headers.get("x-middleware-next")).toBe("1");
    expect(rewrite(response)).toBeNull();
    expect(response?.headers.get("vary")).toBe("Accept, Accept-Language, RSC");
    expect(response?.headers.get("content-location")).toBeNull();
  });

  it("rewrites to the selected variant, keeping params and the query string", () => {
    const response = negotiateRequest(
      request("/docs/guide/setup?ref=home", { accept: "text/markdown" }),
      negotiation,
    );
    expect(rewrite(response)).toBe(
      "http://localhost:3000/md/docs/guide/setup?ref=home",
    );
    expect(response?.headers.get("content-location")).toBe(
      "/md/docs/guide/setup?ref=home",
    );
    expect(response?.headers.get("vary")).toBe("Accept, Accept-Language, RSC");
  });

  it("negotiates language", () => {
    const response = negotiateRequest(
      request("/docs/intro", {
        "accept-language": "fr-CA, fr;q=0.9, en;q=0.5",
      }),
      negotiation,
    );
    expect(rewrite(response)).toBe("http://localhost:3000/fr/docs/intro");
    expect(response?.headers.get("content-language")).toBe("fr");
  });

  it("sets Content-Language for the default variant", () => {
    const response = negotiateRequest(request("/docs/intro"), negotiation);
    expect(response?.headers.get("content-language")).toBe("en");
  });

  it("does not set Content-Language for a language-neutral variant", () => {
    const response = negotiateRequest(
      request("/docs/intro", { accept: "text/markdown" }),
      negotiation,
    );
    expect(response?.headers.get("content-language")).toBeNull();
  });

  it("does not set Content-Language on a 406 response", () => {
    const response = negotiateRequest(
      request("/api/items/1", { accept: "image/png" }),
      defineNegotiation({
        rules: [
          {
            source: "/api/items/:id",
            variants: [
              { type: "application/json", language: "en" },
              { type: "text/csv", destination: "/api/csv/items/:id" },
            ],
            onNoMatch: 406,
          },
        ],
      }),
    );
    expect(response?.status).toBe(406);
    expect(response?.headers.get("content-language")).toBeNull();
  });

  describe("Link", () => {
    const docsLink =
      '</md/docs/intro>; rel="alternate"; type="text/markdown", ' +
      '</fr/docs/intro>; rel="alternate"; type="text/html"; hreflang="fr"';

    it("lists the variants with their own URL on the default variant", () => {
      const response = negotiateRequest(request("/docs/intro"), negotiation);
      expect(response?.headers.get("link")).toBe(docsLink);
    });

    it("sends the same value when the request is rewritten", () => {
      const response = negotiateRequest(
        request("/docs/intro", { accept: "text/markdown" }),
        negotiation,
      );
      expect(response?.headers.get("link")).toBe(docsLink);
    });

    it("keeps the query string, base path and trailing slash", () => {
      const response = negotiateRequest(
        request(
          "/site/docs/intro/?ref=home",
          {},
          { basePath: "/site", trailingSlash: true },
        ),
        negotiation,
      );
      expect(response?.headers.get("link")).toBe(
        '</site/md/docs/intro/?ref=home>; rel="alternate"; type="text/markdown", ' +
          '</site/fr/docs/intro/?ref=home>; rel="alternate"; type="text/html"; hreflang="fr"',
      );
    });

    it("keeps encoded params encoded", () => {
      const response = negotiateRequest(
        request("/api/items/a%2Fb", { accept: "text/csv" }),
        negotiation,
      );
      expect(response?.headers.get("link")).toBe(
        '</api/json/items/a%2Fb>; rel="alternate"; type="application/json", ' +
          '</api/csv/items/a%2Fb>; rel="alternate"; type="text/csv"',
      );
    });

    it("is sent on a 406 response", () => {
      const response = negotiateRequest(
        request("/api/items/1", { accept: "image/png" }),
        negotiation,
      );
      expect(response?.status).toBe(406);
      expect(response?.headers.get("link")).toBe(
        '</api/json/items/1>; rel="alternate"; type="application/json", ' +
          '</api/csv/items/1>; rel="alternate"; type="text/csv"',
      );
    });

    it("quotes media type parameters", () => {
      const response = negotiateRequest(
        request("/page"),
        defineNegotiation({
          rules: [
            {
              source: "/page",
              variants: [
                { type: "text/html" },
                {
                  type: 'text/plain; charset=utf-8; x="a,b"',
                  destination: "/page.txt",
                },
              ],
            },
          ],
        }),
      );
      expect(response?.headers.get("link")).toBe(
        '</page.txt>; rel="alternate"; type="text/plain; charset=utf-8; x=\\"a,b\\""',
      );
    });

    it("is not sent when no variant has its own URL", () => {
      const response = negotiateRequest(
        request("/page"),
        defineNegotiation({
          rules: [
            {
              source: "/page",
              variants: [{ encoding: "identity" }, { encoding: "gzip" }],
            },
          ],
        }),
      );
      expect(response?.headers.get("link")).toBeNull();
    });
  });

  describe("on a variant's own URL", () => {
    it("links to the negotiated URL without negotiated attributes", () => {
      const response = negotiateRequest(
        request("/md/docs/guide/setup?ref=home", { accept: "text/html" }),
        negotiation,
      );
      expect(response?.headers.get("x-middleware-next")).toBe("1");
      expect(rewrite(response)).toBeNull();
      expect(response?.headers.get("link")).toBe(
        '</docs/guide/setup?ref=home>; rel="alternate"',
      );
      expect(response?.headers.get("vary")).toBeNull();
      expect(response?.headers.get("content-location")).toBeNull();
    });

    it("keeps the base path, trailing slash and encoded params", () => {
      const response = negotiateRequest(
        request(
          "/site/fr/docs/a%2Fb/",
          {},
          { basePath: "/site", trailingSlash: true },
        ),
        negotiation,
      );
      expect(response?.headers.get("link")).toBe(
        '</site/docs/a%2Fb/>; rel="alternate"',
      );
    });

    it("declares a type or language that every variant shares", () => {
      const shared = defineNegotiation({
        rules: [
          {
            source: "/page",
            variants: [
              { type: "text/html", language: "en" },
              {
                type: "text/html",
                language: "EN",
                encoding: "gzip",
                destination: "/page.gz",
              },
            ],
          },
        ],
      });
      const response = negotiateRequest(request("/page.gz"), shared);
      expect(response?.headers.get("link")).toBe(
        '</page>; rel="alternate"; type="text/html"; hreflang="en"',
      );
    });

    it("prefers a rule's source over a variant's own URL", () => {
      const overlapping = defineNegotiation({
        rules: [
          {
            source: "/docs/:path*",
            variants: [
              { type: "text/html" },
              { type: "text/markdown", destination: "/docs/raw/:path*" },
            ],
          },
        ],
      });
      const response = negotiateRequest(
        request("/docs/raw/intro"),
        overlapping,
      );
      expect(response?.headers.get("vary")).toBe("Accept, RSC");
    });

    it("does not link when the source needs a param the destination lacks", () => {
      const lossy = defineNegotiation({
        rules: [
          {
            source: "/:lang/docs/:path*",
            variants: [
              { type: "text/html" },
              { type: "text/markdown", destination: "/raw/:path*" },
            ],
          },
        ],
      });
      expect(negotiateRequest(request("/raw/intro"), lossy)).toBeUndefined();
    });

    it("does not link when the value does not fit the source pattern", () => {
      const numeric = defineNegotiation({
        rules: [
          {
            source: "/items/:id(\\d+)",
            variants: [
              { type: "application/json" },
              { type: "text/csv", destination: "/csv/items/:id" },
            ],
          },
        ],
      });
      expect(
        negotiateRequest(request("/csv/items/abc"), numeric),
      ).toBeUndefined();
      expect(
        negotiateRequest(request("/csv/items/12"), numeric)?.headers.get(
          "link",
        ),
      ).toBe('</items/12>; rel="alternate"');
    });
  });

  describe("with one language shared by every variant", () => {
    const english = (onNoMatch?: 406) =>
      defineNegotiation({
        rules: [
          {
            source: "/guide/:slug",
            variants: [
              { type: "text/html", language: "en" },
              {
                type: "text/markdown",
                language: "EN",
                destination: "/md/guide/:slug",
              },
            ],
            onNoMatch,
          },
        ],
      });

    it("does not vary on Accept-Language, but still sends Content-Language", () => {
      const response = negotiateRequest(
        request("/guide/intro", {
          accept: "text/markdown",
          "accept-language": "fr",
        }),
        english(),
      );
      expect(response?.headers.get("vary")).toBe("Accept, RSC");
      expect(response?.headers.get("content-language")).toBe("EN");
    });

    it("ignores Accept-Language when selecting", () => {
      // Excluding the language must not change the variant, because caches
      // do not key on Accept-Language.
      const response = negotiateRequest(
        request("/guide/intro", {
          accept: "text/markdown",
          "accept-language": "fr, *;q=0",
        }),
        english(),
      );
      expect(rewrite(response)).toBe("http://localhost:3000/md/guide/intro");
    });

    it("still negotiates the language on a 406 rule", () => {
      const response = negotiateRequest(
        request("/guide/intro", { "accept-language": "fr, *;q=0" }),
        english(406),
      );
      expect(response?.status).toBe(406);
      expect(response?.headers.get("vary")).toBe(
        "Accept, Accept-Language, RSC",
      );
    });
  });

  describe("with one media type shared by every variant", () => {
    const html = (onNoMatch?: 406) =>
      defineNegotiation({
        rules: [
          {
            source: "/guide/:slug",
            variants: [
              { type: "text/html", language: "en" },
              {
                type: "Text/HTML",
                language: "fr",
                destination: "/fr/guide/:slug",
              },
            ],
            onNoMatch,
          },
        ],
      });

    it("varies on Accept-Language only", () => {
      const response = negotiateRequest(request("/guide/intro"), html());
      expect(response?.headers.get("vary")).toBe("Accept-Language");
    });

    it("ignores Accept when selecting", () => {
      // An unacceptable media type must not send the client to the default
      // variant, because caches do not key on Accept.
      for (const accept of ["text/markdown", "text/html;q=0", "*/*"]) {
        const response = negotiateRequest(
          request("/guide/intro", { accept, "accept-language": "fr" }),
          html(),
        );
        expect(rewrite(response)).toBe("http://localhost:3000/fr/guide/intro");
        expect(response?.headers.get("content-language")).toBe("fr");
      }
    });

    it("still negotiates the media type on a 406 rule", () => {
      const response = negotiateRequest(
        request("/guide/intro", { accept: "text/markdown" }),
        html(406),
      );
      expect(response?.status).toBe(406);
      expect(response?.headers.get("vary")).toBe(
        "Accept, Accept-Language, RSC",
      );
    });
  });

  it("does not vary on anything when every variant shares every value", () => {
    const single = defineNegotiation({
      rules: [
        {
          source: "/guide/:slug",
          variants: [
            { type: "text/html", language: "en", encoding: "gzip" },
            {
              type: "text/html",
              language: "en",
              encoding: "gzip",
              destination: "/gz/guide/:slug",
            },
          ],
        },
      ],
    });
    const response = negotiateRequest(
      request("/guide/intro", {
        accept: "text/markdown",
        "accept-language": "fr, *;q=0",
        "accept-encoding": "br",
      }),
      single,
    );
    expect(response?.headers.get("vary")).toBeNull();
    expect(response?.headers.get("x-middleware-next")).toBe("1");
    expect(response?.headers.get("content-language")).toBe("en");
  });

  it("varies on Accept-Language when only some variants declare the language", () => {
    const partial = defineNegotiation({
      rules: [
        {
          source: "/guide/:slug",
          variants: [
            { type: "text/html", language: "en" },
            { type: "text/markdown", destination: "/md/guide/:slug" },
          ],
        },
      ],
      skipProxyUrlNormalize: true,
    });
    const response = negotiateRequest(request("/guide/intro"), partial);
    expect(response?.headers.get("vary")).toBe("Accept, Accept-Language, RSC");
  });

  it("serves the default HTML page to browsers whose language is not offered", () => {
    const browser = {
      accept: "text/html,application/xhtml+xml,*/*;q=0.8",
      "accept-language": "de-DE,de;q=0.9",
    };
    const response = negotiateRequest(
      request("/docs/intro", browser),
      negotiation,
    );
    expect(response?.headers.get("x-middleware-next")).toBe("1");
  });

  it("rewrites the bare source path when an optional param is empty", () => {
    const response = negotiateRequest(
      request("/docs", { accept: "text/markdown" }),
      negotiation,
    );
    expect(rewrite(response)).toBe("http://localhost:3000/md/docs");
  });

  it("does not check params against destination patterns", () => {
    const numeric = defineNegotiation({
      rules: [
        {
          source: "/items/:id",
          variants: [
            { type: "text/html" },
            { type: "text/csv", destination: "/csv/:id(\\d+)" },
          ],
        },
      ],
    });
    const response = negotiateRequest(
      request("/items/abc", { accept: "text/csv" }),
      numeric,
    );
    expect(rewrite(response)).toBe("http://localhost:3000/csv/abc");
  });

  it("round-trips percent-encoded segments", () => {
    const response = negotiateRequest(
      request("/docs/a%20b", { accept: "text/markdown" }),
      negotiation,
    );
    expect(rewrite(response)).toBe("http://localhost:3000/md/docs/a%20b");
  });

  it("keeps encoded slashes in one segment", () => {
    const response = negotiateRequest(
      request("/api/items/a%2Fb", { accept: "text/csv" }),
      negotiation,
    );
    expect(rewrite(response)).toBe("http://localhost:3000/api/csv/items/a%2Fb");
  });

  it("keeps the base path and trailing slash in the variant's URL", () => {
    const response = negotiateRequest(
      request(
        "/site/docs/guide/setup/?ref=home",
        { accept: "text/markdown" },
        { basePath: "/site", trailingSlash: true },
      ),
      negotiation,
    );
    expect(rewrite(response)).toBe(
      "http://localhost:3000/site/md/docs/guide/setup/?ref=home",
    );
    expect(response?.headers.get("content-location")).toBe(
      "/site/md/docs/guide/setup/?ref=home",
    );
  });

  it("keeps slashes matched by a custom pattern", () => {
    const custom = defineNegotiation({
      rules: [
        {
          source: "/docs/:path(.*)",
          variants: [
            { type: "text/html" },
            { type: "text/markdown", destination: "/md/:path(.*)" },
          ],
        },
      ],
    });
    const response = negotiateRequest(
      request("/docs/a/b%20c", { accept: "text/markdown" }),
      custom,
    );
    expect(rewrite(response)).toBe("http://localhost:3000/md/a/b%20c");
    expect(response?.headers.get("content-location")).toBe("/md/a/b%20c");
  });

  it("falls back to the first variant when nothing is acceptable", () => {
    const response = negotiateRequest(
      request("/docs/intro", { accept: "image/png" }),
      negotiation,
    );
    expect(response?.headers.get("x-middleware-next")).toBe("1");
  });

  it("responds 406 when configured", async () => {
    const response = negotiateRequest(
      request("/api/items/1", { accept: "image/png" }),
      negotiation,
    );
    expect(response?.status).toBe(406);
    expect(response?.headers.get("vary")).toBe("Accept, RSC");
    expect(await response?.text()).toContain("Accept: text/csv");
  });

  it("does not set Vary when no variant declares a dimension", () => {
    const plain = defineNegotiation({
      rules: [{ source: "/old/:id", variants: [{ destination: "/new/:id" }] }],
    });
    const response = negotiateRequest(request("/old/1"), plain);
    expect(rewrite(response)).toBe("http://localhost:3000/new/1");
    expect(response?.headers.get("vary")).toBeNull();
  });

  it("returns undefined for paths without a rule", () => {
    expect(negotiateRequest(request("/about"), negotiation)).toBeUndefined();
  });
});

describe("RSC requests", () => {
  const markdownFirst = defineNegotiation({
    rules: [
      {
        source: "/guide/:slug",
        variants: [
          { type: "text/markdown", destination: "/md/guide/:slug" },
          { type: "text/html" },
          { type: "text/html", language: "fr", destination: "/fr/guide/:slug" },
        ],
      },
    ],
    skipProxyUrlNormalize: true,
  });

  it("selects the HTML page for client navigations and prefetches", () => {
    const cases: Record<string, string>[] = [
      { rsc: "1", accept: "*/*" },
      { rsc: "1" },
      { rsc: "1", "next-router-prefetch": "1" },
    ];
    for (const headers of cases) {
      const response = negotiateRequest(
        request("/guide/intro", headers),
        markdownFirst,
      );
      expect(response?.headers.get("x-middleware-next")).toBe("1");
      expect(rewrite(response)).toBeNull();
    }
  });

  it("still negotiates the other dimensions", () => {
    const response = negotiateRequest(
      request("/guide/intro", {
        rsc: "1",
        accept: "*/*",
        "accept-language": "fr",
      }),
      markdownFirst,
    );
    expect(rewrite(response)).toBe("http://localhost:3000/fr/guide/intro");
  });

  it("leaves ordinary requests alone", () => {
    const response = negotiateRequest(
      request("/guide/intro", { accept: "*/*" }),
      markdownFirst,
    );
    expect(rewrite(response)).toBe("http://localhost:3000/md/guide/intro");
  });

  it("varies on RSC, so caches keep navigations and other requests apart", () => {
    for (const headers of [{ accept: "*/*" }, { rsc: "1", accept: "*/*" }]) {
      const response = negotiateRequest(
        request("/guide/intro", headers),
        markdownFirst,
      );
      expect(response?.headers.get("vary")).toBe(
        "Accept, Accept-Language, RSC",
      );
    }
  });

  it("selects the HTML page for Server Actions", () => {
    for (const accept of ["text/x-component", "*/*"]) {
      const response = negotiateRequest(
        request("/guide/intro", {
          accept,
          "next-action": "abc123",
          "accept-language": "fr",
        }),
        markdownFirst,
      );
      expect(rewrite(response)).toBe("http://localhost:3000/fr/guide/intro");
    }
  });

  it("does not respond 406 to Server Actions on a 406 rule", () => {
    const response = negotiateRequest(
      request("/docs/intro", {
        accept: "text/x-component",
        "next-action": "abc123",
      }),
      defineNegotiation({
        rules: [{ ...negotiation.rules[0]!, onNoMatch: 406 }],
        skipProxyUrlNormalize: true,
      }),
    );
    expect(response?.status).toBe(200);
    expect(rewrite(response)).toBeNull();
  });

  it("does not vary on RSC when no variant declares a media type", () => {
    const languages = defineNegotiation({
      rules: [
        {
          source: "/news",
          variants: [
            { language: "en" },
            { language: "fr", destination: "/fr/news" },
          ],
        },
      ],
    });
    const response = negotiateRequest(request("/news"), languages);
    expect(response?.headers.get("vary")).toBe("Accept-Language");
  });
});

describe("createNegotiationProxy", () => {
  it("passes unmatched requests through", () => {
    const proxy = createNegotiationProxy(negotiation);
    expect(proxy(request("/about")).headers.get("x-middleware-next")).toBe("1");
    expect(
      rewrite(proxy(request("/api/items/7", { accept: "text/csv" }))),
    ).toBe("http://localhost:3000/api/csv/items/7");
  });
});
