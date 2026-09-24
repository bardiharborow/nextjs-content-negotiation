import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
import varyLoader from "../src/vary-loader.cts";

const require = createRequire(import.meta.url);

function run(source: string) {
  const context = {
    resourcePath: "app-page-runtime.js",
    emitWarning: vi.fn(),
    callback: vi.fn(),
  };
  varyLoader.call(context, source, "input-map");
  const [error, output, map] = context.callback.mock.calls[0]!;
  return {
    error,
    output: output as string,
    map,
    warnings: context.emitWarning.mock.calls,
  };
}

/** Runs the patched statement against a fake response and returns the final Vary. */
function varyAfter(
  existing: string | string[] | undefined,
  varyHeader: string,
) {
  const { output } = run("res.setHeader('Vary', varyHeader);");
  const headers: Record<string, unknown> = { vary: existing };
  const res = {
    getHeader: (name: string) => headers[name.toLowerCase()],
    setHeader: (name: string, value: unknown) =>
      (headers[name.toLowerCase()] = value),
  };
  new Function("res", "varyHeader", output)(res, varyHeader);
  return headers.vary;
}

describe("vary-loader", () => {
  it("merges the existing Vary value instead of replacing it", () => {
    expect(
      varyAfter("Accept, Accept-Language", "rsc, next-router-state-tree"),
    ).toBe("Accept, Accept-Language, rsc, next-router-state-tree");
    expect(varyAfter(["Accept", "rsc"], "rsc, next-url")).toBe(
      "Accept, rsc, next-url",
    );
  });

  it("keeps Next.js's value when nothing was set before", () => {
    expect(varyAfter(undefined, "rsc, next-router-state-tree")).toBe(
      "rsc, next-router-state-tree",
    );
  });

  it("removes duplicates case-insensitively", () => {
    expect(varyAfter("RSC, Accept", "rsc, accept")).toBe("RSC, Accept");
  });

  it("keeps the source map and line count", () => {
    const source = "a();\n            res.setHeader('Vary', varyHeader);\nb();";
    const { error, output, map, warnings } = run(source);
    expect(error).toBeNull();
    expect(map).toBe("input-map");
    expect(output.split("\n")).toHaveLength(3);
    expect(warnings).toHaveLength(0);
  });

  it("warns and passes the source through when the overwrite is not found", () => {
    const { output, warnings } = run("other();");
    expect(output).toBe("other();");
    expect(warnings).toHaveLength(1);
  });

  it("patches the installed Next.js runtime", () => {
    for (const path of [
      "next/dist/esm/build/templates/app-page-runtime.js",
      "next/dist/build/templates/app-page-runtime.js",
    ]) {
      const { output, warnings } = run(
        readFileSync(require.resolve(path), "utf8"),
      );
      expect(warnings).toHaveLength(0);
      expect(output).not.toMatch(/res\.setHeader\('Vary', varyHeader\)/);
    }
  });
});
