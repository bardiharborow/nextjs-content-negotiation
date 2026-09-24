/**
 * Framework-agnostic HTTP proactive content negotiation (RFC 9110 §12).
 *
 * Nothing in this module depends on Next.js, so it is safe to import from
 * `next.config`, route handlers, or any other runtime.
 */

import {
  DIMENSION_HEADERS,
  variantDimensions,
  type Dimension,
} from "./dimensions.js";

export type { Dimension };

export interface Variant {
  /** Media type of this representation, e.g. `text/markdown`. */
  type?: string;
  /** Language tag of this representation, e.g. `en` or `fr-CA`. */
  language?: string;
  /**
   * Content coding of this representation, e.g. `gzip`. Variants without an
   * encoding are treated as `identity`. The destination is responsible for
   * sending a matching `Content-Encoding` header.
   */
  encoding?: string;
  /**
   * Path to serve this variant from. Supports the same `:param` syntax as
   * Next.js rewrites. Omit to serve the originally requested path.
   */
  destination?: string;
}

/** Anything with a `get(name)` method, such as `Headers`. */
export interface HeaderSource {
  get(name: string): string | null | undefined;
}

interface Preference {
  /** Quality value in the range [0, 1]. */
  q: number;
  /** How precisely the matching range described the value (higher is more specific). */
  specificity: number;
  /** Position of the matching range in the request header. */
  order: number;
}

interface Range {
  value: string;
  params: Record<string, string>;
  q: number;
  order: number;
}

const QVALUE = /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/;

/** Splits a header list on commas, ignoring commas inside quoted strings. */
function splitList(header: string, separator: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < header.length; i++) {
    const char = header[i];
    if (quoted && char === "\\") {
      current += char + (header[++i] ?? "");
      continue;
    }
    if (char === '"') quoted = !quoted;
    if (char === separator && !quoted) {
      parts.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
}

function unquote(value: string): string {
  return value.startsWith('"') && value.endsWith('"') && value.length >= 2
    ? value.slice(1, -1).replace(/\\(.)/g, "$1")
    : value;
}

/**
 * Parses a weighted header list such as `text/html;level=1;q=0.5, *\/*;q=0.1`.
 * Parameters after `q` are ignored, and entries with an invalid `q` are dropped.
 */
function parseRanges(header: string): Range[] {
  const ranges: Range[] = [];
  splitList(header, ",").forEach((entry, order) => {
    const [rawValue, ...rawParams] = splitList(entry, ";");
    if (!rawValue) return;
    const params: Record<string, string> = {};
    let q = 1;
    for (const rawParam of rawParams) {
      const eq = rawParam.indexOf("=");
      if (eq === -1) continue;
      const name = rawParam.slice(0, eq).trim().toLowerCase();
      const value = unquote(rawParam.slice(eq + 1).trim());
      if (name === "q") {
        if (!QVALUE.test(value)) return;
        q = Number(value);
        break;
      }
      params[name] = value;
    }
    ranges.push({ value: rawValue.toLowerCase(), params, q, order });
  });
  return ranges;
}

interface MediaType {
  type: string;
  subtype: string;
  params: Record<string, string>;
}

function parseMediaType(
  value: string,
  params: Record<string, string> = {},
): MediaType | null {
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) return null;
  return {
    type: value.slice(0, slash),
    subtype: value.slice(slash + 1),
    params,
  };
}

/** Parses an available media type such as `text/html;level=1`, lowercased. */
function parseAvailableType(value: string): MediaType | null {
  const [rawType, ...rawParams] = splitList(value, ";");
  const params: Record<string, string> = {};
  for (const rawParam of rawParams) {
    const eq = rawParam.indexOf("=");
    if (eq !== -1) {
      params[rawParam.slice(0, eq).trim().toLowerCase()] = unquote(
        rawParam.slice(eq + 1).trim(),
      ).toLowerCase();
    }
  }
  return parseMediaType((rawType ?? "").toLowerCase(), params);
}

/**
 * A value in the form its dimension compares: a parsed media type, or a
 * lowercased language tag or content coding.
 */
type Comparable = MediaType | string | null;

function comparable(dimension: Dimension, value: string): Comparable {
  return dimension === "type" ? parseAvailableType(value) : value.toLowerCase();
}

function lowercaseParams(
  params: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(params).map(([k, v]) => [k, v.toLowerCase()]),
  );
}

/** Returns how specifically `accepted` matches `available`, or -1 if it does not match. */
function typeSpecificity(
  accepted: MediaType | null,
  available: MediaType | null,
): number {
  if (!available || !accepted) return -1;
  if (accepted.type === "*") return accepted.subtype === "*" ? 0 : -1;
  if (accepted.type !== available.type) return -1;
  if (accepted.subtype === "*") return 1;
  if (accepted.subtype !== available.subtype) return -1;
  const acceptedParams = Object.entries(accepted.params);
  if (acceptedParams.some(([k, v]) => available.params[k] !== v)) return -1;
  return 2 + acceptedParams.length;
}

/** Returns how specifically `range` matches the lowercased `tag`, or -1 if it does not match. */
function languageSpecificity(range: string, tag: string): number {
  // Basic filtering (RFC 4647 §3.3.1): a range matches a tag that equals it or
  // starts with it followed by `-`. `*` matches every tag.
  if (range === "*") return 0;
  if (range !== tag && !tag.startsWith(range + "-")) return -1;
  // The longest matching range sets the quality (RFC 2616 §14.4), so
  // `zh-Hant` beats `zh` for `zh-Hant-TW`. Among tags matched by the same
  // range, an exact match ranks above a longer tag.
  return 2 * range.split("-").length + (range === tag ? 1 : 0);
}

/** Returns how specifically `range` matches the lowercased `coding`, or -1 if it does not match. */
function encodingSpecificity(range: string, coding: string): number {
  if (range === "*") return 0;
  return range === coding ? 1 : -1;
}

/**
 * Parses a header once and returns a function that finds the range that sets
 * the quality of a value: the most specific matching range (RFC 9110 §12.5.1).
 * The function returns `null` if no range matches. A result with `q: 0` means
 * the client explicitly excluded the value.
 */
function rangeMatcher(
  dimension: Dimension,
  header: string,
): (value: Comparable) => Preference | null {
  const ranges = parseRanges(header);
  let specificity: (range: Range, index: number, value: Comparable) => number;
  if (dimension === "type") {
    const accepted = ranges.map((range) =>
      parseMediaType(range.value, lowercaseParams(range.params)),
    );
    specificity = (_, index, value) =>
      typeSpecificity(accepted[index]!, value as MediaType | null);
  } else {
    const match =
      dimension === "language" ? languageSpecificity : encodingSpecificity;
    specificity = (range, _, value) => match(range.value, value as string);
  }

  return (value) => {
    let best: Preference | null = null;
    ranges.forEach((range, index) => {
      const s = specificity(range, index, value);
      if (s >= 0 && (!best || s > best.specificity))
        best = { q: range.q, specificity: s, order: range.order };
    });
    return best;
  };
}

const LAST = Number.MAX_SAFE_INTEGER;

/**
 * True if the client expressed no preference in this dimension. An empty
 * `Accept-Encoding` is meaningful (identity only), but empty `Accept` and
 * `Accept-Language` headers are treated as absent.
 */
function isAbsent(
  dimension: Dimension,
  header: string | null | undefined,
): header is null | undefined | "" {
  return header == null || (dimension !== "encoding" && header.trim() === "");
}

interface ParsedHeader {
  dimension: Dimension;
  /** Best matching range for a value; `null` if the header is absent. */
  match: ((value: Comparable) => Preference | null) | null;
}

function parseHeader(
  dimension: Dimension,
  header: string | null | undefined,
): ParsedHeader {
  return {
    dimension,
    match: isAbsent(dimension, header) ? null : rangeMatcher(dimension, header),
  };
}

/**
 * Computes the client's preference for one available value. Returns `null` if
 * the value is not acceptable. A missing header accepts everything equally,
 * except that a missing `Accept-Encoding` prefers `identity`, since the client
 * may not be able to decode anything else.
 */
function score(
  { dimension, match }: ParsedHeader,
  value: string,
  key: Comparable = comparable(dimension, value),
): Preference | null {
  const identity =
    dimension === "encoding" && value.toLowerCase() === "identity";
  if (!match)
    return {
      q: 1,
      specificity: 0,
      order: dimension !== "encoding" || identity ? 0 : LAST,
    };

  const best = match(key);

  if (!best && identity) {
    // identity is acceptable unless excluded by `identity;q=0` (handled above,
    // since it matches) or `*;q=0` (RFC 9110 §12.5.3).
    return { q: 0.001, specificity: -1, order: LAST };
  }

  return best && best.q > 0 ? best : null;
}

/**
 * Orders two preferences; negative means `a` is preferred. Specificity only
 * breaks ties between values matched by the same range, such as `en` and
 * `en-AU` for `Accept-Language: en`. Otherwise the client's order decides.
 */
function comparePreference(a: Preference, b: Preference): number {
  return b.q - a.q || a.order - b.order || b.specificity - a.specificity;
}

/**
 * Returns the acceptable values from `available`, most preferred first. Ties
 * keep the server's order.
 */
export function negotiate(
  dimension: Dimension,
  header: string | null | undefined,
  available: readonly string[],
): string[] {
  const parsed = parseHeader(dimension, header);
  return available
    .map((value, index) => ({ value, index, pref: score(parsed, value) }))
    .filter(
      (entry): entry is typeof entry & { pref: Preference } =>
        entry.pref !== null,
    )
    .sort((a, b) => comparePreference(a.pref, b.pref) || a.index - b.index)
    .map((entry) => entry.value);
}

export interface Selection<V extends Variant> {
  variant: V;
  /** Dimensions the response varies on. Use for the `Vary` header. */
  dimensions: Dimension[];
}

/** A variant's value in one dimension, with its comparable form. */
interface VariantValue {
  value: string;
  key: Comparable;
}

interface PreparedVariants {
  dimensions: Dimension[];
  /** For each variant, its value in each dimension; missing if it is neutral. */
  values: Partial<Record<Dimension, VariantValue>>[];
}

const prepared = new WeakMap<readonly Variant[], PreparedVariants>();

/** Parses a list of variants once, so that each request only parses its headers. */
function prepareVariants(variants: readonly Variant[]): PreparedVariants {
  let result = prepared.get(variants);
  if (!result) {
    const dimensions = variantDimensions(variants);
    const values = variants.map((variant) => {
      const entries: Partial<Record<Dimension, VariantValue>> = {};
      for (const dimension of dimensions) {
        const value =
          variant[dimension] ??
          (dimension === "encoding" ? "identity" : undefined);
        if (value !== undefined)
          entries[dimension] = { value, key: comparable(dimension, value) };
      }
      return entries;
    });
    result = { dimensions, values };
    prepared.set(variants, result);
  }
  return result;
}

/**
 * Picks the best variant for a request.
 *
 * Variants that are unacceptable in any dimension are removed first. The rest
 * are ranked by media type, then language, then encoding, then server order.
 * A variant that does not declare a type or language is neutral in that
 * dimension: always acceptable, but ranked below a declared match.
 *
 * If no variant matches any of the client's languages, a language that
 * matches no range no longer removes a variant. It ranks below neutral
 * variants instead, and only an explicit `q=0` (such as `*;q=0`) still
 * removes it. This way a client whose language is not offered still gets the
 * media type it asked for, not a language-neutral variant of another type.
 *
 * Returns `null` if no variant is acceptable.
 *
 * The variants are parsed on the first call and cached by array, so do not
 * change the array or its variants after that.
 */
export function selectVariant<V extends Variant>(
  variants: readonly V[],
  headers: HeaderSource,
): Selection<V> | null {
  const { dimensions, values } = prepareVariants(variants);
  const neutral: Preference = { q: 0, specificity: -1, order: LAST };
  const unmatched: Preference = { q: 0, specificity: -2, order: LAST };
  const parsed = new Map(
    dimensions.map((d) => [
      d,
      parseHeader(d, headers.get(DIMENSION_HEADERS[d])),
    ]),
  );
  const language = parsed.get("language");
  const languageFallback =
    language?.match != null &&
    !values.some(
      (entries) =>
        entries.language &&
        score(language, entries.language.value, entries.language.key),
    );

  const candidates = variants.flatMap((variant, index) => {
    const prefs: Preference[] = [];
    for (const dimension of dimensions) {
      const header = parsed.get(dimension)!;
      const entry = values[index]![dimension];
      if (entry === undefined) {
        prefs.push(neutral);
        continue;
      }
      if (
        dimension === "language" &&
        languageFallback &&
        !header.match!(entry.key)
      ) {
        prefs.push(unmatched);
        continue;
      }
      const pref = score(header, entry.value, entry.key);
      if (!pref) return [];
      // Without the header, the client expresses no preference in this
      // dimension. A missing Accept-Encoding still prefers identity.
      prefs.push(!header.match && dimension !== "encoding" ? neutral : pref);
    }
    return [{ variant, index, prefs }];
  });

  candidates.sort((a, b) => {
    for (let i = 0; i < dimensions.length; i++) {
      const diff = comparePreference(a.prefs[i]!, b.prefs[i]!);
      if (diff) return diff;
    }
    return a.index - b.index;
  });

  const best = candidates[0];
  return best ? { variant: best.variant, dimensions } : null;
}
