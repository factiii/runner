// What a secret looks like in free text, on shape alone: the vendor token
// shapes, credentials inside a URL, and `password=…`. The server's runner job
// param redaction (apps/server/src/helpers/redactJobParams.ts) replaces them;
// a message between sessions (.specs/card-sessions.md "Across runners") is
// refused when it holds one, on the runner that sends it and again on the
// server that relays it. Shared so the two cannot disagree.

// Whole tokens with a known vendor shape, matched anywhere in the text,
// quoted or not.
export const KNOWN_TOKEN_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{10,}\b/g, // Stripe
  /\bwhsec_[A-Za-z0-9]{10,}\b/g, // Stripe webhook
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}\b/g, // Anthropic / OpenAI
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, // GitHub
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/g, // GitLab
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, // Slack
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bAIza[0-9A-Za-z_-]{35}\b/g, // Google API key
  /\bnpm_[A-Za-z0-9]{30,}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g // JWT
];

// Credentials inside a connection string or URL: `://user:pass@`, `password=…`.
export const URL_CREDENTIALS =
  /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@'"]*:)([^\s@'"]+)(@)/gi;
export const KEY_VALUE_SECRET =
  /(\b(?:password|passwd|pwd|secret|token|api_?key|apikey)\s*=\s*)([^\s&;'"]+)/gi;

/** A `name=value` shorter than this is talk ("token=abc" in an example), not
 *  a credential. */
const MIN_KEY_VALUE_SECRET = 8;

/**
 * What kind of secret `text` holds, or null. Shape only, like the job param
 * redaction: it cannot know a real value. A git sha or a uuid is not one.
 */
export function findSecret(text: string): string | null {
  // `search` ignores a pattern's `g` and its lastIndex, so the shared
  // patterns stay safe to reuse.
  if (KNOWN_TOKEN_PATTERNS.some((pattern) => text.search(pattern) !== -1)) {
    return 'a token or private key';
  }
  if (text.search(URL_CREDENTIALS) !== -1) return 'a password inside a URL';
  for (const match of text.matchAll(KEY_VALUE_SECRET)) {
    if ((match[2] ?? '').length >= MIN_KEY_VALUE_SECRET) {
      return 'a password or key after its name';
    }
  }
  return null;
}
