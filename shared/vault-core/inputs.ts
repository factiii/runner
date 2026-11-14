import { z } from 'zod';

// The inputs of the shared vault procedures. Exported so the server's
// `onedriveEmbed` procedures validate with the very same schemas before they
// hand a call to the router: one definition, so the two cannot drift.

// Mirrors the IngestStatus enum. Written out rather than imported from a
// Prisma client so the input schema stays a plain zod union the clients can
// read off RouterInputs.
export const INGEST_STATUS = z.enum(['PENDING', 'EMBEDDED', 'FAILED']);

// Which files a listing is about. Defaults to ONEDRIVE because that is what
// every caller meant before uploads existed: the Sync tab lists what a folder
// walk produced, and folding uploads into it would put files the sync has never
// seen under a "re-sync to fix these" heading. A surface showing the whole vault
// asks for ALL.
export const VAULT_SOURCE = z.enum(['ONEDRIVE', 'S3', 'ALL']);

// A file search is a few words, not a paragraph.
const FILE_QUERY_MAX = 200;

export const SEARCH_LIMIT = 12;

// Synced uploads with ingest state — offset-paged for useInfiniteQuery.
// Offset (not id-cursor) because Upload.id is a uuid, not monotonic; a row
// inserted mid-scroll can shift a page, which is fine for this bench list.
export const filesInput = z
  .object({
    cursor: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(100).default(50),
    // The Sync tab asks for FAILED only: a list of everything that worked
    // is noise beside a folder list that already says "Synced", while the
    // failures are the rows that need a decision. Optional so the admin
    // bench route can still see the whole vault.
    ingestStatus: INGEST_STATUS.optional(),
    // The Factiiis tab asks for one topic's files: the filter half of
    // "show factiiis so we can filter by them".
    factiiiId: z.number().int().optional(),
    // The standalone app lists the whole vault, uploads included.
    source: VAULT_SOURCE.optional(),
    // 'added' (the default) is newest added first. 'latest' is Oakbox's
    // Organize: by the later of added and last changed (latestFileIds).
    order: z.enum(['added', 'latest']).optional(),
    // Oakbox's file search: only files whose name or text has these
    // words. Shorter than VAULT_SEARCH_MIN_CHARS is no search.
    query: z.string().trim().max(FILE_QUERY_MAX).optional(),
    // Oakbox's search across vaults: when no file has the words, rank
    // by meaning instead (one page, each row with its `distance`), so
    // the runners' hits merge with these. Absent: words only, as the
    // other callers want.
    meaning: z.boolean().optional()
  })
  .optional();

export const searchInput = z.object({
  query: z.string().trim().max(500).default(''),
  cursor: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(50).default(SEARCH_LIMIT)
});

// Several files, or everything inside a folder. A folder is derived from the
// files' names rather than stored, so the backend resolves it — the client
// would otherwise have to page the whole list to name its contents.
export const deleteFilesInput = z
  .object({
    uploadIds: z.array(z.string().min(1)).min(1).max(1000).optional(),
    folder: z.array(z.string().min(1)).min(1).max(20).optional(),
    // Count what would go, delete nothing. What the confirmation quotes.
    dryRun: z.literal(true).optional()
  })
  .refine(
    (v) => Boolean(v.uploadIds) !== Boolean(v.folder),
    'Name the files, or the folder.'
  );

export const downloadUrlInput = z.object({
  uploadId: z.string().min(1),
  // Save it rather than open it (an uploaded file only; OneDrive's own
  // URL decides that for a synced one).
  download: z.boolean().optional()
});

export type FilesInput = z.infer<typeof filesInput>;
