import type { Variant } from "./negotiate.js";

export type Dimension = "type" | "language" | "encoding";

/** Request header consulted for each negotiation dimension. */
export const DIMENSION_HEADERS: Record<Dimension, string> = {
  type: "Accept",
  language: "Accept-Language",
  encoding: "Accept-Encoding",
};

const DIMENSIONS: readonly Dimension[] = ["type", "language", "encoding"];

/** Dimensions that at least one variant declares, in negotiation order. */
export function variantDimensions(variants: readonly Variant[]): Dimension[] {
  return DIMENSIONS.filter((dimension) =>
    variants.some((variant) => variant[dimension] != null),
  );
}
