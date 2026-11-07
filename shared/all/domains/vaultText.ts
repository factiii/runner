// What a vault reads out of a file, shared by the cloud's ingest
// (apps/server/src/helpers/vaultExtract.ts) and the runner's
// (apps/runner/src/vault/extract.ts), so one file gives the same text, and so
// the same rows and vectors, in either place.

/** Documents whose own text a vault reads. Images are not here: their page
 *  is their name, and a CLIP vector is what finds them. */
export const VAULT_DOCUMENT_EXTENSIONS = [
  'pdf',
  'docx',
  'txt',
  'md',
  'csv',
  'rst', // reStructuredText — plain text (Sphinx/Python docs)
  'html',
  'htm'
] as const;

/** One page of extracted text plus its provenance (maps to TranscriptSource).
 *  SPEECH is a video's or audio file's speech, transcribed on the device
 *  before upload; nothing extracts it on a server. */
export type ExtractedPage = {
  text: string;
  source: 'TEXT_LAYER' | 'OCR' | 'VISION' | 'SPEECH';
};

// Strip an HTML document to readable text before embedding: drop <script>/<style>
// bodies, remove all tags, decode the handful of entities that actually show up
// in prose, and collapse whitespace. Deliberately dependency-free — good enough
// for embedding, where exact structure doesn't matter.
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

export function fileExtension(name: string): string {
  return name.slice(name.lastIndexOf('.') + 1).toLowerCase();
}
