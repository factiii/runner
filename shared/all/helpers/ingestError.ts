// What to put under a file that could not be read. Shared by both Oakbox
// clients: the file lists and the document screens.
//
// `Upload.ingestError` holds two very different things. Most of it is written
// for a person — "That document is too long to read. The limit is about 10MB of
// text." — and hiding that behind a generic line throws away the only thing
// that says what to do next. But when the failure came from a model provider,
// the column holds whatever the provider said, verbatim:
//
//   400 {"type":"error","error":{"type":"invalid_request_error","message":
//   "messages.0.content.0.image.source.base64: The image was specified using
//   the image/webp media type…"},"request_id":"req_011Cew…"}
//
// which is three hundred characters of JSON and a request id in a file row.
//
// So: show it when it reads as a sentence, and fall back when it does not. The
// real fix is for the server to stop storing raw provider output in a column
// two clients render — this is the client refusing to pass it on meanwhile.

const FALLBACK = 'Could not be read';

// A leading status code, a brace, or a quoted JSON key — the three shapes
// provider output arrives in. Anything long is suspect regardless.
const MACHINE = /^\s*(\d{3}\s*[{[]|[{[]|"\w+"\s*:)/;
const TOO_LONG = 200;

// `fallback` for a caller whose failure is not a file that could not be read:
// the same check keeps a raw validation error out of a cancel toast.
export const readableIngestError = (
  error: string | null,
  fallback: string = FALLBACK
): string => {
  const trimmed = error?.trim();
  if (!trimmed) return fallback;
  if (MACHINE.test(trimmed) || trimmed.length > TOO_LONG) return fallback;
  return trimmed;
};
