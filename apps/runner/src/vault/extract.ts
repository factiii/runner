import {
  type ExtractedPage,
  fileExtension,
  htmlToText,
  VAULT_DOCUMENT_EXTENSIONS
} from '@shared/all/domains/vaultText';

// A vault file's text, by the cloud's rules (apps/server/src/helpers/
// vaultExtract.ts): plain text and HTML here, a PDF or a docx by the
// embedder's `/read` (the text layer, else OCR: Apple Vision on a Mac,
// RapidOCR on Linux), and a photo's page is its name, as the cloud's: its
// CLIP vector is what finds it.

/** The cloud vault's photo types (vaultAi.ts IMAGE_MEDIA_TYPES). */
const VAULT_PHOTO_EXTENSIONS = ['jpg', 'jpeg', 'png', 'gif', 'webp'] as const;

/** The most the runner opens, as the cloud (vaultIngest.ts MAX_EXTRACT_BYTES):
 *  a bigger file is attached, not read. */
export const MAX_EXTRACT_BYTES = 50 * 1024 * 1024;

/** Thrown for a file that will read the same way every time: the ingest
 *  marks it FAILED and does not try again. */
export class UnreadableError extends Error {}

export const isPhoto = (name: string) =>
  (VAULT_PHOTO_EXTENSIONS as readonly string[]).includes(fileExtension(name));

/** A file the runner opens; anything else is attached by its path. */
export const isReadable = (name: string) =>
  isPhoto(name) || (VAULT_DOCUMENT_EXTENSIONS as readonly string[]).includes(fileExtension(name));

type ReadDocument = (bytes: Uint8Array, ext: 'pdf' | 'docx') => Promise<ExtractedPage[]>;

/** Pages of text, 1-based order, each tagged with its source. */
export async function extractPages(
  name: string,
  bytes: Uint8Array,
  readDocument: ReadDocument
): Promise<ExtractedPage[]> {
  if (isPhoto(name)) return [{ text: `Photo: ${name}`, source: 'VISION' }];
  const ext = fileExtension(name);
  const utf8 = () => Buffer.from(bytes).toString('utf-8');
  switch (ext) {
    case 'pdf':
    case 'docx':
      return readDocument(bytes, ext);
    case 'txt':
    case 'md':
    case 'csv':
    case 'rst': {
      const text = utf8().trim();
      if (!text) throw new UnreadableError('file is empty');
      return [{ text, source: 'TEXT_LAYER' }];
    }
    case 'html':
    case 'htm': {
      const text = htmlToText(utf8());
      if (!text) throw new UnreadableError('html contains no text');
      return [{ text, source: 'TEXT_LAYER' }];
    }
    default:
      throw new UnreadableError(`unsupported file type: ${ext}`);
  }
}
