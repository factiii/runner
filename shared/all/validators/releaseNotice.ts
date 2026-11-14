import { z } from 'zod';

// POST /webhooks/release (apps/server/src/routers/releaseNotify.ts): a
// release went out. Sent by .github/workflows/release-runner.yml for the
// runner and by the desktop-release-publish job for the desktop app, with
// the RELEASE_NOTIFY_TOKEN bearer. The server re-reads npm and GitHub itself:
// `version` only says what to wait for, never what to offer.

const RELEASE_VERSION = /^v?\d+\.\d+\.\d+$/;

export const releaseNoticeSchema = z
  .object({
    app: z.enum(['runner', 'desktop']),
    /** The version just released. The server waits (briefly) until npm or
     *  GitHub serves it, since a release can take a few seconds to show. */
    version: z.string().regex(RELEASE_VERSION).optional(),
    /** npm has just staged this runner version: push the owner the link to
     *  approve it (npm allows no automated approval). Runner only. */
    npmStaged: z.boolean().optional()
  })
  .strict();

export type ReleaseNotice = z.infer<typeof releaseNoticeSchema>;
