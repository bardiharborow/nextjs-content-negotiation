import { selectVariant, type HeaderSource, type Variant } from "./negotiate.js";

/** A list of variants and what to serve when none is acceptable. */
export interface VariantRule<V extends Variant = Variant> {
  variants: readonly V[];
  /** Serve the first variant (`'default'`, the default) or respond `406`. */
  onNoMatch?: "default" | 406;
}

/**
 * Picks the variant to serve for a request, falling back as `onNoMatch`
 * says. Returns `406` if the response should be `406 Not Acceptable`.
 */
export function resolveVariant<V extends Variant>(
  rule: VariantRule<V>,
  headers: HeaderSource,
): V | 406 {
  const selection = selectVariant(rule.variants, headers);
  return (
    selection?.variant ?? (rule.onNoMatch === 406 ? 406 : rule.variants[0]!)
  );
}
