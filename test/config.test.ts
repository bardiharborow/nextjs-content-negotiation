import { describe, expect, it, vi } from "vitest";
import { defineNegotiation, withContentNegotiation } from "../src/config.js";

describe("withContentNegotiation", () => {
  it("keeps the user config and does not add headers", () => {
    const headers = () => [
      { source: "/(.*)", headers: [{ key: "X-Frame-Options", value: "DENY" }] },
    ];
    const config = withContentNegotiation({ reactStrictMode: true, headers });
    expect(config.reactStrictMode).toBe(true);
    expect(config.headers).toBe(headers);
    expect(withContentNegotiation({}).headers).toBeUndefined();
  });

  it("does not change skipProxyUrlNormalize", () => {
    expect(withContentNegotiation({}).skipProxyUrlNormalize).toBeUndefined();
    expect(
      withContentNegotiation({ skipProxyUrlNormalize: true })
        .skipProxyUrlNormalize,
    ).toBe(true);
  });

  it("wraps config functions", async () => {
    const wrapped = withContentNegotiation(async (phase) => ({
      distDir: phase,
    }));
    const config = await wrapped("phase-production-build", {
      defaultConfig: {},
    });
    expect(config.distDir).toBe("phase-production-build");
  });
});

describe("Vary patch", () => {
  const runtime =
    "/app/node_modules/next/dist/esm/build/templates/app-page-runtime.js";

  it("registers the loader with Turbopack and keeps user rules", () => {
    const config = withContentNegotiation({
      turbopack: {
        rules: { "*.svg": { loaders: ["@svgr/webpack"], as: "*.js" } },
      },
    });
    const rules = config.turbopack?.rules ?? {};
    expect(rules["*.svg"]).toEqual({ loaders: ["@svgr/webpack"], as: "*.js" });
    const rule = rules["**/app-page-runtime.js"] as {
      loaders: string[];
      condition: { path: RegExp };
    };
    expect(rule.loaders).toEqual(["nextjs-content-negotiation/vary-loader"]);
    expect(rule.condition.path.test(runtime)).toBe(true);
    expect(rule.condition.path.test("/app/src/app-page-runtime.js")).toBe(
      false,
    );
  });

  it("keeps an existing shorthand loader list as a separate rule", () => {
    const config = withContentNegotiation({
      turbopack: {
        rules: {
          "**/app-page-runtime.js": [
            "my-loader",
            { loaders: ["other"], condition: "foreign" },
          ],
        },
      },
    });
    const rules = config.turbopack?.rules?.["**/app-page-runtime.js"] as {
      loaders: string[];
    }[];
    expect(rules.map((rule) => rule.loaders)).toEqual([
      ["my-loader"],
      ["other"],
      ["nextjs-content-negotiation/vary-loader"],
    ]);
  });

  it("keeps an existing single rule object as a separate rule", () => {
    const existing = { loaders: ["my-loader"] };
    const config = withContentNegotiation({
      turbopack: { rules: { "**/app-page-runtime.js": existing } },
    });
    const rules = config.turbopack?.rules?.["**/app-page-runtime.js"] as {
      loaders: string[];
    }[];
    expect(rules).toHaveLength(2);
    expect(rules[0]).toBe(existing);
    expect(rules[1]?.loaders).toEqual([
      "nextjs-content-negotiation/vary-loader",
    ]);
  });

  it("keeps a list of rule objects without adding an empty loader rule", () => {
    const withType = { type: "raw" as const };
    const withCondition = { condition: "foreign" as const };
    const config = withContentNegotiation({
      turbopack: {
        rules: { "**/app-page-runtime.js": [withType, withCondition] },
      },
    });
    const rules = config.turbopack?.rules?.[
      "**/app-page-runtime.js"
    ] as object[];
    expect(rules).toHaveLength(3);
    expect(rules[0]).toBe(withType);
    expect(rules[1]).toBe(withCondition);
  });

  it("adds the loader to webpack without a user webpack config", () => {
    const config = withContentNegotiation({});
    const input = { module: { rules: [] } };
    const result = config.webpack?.(input, {} as never);
    expect(result).toBe(input);
    expect(result.module.rules).toHaveLength(1);
  });

  it("adds the loader to webpack after the user webpack config", () => {
    const userWebpack = vi.fn((config) => ({ ...config, marker: true }));
    const config = withContentNegotiation({ webpack: userWebpack });
    const result = config.webpack?.({ module: { rules: [] } }, {} as never);
    expect(userWebpack).toHaveBeenCalledOnce();
    expect(result.marker).toBe(true);
    expect(result.module.rules).toHaveLength(1);
    expect(
      result.module.rules[0].test.test(runtime.replaceAll("/", "\\")),
    ).toBe(true);
  });

  it("can be turned off", () => {
    const config = withContentNegotiation({}, { patchVary: false });
    expect(config.turbopack).toBeUndefined();
    expect(config.webpack).toBeUndefined();
  });
});

describe("defineNegotiation", () => {
  it("rejects destinations that use undefined params", () => {
    expect(() =>
      defineNegotiation({
        rules: [{ source: "/a/:id", variants: [{ destination: "/b/:slug" }] }],
      }),
    ).toThrow(/:slug/);
  });

  it("rejects destination params whose modifiers do not fit the source", () => {
    const rule = (destination: string) => ({
      rules: [{ source: "/docs/:path*", variants: [{ destination }] }],
    });
    expect(() => defineNegotiation(rule("/md/:path+"))).toThrow(
      /can leave it empty/,
    );
    expect(() => defineNegotiation(rule("/md/:path?"))).toThrow(
      /several segments/,
    );
    expect(() => defineNegotiation(rule("/md/:path"))).toThrow(
      /can leave it empty/,
    );
    expect(() => defineNegotiation(rule("/md/:path*"))).not.toThrow();
    expect(() =>
      defineNegotiation({
        rules: [{ source: "/a/:id", variants: [{ destination: "/b/:id?" }] }],
      }),
    ).not.toThrow();
  });

  describe("App Router navigations", () => {
    const markdownFirst = {
      source: "/docs/:path*",
      variants: [
        { type: "text/markdown", destination: "/md/:path*" },
        { type: "text/html" },
      ],
    };

    it("rejects rules that pick a non-HTML variant for */*", () => {
      expect(() => defineNegotiation({ rules: [markdownFirst] })).toThrow(
        /skipProxyUrlNormalize/,
      );
    });

    it("checks each declared language", () => {
      const variants = [
        { type: "text/html", language: "en" },
        { type: "text/markdown", language: "fr", destination: "/md" },
      ];
      expect(() =>
        defineNegotiation({ rules: [{ source: "/a", variants }] }),
      ).toThrow(/"\/a"/);
    });

    it("checks languages that no variant offers", () => {
      const variants = [
        { type: "text/html", language: "en" },
        { type: "text/html", language: "fr", destination: "/fr" },
        { type: "text/markdown", destination: "/md" },
      ];
      expect(() =>
        defineNegotiation({ rules: [{ source: "/a", variants }] }),
      ).toThrow(/accept-language: x-unlisted/);
    });

    it("checks encodings", () => {
      const variants = [
        { type: "text/html" },
        { type: "application/json", encoding: "br", destination: "/json" },
      ];
      expect(() =>
        defineNegotiation({ rules: [{ source: "/a", variants }] }),
      ).toThrow(/accept-encoding: br/);
    });

    it("checks the page served by a variant without a type", () => {
      const variants = [{ type: "text/markdown", destination: "/md" }, {}];
      expect(() =>
        defineNegotiation({ rules: [{ source: "/a", variants }] }),
      ).toThrow(/"\/a"/);
    });

    it("allows them with skipProxyUrlNormalize", () => {
      expect(() =>
        defineNegotiation({
          rules: [markdownFirst],
          skipProxyUrlNormalize: true,
        }),
      ).not.toThrow();
    });

    it("allows HTML-first rules and rules without HTML", () => {
      const htmlFirst = {
        ...markdownFirst,
        variants: [...markdownFirst.variants].reverse(),
      };
      const api = {
        source: "/api/:id",
        variants: [
          { type: "application/json" },
          { type: "text/csv", destination: "/csv/:id" },
        ],
      };
      expect(() =>
        defineNegotiation({ rules: [htmlFirst, api] }),
      ).not.toThrow();
    });
  });

  it("rejects rules without variants and relative paths", () => {
    expect(() =>
      defineNegotiation({ rules: [{ source: "/a", variants: [] }] }),
    ).toThrow(/no variants/);
    expect(() =>
      defineNegotiation({ rules: [{ source: "a", variants: [{}] }] }),
    ).toThrow(/start with/);
    expect(() =>
      defineNegotiation({
        rules: [{ source: "/a", variants: [{ destination: "b" }] }],
      }),
    ).toThrow(/destination must start with "\/": b/);
  });
});
