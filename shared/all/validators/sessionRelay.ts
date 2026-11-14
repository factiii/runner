import { z } from 'zod';

import {
  RELAY_SESSION_STATES,
  SESSION_FILE_CHUNKS_MAX,
  SESSION_MESSAGE_MAX
} from '../domains/sessionRelay';

// The session relay's frames (.specs/card-sessions.md "Across runners";
// domains/sessionRelay.ts). The server parses what a runner or the desktop
// app sends it; the runner and the app parse what the server sends them.

const slug = z.string().trim().min(1).max(128);
const sessionId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._-]+$/);
/** `r12`, `desktop:5`, or a runner's name. */
const target = z.string().trim().min(1).max(128);
const cardId = z.string().uuid();
/** A file on the target session, as the calling agent named it: relative to
 *  its workspace, or absolute inside it or its board's drops, scratchpad or
 *  builds. The target resolves and checks it. */
const filePath = z
  .string()
  .min(1)
  .max(1024)
  .refine((p) => !p.includes('\0'), 'no NUL in a path');
/** `info` first (its size and hash), then each chunk by index. */
const filePart = z.union([
  z.literal('info'),
  z.number().int().min(0).max(SESSION_FILE_CHUNKS_MAX)
]);
/** The opening message of a start, the same size as a message. */
const text = z.string().trim().min(1).max(SESSION_MESSAGE_MAX);

const relaySessionSchema = z.object({
  id: sessionId,
  title: z.string().max(200),
  state: z.enum(RELAY_SESSION_STATES),
  mode: z.enum(['Chat', 'Code']),
  card: cardId.nullable()
});

const relayBoardSchema = z.object({
  spaceSlug: slug,
  sessions: z.array(relaySessionSchema).max(200)
});

export const runnerOffersSchema = z.object({
  os: z.string().max(64),
  tart: z.boolean(),
  simulator: z.boolean(),
  gpu: z.boolean()
});

/** Runner -> server, `runner:sessions`: its live sessions per board, what it
 *  offers, and whether its owner lets other runners start sessions there.
 *  On connect and on every change. */
export const runnerSessionsReportSchema = z.object({
  boards: z.array(relayBoardSchema).max(200),
  offers: runnerOffersSchema,
  allowRemoteStarts: z.boolean(),
  // Where this runner has work running (its Activity: card sessions, jobs),
  // board slugs only, and whether any runs on no board. The server keeps the
  // owner's app (and a Shell member's on those boards) linked to the runner
  // while it is busy, so the Running jobs pill, job-finish notices and
  // approvals still reach them with links opened only when needed
  // (.specs/runner-link.md). Absent from older runners.
  busy: z
    .object({
      boards: z.array(slug).max(200),
      runnerWide: z.boolean()
    })
    .optional()
});
export type RunnerSessionsReport = z.infer<typeof runnerSessionsReportSchema>;

/** Desktop app -> server, `desktop:sessions`: one board's local sessions,
 *  each time the app reads them. */
export const desktopSessionsReportSchema = relayBoardSchema;
export type DesktopSessionsReport = z.infer<typeof desktopSessionsReportSchema>;

const origin = {
  actor: z.object({
    userId: z.string().regex(/^\d+$/),
    name: z.string().max(200)
  }),
  from: z.object({ board: slug, session: sessionId })
};

const startArgs = z.object({
  mode: z.enum(['chat', 'code']),
  message: text,
  title: z.string().trim().max(120).optional(),
  cardId: cardId.optional(),
  baseBranch: z.string().trim().max(200).optional()
});

/** Runner -> server, `runner:session-relay` (acked): a hypervisor tool's
 *  call that reaches past this runner. */
export const sessionRelayRequestSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('runners'), ...origin }),
  z.object({ op: z.literal('sessions'), board: slug.optional(), ...origin }),
  z.object({
    op: z.literal('read'),
    runner: target,
    board: slug,
    session: sessionId,
    limit: z.number().int().min(1).max(100),
    ...origin
  }),
  z.object({
    op: z.literal('message'),
    runner: target,
    board: slug,
    session: sessionId,
    text,
    ...origin
  }),
  z.object({
    op: z.literal('start'),
    runner: target,
    board: slug,
    start: startArgs,
    ...origin
  }),
  z.object({
    op: z.literal('file'),
    runner: target,
    board: slug,
    session: sessionId,
    path: filePath,
    part: filePart,
    ...origin
  })
]);
export type SessionRelayRequest = z.infer<typeof sessionRelayRequestSchema>;

const opBase = {
  spaceSlug: slug,
  spaceId: z.number().int().positive().optional(),
  actor: origin.actor,
  /** The asking session and its runner, for the target's audit log and the
   *  message's header. */
  from: z.object({
    runner: z.string().max(128),
    runnerId: z.string().max(64),
    board: slug,
    session: sessionId
  })
};

/** Server -> runner `runner:session-op`, or -> desktop app
 *  `desktop:session-op` (acked): one call for a session there. */
export const sessionOpSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('read'),
    session: sessionId,
    limit: z.number().int().min(1).max(100),
    ...opBase
  }),
  z.object({
    op: z.literal('message'),
    session: sessionId,
    text,
    messageId: z.string().uuid(),
    ...opBase
  }),
  z.object({ op: z.literal('start'), start: startArgs, ...opBase }),
  z.object({
    op: z.literal('file'),
    session: sessionId,
    path: filePath,
    part: filePart,
    ...opBase
  })
]);
export type SessionOp = z.infer<typeof sessionOpSchema>;
