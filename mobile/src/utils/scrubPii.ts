/**
 * Removes personal data from text before an error report leaves the device.
 * Same patterns as the backend's utils/scrubPii.ts: emails, Indian mobile
 * numbers, JWTs and bearer tokens, Razorpay ids, and 6-digit numbers (reset
 * codes and PIN codes). Keys that name personal fields are redacted outright.
 */
const PATTERNS: Array<[RegExp, string]> = [
  [/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[token]'],
  [/Bearer\s+\S+/gi, 'Bearer [token]'],
  [/[^\s@"'<>(),;:]+@[^\s@"'<>(),;:]+\.[a-z]{2,}/gi, '[email]'],
  [/\b(?:pay|order|rfnd)_[A-Za-z0-9]{6,}\b/g, '[razorpay-id]'],
];

/**
 * Applied after PATTERNS, and only to the text between ids (see IDS).
 *
 * A mobile number goes whole, with whatever leads it — +91 or 91 (with or
 * without a space or dash), a 0, or nothing — so it is caught as stored
 * (+919876543210), as typed (98765 43210) and as dialled (09876543210). It
 * must stand alone: digits either side make it part of a longer number, such
 * as a timestamp.
 */
const NUMBER_PATTERNS: Array<[RegExp, string]> = [
  [/(?<!\d)(?:\+?91[\s-]?)?0?[6-9]\d{4}[\s-]?\d{5}(?!\d)/g, '[phone]'],
  [/(?<!\d)\d{6}(?!\d)/g, '[6-digit]'],
];

/**
 * Ids that hold nothing personal but contain runs of digits NUMBER_PATTERNS
 * would take for a phone or a code: Mongo ObjectIds (order ids, in URLs and
 * messages) and order numbers (MF-20261001-482913). They are kept whole.
 */
const IDS = /\b([0-9a-f]{24}|MF-\d{8}-[0-9A-F]{6})\b/;

const SENSITIVE_KEY =
  /pass(word)?|secret|token|authorization|cookie|otp|code|email|phone|address|line1|line2|pincode|fullName|name/i;

export function scrubText(value: string): string {
  let result = value;
  for (const [pattern, replacement] of PATTERNS) result = result.replace(pattern, replacement);
  // split() with a capturing group puts each id at an odd index.
  return result
    .split(IDS)
    .map((part, index) =>
      index % 2 === 1
        ? part
        : NUMBER_PATTERNS.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), part),
    )
    .join('');
}

export function scrubValue<T>(value: T, depth = 0): T {
  if (depth > 8) return '[depth]' as unknown as T;
  if (typeof value === 'string') return scrubText(value) as unknown as T;
  if (Array.isArray(value)) return value.map((entry) => scrubValue(entry, depth + 1)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEY.test(key) ? '[redacted]' : scrubValue(entry, depth + 1);
    }
    return out as T;
  }
  return value;
}

/** A URL without its query string (search terms, ids) and with text scrubbed. */
export function scrubUrl(url: string): string {
  return scrubText(url.split('?')[0]);
}
