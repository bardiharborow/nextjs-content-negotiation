import { describe, expect, it } from "vitest";
import { negotiate, selectVariant, type Variant } from "../src/negotiate.js";
import { resolveVariant } from "../src/resolve.js";

const headers = (init: Record<string, string>) => new Headers(init);

describe("negotiate: type", () => {
  const types = ["text/html", "text/markdown", "application/json"];

  it("accepts everything in server order when the header is missing or empty", () => {
    expect(negotiate("type", null, types)).toEqual(types);
    expect(negotiate("type", "", types)).toEqual(types);
  });

  it("orders by q value", () => {
    expect(
      negotiate(
        "type",
        "text/html;q=0.5, application/json, text/markdown;q=0.8",
        types,
      ),
    ).toEqual(["application/json", "text/markdown", "text/html"]);
  });

  it("uses the most specific range to determine q", () => {
    expect(negotiate("type", "text/*;q=0.9, text/html;q=0.1", types)).toEqual([
      "text/markdown",
      "text/html",
    ]);
  });

  it("ranks by client order at equal q, not by range specificity", () => {
    expect(negotiate("type", "text/*, text/markdown", types)).toEqual([
      "text/html",
      "text/markdown",
    ]);
    expect(negotiate("type", "text/*, application/json", types)).toEqual([
      "text/html",
      "text/markdown",
      "application/json",
    ]);
  });

  it("breaks ties by client order, then server order", () => {
    expect(negotiate("type", "text/markdown, text/html", types)).toEqual([
      "text/markdown",
      "text/html",
    ]);
    expect(negotiate("type", "*/*", types)).toEqual(types);
  });

  it("excludes q=0 even when a wildcard would match", () => {
    expect(negotiate("type", "*/*, text/html;q=0", types)).toEqual([
      "text/markdown",
      "application/json",
    ]);
  });

  it("matches parameters and is case-insensitive", () => {
    expect(
      negotiate("type", "TEXT/HTML;level=1", [
        "text/html",
        "text/html;level=1",
      ]),
    ).toEqual(["text/html;level=1"]);
  });

  it("handles a typical browser Accept header", () => {
    const browser =
      "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
    expect(negotiate("type", browser, types)[0]).toBe("text/html");
  });

  it("ignores malformed entries and quoted commas", () => {
    const available = [
      "text/markdown",
      "application/json",
      'application/json;x="a,b"',
    ];
    expect(
      negotiate(
        "type",
        'garbage, text/markdown;q=2, application/json;x="a,b"',
        available,
      ),
    ).toEqual(['application/json;x="a,b"']);
  });

  it("keeps escaped quotes inside quoted strings", () => {
    const available = ["text/html", 'application/json;x="a\\"b,c"'];
    expect(
      negotiate(
        "type",
        'application/json;x="a\\"b,c", text/html;q=0',
        available,
      ),
    ).toEqual(['application/json;x="a\\"b,c"']);
    // A trailing backslash in an unclosed quote must not throw.
    expect(negotiate("type", 'text/html;x="a\\', ["text/html"])).toEqual([]);
  });

  it("ignores empty entries and parameters without a value", () => {
    expect(
      negotiate("type", "; , text/html;level, text/markdown;q=0.5", types),
    ).toEqual(["text/html", "text/markdown"]);
    expect(negotiate("type", "text/html", ["text/html;foo"])).toEqual([
      "text/html;foo",
    ]);
  });

  it("does not match a wildcard type with a concrete subtype", () => {
    expect(negotiate("type", "*/html", types)).toEqual([]);
  });

  it("never selects an empty available type", () => {
    expect(negotiate("type", "*/*", ["", "text/html"])).toEqual(["text/html"]);
  });
});

describe("negotiate: language", () => {
  const languages = ["en", "en-GB", "fr"];

  it("prefers exact matches, then prefix matches", () => {
    expect(negotiate("language", "en-GB", languages)).toEqual(["en-GB"]);
    expect(negotiate("language", "en", languages)).toEqual(["en", "en-GB"]);
  });

  it("does not fall back from a regional range to its base language", () => {
    expect(negotiate("language", "en-AU", languages)).toEqual([]);
    expect(negotiate("language", "en-AU, en;q=0.9", languages)).toEqual([
      "en",
      "en-GB",
    ]);
  });

  it("orders by q and supports wildcards", () => {
    expect(negotiate("language", "fr, en;q=0.5", languages)).toEqual([
      "fr",
      "en",
      "en-GB",
    ]);
    expect(negotiate("language", "fr, *;q=0.1", languages)).toEqual([
      "fr",
      "en",
      "en-GB",
    ]);
  });

  it("ranks a prefix match by client order", () => {
    expect(negotiate("language", "en, fr", ["fr", "en-GB"])).toEqual([
      "en-GB",
      "fr",
    ]);
  });

  it("does not match unrelated languages", () => {
    expect(negotiate("language", "de", languages)).toEqual([]);
  });

  it("takes the quality from the longest matching range", () => {
    const header = "zh;q=0.1, zh-Hant;q=0.9, en;q=0.5";
    expect(
      negotiate("language", header, ["zh-Hans-CN", "en", "zh-Hant-TW"]),
    ).toEqual(["zh-Hant-TW", "en", "zh-Hans-CN"]);
  });
});

describe("negotiate: encoding", () => {
  const encodings = ["br", "gzip", "identity"];

  it("treats identity as acceptable but least preferred when not listed", () => {
    expect(negotiate("encoding", "gzip", encodings)).toEqual([
      "gzip",
      "identity",
    ]);
  });

  it("accepts only identity for an empty header", () => {
    expect(negotiate("encoding", "", encodings)).toEqual(["identity"]);
  });

  it("prefers identity when the header is missing", () => {
    expect(negotiate("encoding", null, encodings)).toEqual([
      "identity",
      "br",
      "gzip",
    ]);
  });

  it("excludes identity with identity;q=0 or *;q=0", () => {
    expect(negotiate("encoding", "gzip, identity;q=0", encodings)).toEqual([
      "gzip",
    ]);
    expect(negotiate("encoding", "br, *;q=0", encodings)).toEqual(["br"]);
    expect(negotiate("encoding", "br, *;q=0, identity", encodings)).toEqual([
      "br",
      "identity",
    ]);
  });
});

describe("selectVariant", () => {
  const variants: Variant[] = [
    { type: "text/html", language: "en" },
    { type: "text/html", language: "fr", destination: "/fr" },
    { type: "text/markdown", destination: "/md" },
  ];

  it("picks the first variant when the client has no preference", () => {
    expect(selectVariant(variants, headers({}))?.variant).toBe(variants[0]);
  });

  it("negotiates media type", () => {
    expect(
      selectVariant(variants, headers({ accept: "text/markdown" }))?.variant,
    ).toBe(variants[2]);
  });

  it("negotiates language within a media type", () => {
    expect(
      selectVariant(
        variants,
        headers({ accept: "text/html", "accept-language": "fr" }),
      )?.variant,
    ).toBe(variants[1]);
  });

  it("treats undeclared dimensions as neutral", () => {
    const result = selectVariant(
      variants,
      headers({ accept: "text/markdown", "accept-language": "de" }),
    );
    expect(result?.variant).toBe(variants[2]);
  });

  it("considers all dimensions before ranking", () => {
    const mixed: Variant[] = [
      { type: "text/html", language: "en" },
      { type: "text/markdown", language: "fr" },
    ];
    const result = selectVariant(
      mixed,
      headers({
        accept: "text/html, text/markdown;q=0.5",
        "accept-language": "fr",
      }),
    );
    expect(result?.variant).toBe(mixed[1]);
  });

  it("keeps the requested media type when no language matches", () => {
    const browser = {
      accept: "text/html,application/xhtml+xml,*/*;q=0.8",
      "accept-language": "de-DE,de;q=0.9",
    };
    expect(selectVariant(variants, headers(browser))?.variant).toBe(
      variants[0],
    );
  });

  it("ranks neutral variants above unmatched languages", () => {
    const neutral: Variant[] = [{ language: "en" }, { destination: "/any" }];
    expect(
      selectVariant(neutral, headers({ "accept-language": "de" }))?.variant,
    ).toBe(neutral[1]);
  });

  it("removes languages excluded with q=0", () => {
    const result = selectVariant(
      variants,
      headers({ accept: "text/html", "accept-language": "de, *;q=0" }),
    );
    expect(result).toBeNull();
  });

  it("returns null when nothing is acceptable", () => {
    expect(
      selectVariant(variants, headers({ accept: "image/png" })),
    ).toBeNull();
  });

  it("negotiates encodings, defaulting to identity", () => {
    const encoded: Variant[] = [{}, { encoding: "gzip", destination: "/gz" }];
    expect(
      selectVariant(encoded, headers({ "accept-encoding": "gzip" }))?.variant,
    ).toBe(encoded[1]);
    expect(
      selectVariant(encoded, headers({ "accept-encoding": "br" }))?.variant,
    ).toBe(encoded[0]);
  });

  it("serves identity when Accept-Encoding is missing", () => {
    const encoded: Variant[] = [{ encoding: "br", destination: "/br" }, {}];
    expect(selectVariant(encoded, headers({}))?.variant).toBe(encoded[1]);
  });

  it("reports the dimensions that vary", () => {
    expect(selectVariant(variants, headers({}))?.dimensions).toEqual([
      "type",
      "language",
    ]);
  });
});

describe("resolveVariant", () => {
  const variants = [{ type: "application/json" }, { type: "text/csv" }];

  it("returns the selected variant", () => {
    expect(
      resolveVariant({ variants }, new Headers({ accept: "text/csv" })),
    ).toBe(variants[1]);
  });

  it("falls back as onNoMatch says", () => {
    const png = new Headers({ accept: "image/png" });
    expect(resolveVariant({ variants }, png)).toBe(variants[0]);
    expect(resolveVariant({ variants, onNoMatch: "default" }, png)).toBe(
      variants[0],
    );
    expect(resolveVariant({ variants, onNoMatch: 406 }, png)).toBe(406);
  });
});
