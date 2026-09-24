import { variantDimensions, type Dimension } from "./dimensions.js";
import { selectVariant, type HeaderSource, type Variant } from "./negotiate.js";

/** A list of variants and what to serve when none is acceptable. */
export interface VariantRule<V extends Variant = Variant> {
  variants: readonly V[];
  /** Serve the first variant (`'default'`, the default) or respond `406`. */
  onNoMatch?: "default" | 406;
}

const negotiated = new WeakMap<VariantRule, readonly Variant[]>();

/**
 * Dimensions in which every variant declares the same value. The values are
 * compared as lowercased strings, so equivalent values written differently
 * (such as media type parameters with other spacing) count as different and
 * stay negotiated.
 */
function sharedDimensions(variants: readonly Variant[]): Dimension[] {
  return variantDimensions(variants).filter((dimension) => {
    const values = new Set(
      variants.map((variant) => variant[dimension]?.toLowerCase()),
    );
    return values.size === 1 && !values.has(undefined);
  });
}

/**
 * The variants to select from. If every variant declares the same value in a
 * dimension and `onNoMatch` is not `406`, that dimension cannot change the
 * response: it could only remove every variant, and then the first one is
 * served anyway. The value is left out, so the rule does not vary on its
 * header. With `406`, a client that excludes the value gets `406`, so the
 * dimension stays.
 *
 * The result is cached by rule, so do not change the rule after the first
 * call.
 */
function negotiatedVariants(rule: VariantRule): readonly Variant[] {
  let result = negotiated.get(rule);
  if (!result) {
    const shared =
      rule.onNoMatch === 406 ? [] : sharedDimensions(rule.variants);
    result = shared.length
      ? rule.variants.map((variant) => ({
          ...variant,
          ...Object.fromEntries(
            shared.map((dimension) => [dimension, undefined]),
          ),
        }))
      : rule.variants;
    negotiated.set(rule, result);
  }
  return result;
}

/** Dimensions that the rule negotiates, and so the response varies on. */
export function negotiatedDimensions(rule: VariantRule): Dimension[] {
  return variantDimensions(negotiatedVariants(rule));
}

/**
 * Picks the variant to serve for a request, falling back as `onNoMatch`
 * says. Returns `406` if the response should be `406 Not Acceptable`.
 */
export function resolveVariant<V extends Variant>(
  rule: VariantRule<V>,
  headers: HeaderSource,
): V | 406 {
  const variants = negotiatedVariants(rule);
  const selection = selectVariant(variants, headers);
  if (selection) return rule.variants[variants.indexOf(selection.variant)]!;
  return rule.onNoMatch === 406 ? 406 : rule.variants[0]!;
}
