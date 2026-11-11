/**
 * Shared upload file-type definitions used by client, mobile, and server.
 * Single source of truth — everything derives from EXT_TO_CONTENT_TYPE.
 */

const _EXT_TO_CONTENT_TYPE = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  heic: 'image/heic',
  heif: 'image/heif',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  mpeg: 'video/mpeg',
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
} as const;

type AllowedContentType =
  (typeof _EXT_TO_CONTENT_TYPE)[keyof typeof _EXT_TO_CONTENT_TYPE];

/**
 * Largest RAW object a presigned PUT accepts from a free account
 * (`uploads.getUploadUrls` signs it as the length cap). A file at or under it
 * costs no storage; a premium post upload over it counts against the quota
 * (.specs/uploads.md → "Premium uploads count against storage").
 */
export const RAW_UPLOAD_MAX_BYTES = 100 * 1024 * 1024; // 100MB

/**
 * Largest post upload or screen recording a premium account may make.
 *
 * Not R2's limit: one presigned PUT takes up to 5 GB, and the pipeline has no
 * multipart upload. The ceiling is `UploadVariant.size`, a Postgres `integer`
 * (at most 2,147,483,647). 2 GB (10^9 bytes, the unit storage plans are sold
 * in) stays under it. Going past it needs that column made a bigint.
 */
export const PREMIUM_UPLOAD_MAX_BYTES = 2_000_000_000;

/**
 * The part a screen recording is sent in while it records (S3 multipart,
 * .specs/screen-recording.md → Upload while recording). R2 wants every part
 * but the last the same size and at least 5 MiB, so a part is exactly this
 * and only the last may be smaller. About 20 s of a take at the recorder's
 * bitrate.
 */
export const RECORDING_PART_BYTES = 5 * 1024 * 1024;

/** The most parts a recording can need: PREMIUM_UPLOAD_MAX_BYTES of them. */
export const RECORDING_MAX_PARTS = Math.ceil(
  PREMIUM_UPLOAD_MAX_BYTES / RECORDING_PART_BYTES
);

/** The cap a post upload is held to, by plan. */
export const postUploadMaxBytes = (isPremium: boolean): number =>
  isPremium ? PREMIUM_UPLOAD_MAX_BYTES : RAW_UPLOAD_MAX_BYTES;

/**
 * Whether an upload's bytes count against the owner's storage quota: every
 * screen recording, and a premium post upload over the free cap. A file under
 * the cap stays free, as it was before premium could go past it.
 */
export const uploadChargesStorage = ({
  isPremium,
  screenRecording,
  sizeBytes
}: {
  isPremium: boolean;
  screenRecording: boolean;
  sizeBytes: number;
}): boolean =>
  isPremium && (screenRecording || sizeBytes > RAW_UPLOAD_MAX_BYTES);

/** Maps file extensions to MIME types — the single source of truth */
export const EXT_TO_CONTENT_TYPE: Record<string, AllowedContentType> =
  _EXT_TO_CONTENT_TYPE;

/** Deduplicated list of allowed MIME types */
const ALLOWED_CONTENT_TYPES = [
  ...new Set(Object.values(EXT_TO_CONTENT_TYPE))
];

/** Typed tuple for use with z.enum() — requires [string, ...string[]] */
export const ALLOWED_CONTENT_TYPES_TUPLE = ALLOWED_CONTENT_TYPES as [
  AllowedContentType,
  ...AllowedContentType[]
];

/** Narrows an arbitrary MIME string to one the upload pipeline accepts. */
const isAllowedContentType = (
  value: string
): value is AllowedContentType =>
  (ALLOWED_CONTENT_TYPES as readonly string[]).includes(value);

/** Maps MIME types back to their primary extension */
export const CONTENT_TYPE_TO_EXT: Record<string, string> = Object.fromEntries(
  Object.entries(EXT_TO_CONTENT_TYPE).map(([ext, mime]) => [mime, ext])
);

/**
 * Infers MIME type from a file name's extension.
 * Returns AllowedContentType — unknown extensions fall back to 'application/octet-stream'
 * which Zod will reject at the tRPC boundary with a clear validation error.
 */
export const inferContentType = (
  fileName?: string,
  uri?: string
): AllowedContentType => {
  // Try fileName first, then fall back to URI for extension detection (camera photos may lack fileName)
  const source = fileName || uri || '';
  const ext = source.split(/[?#]/)[0].split('.').pop()?.toLowerCase() || '';
  return EXT_TO_CONTENT_TYPE[ext] ?? ('image/jpeg' as AllowedContentType);
};

/**
 * The content type an upload should declare to the server.
 *
 * `composedContentType` is the type of the bytes the compose step actually
 * produced; `fileName`/`uri` describe where they came from. Prefer the former:
 * the server signs the S3 POST policy for this exact type, keys the object by
 * it, and decides from it whether to expect a VIEW variant — so declaring
 * anything other than what we upload desyncs all three.
 *
 * The name is the unreliable one. iOS's photo picker reports the *original*
 * asset's filename alongside a transcoded temp copy — "IMG_0004.HEIC" for a
 * photo it already converted to JPEG — and any extension missing from
 * EXT_TO_CONTENT_TYPE (".m4v", ".3gp") falls back to image/jpeg, which makes
 * the server issue a VIEW key and then reject the video uploaded to it
 * ("View variant must be JPEG"). Android reports no filename and web reads the
 * real File, so only iOS ever diverged. Fall back to the name only when
 * compose can't type the bytes itself.
 */
export const resolveUploadContentType = (
  composedContentType: string,
  fileName?: string,
  uri?: string
): AllowedContentType =>
  isAllowedContentType(composedContentType)
    ? composedContentType
    : inferContentType(fileName, uri);

/** Returns the upload category for a given content type */
export const getUploadType = (contentType: string) => {
  if (contentType.startsWith('image/')) return 'IMAGE' as const;
  if (contentType.startsWith('video/')) return 'VIDEO' as const;
  return 'DOCUMENT' as const;
};

/** Checks whether a detected MIME type or extension is an allowed upload type */
export const isAllowedFileType = (mime?: string, ext?: string): boolean => {
  if (!mime) return false;
  const allowed = ALLOWED_CONTENT_TYPES as readonly string[];
  return (
    allowed.includes(mime) || (ext !== undefined && ext in EXT_TO_CONTENT_TYPE)
  );
};

/** Dropzone-compatible accept object: `{ 'image/jpeg': ['.jpg', '.jpeg'], ... }` */
export const DROPZONE_ACCEPT: Record<string, string[]> = Object.entries(
  EXT_TO_CONTENT_TYPE
).reduce<Record<string, string[]>>((acc, [ext, mime]) => {
  (acc[mime] ??= []).push(`.${ext}`);
  return acc;
}, {});

/** HTML file-input accept string for all allowed types */
export const FILE_INPUT_ACCEPT = ALLOWED_CONTENT_TYPES.join(',');
