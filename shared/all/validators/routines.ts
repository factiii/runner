import { z } from 'zod';

import { isValidTimeZone, TIME_OF_DAY_REGEX } from '../helpers/routineSchedule';

// Inputs for the `routines` router (.todos/routines.md), shared by the server,
// web and mobile, and the runner's routine frames.

/** The prompt, at most: the same ceiling start_session's opening message has
 *  (session-hypervisor.ts MESSAGE_MAX). */
export const ROUTINE_PROMPT_MAX = 20_000;
export const ROUTINE_TITLE_MAX = 80;
/** Routines one person may keep. Each enabled one is a session or an AI call
 *  every day, so a loop that creates them should hit a wall. */
export const ROUTINES_PER_USER_MAX = 25;

export const routineEngineSchema = z.enum(['RUNNER', 'TRONS']);
export type RoutineEngine = z.infer<typeof routineEngineSchema>;

const tronCapSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER)
  .nullable();

const routineFields = {
  title: z.string().trim().min(1).max(ROUTINE_TITLE_MAX),
  prompt: z.string().trim().min(1).max(ROUTINE_PROMPT_MAX),
  engine: routineEngineSchema,
  /** RUNNER: the runner, and the board whose Chat session runs it. */
  runnerId: z.number().int().positive().nullable(),
  spaceSlug: z.string().min(1).max(128).nullable(),
  fallbackToTrons: z.boolean(),
  timeOfDay: z.string().regex(TIME_OF_DAY_REGEX, {
    message: 'Time is HH:MM, 24-hour'
  }),
  timezone: z.string().min(1).max(64).refine(isValidTimeZone, {
    message: 'Unknown time zone'
  }),
  /** 0 = Sunday … 6 = Saturday. */
  daysOfWeek: z.array(z.number().int().min(0).max(6)).max(7),
  enabled: z.boolean(),
  maxTronsPerRun: tronCapSchema,
  maxTronsPerDay: tronCapSchema
};

const runnerNeedsBoard = (v: {
  engine?: RoutineEngine;
  runnerId?: number | null;
  spaceSlug?: string | null;
}): boolean => v.engine !== 'RUNNER' || (!!v.runnerId && !!v.spaceSlug);

const RUNNER_NEEDS_BOARD = {
  message: 'A routine on a runner needs the runner and a board',
  path: ['runnerId']
};

export const createRoutineSchema = z
  .object(routineFields)
  .refine(runnerNeedsBoard, RUNNER_NEEDS_BOARD);
export type CreateRoutineInput = z.infer<typeof createRoutineSchema>;

export const updateRoutineSchema = z
  .object({ id: z.number().int().positive(), ...routineFields })
  .refine(runnerNeedsBoard, RUNNER_NEEDS_BOARD);
export type UpdateRoutineInput = z.infer<typeof updateRoutineSchema>;

export const routineIdSchema = z.object({ id: z.number().int().positive() });

export const routineRunsSchema = z.object({
  routineId: z.number().int().positive(),
  limit: z.number().int().min(1).max(50).default(20)
});

// ── Runner frames ──────────────────────────────────────────────────────────

/** Server → runner, `runner:routine-due`: start a Chat session for this run. */
export const routineDueFrameSchema = z.object({
  runId: z.number().int().positive(),
  routineId: z.number().int().positive(),
  spaceSlug: z.string().min(1).max(128),
  title: z.string().min(1).max(ROUTINE_TITLE_MAX),
  prompt: z.string().min(1).max(ROUTINE_PROMPT_MAX),
  /** The routine owner's user id: the session acts for them. */
  userId: z.number().int().positive()
});
export type RoutineDueFrame = z.infer<typeof routineDueFrameSchema>;

/** The runner's ack: the session it started, or why it could not. */
export const routineDueAckSchema = z.union([
  z.object({ ok: z.literal(true), sessionId: z.string().min(1).max(128) }),
  z.object({ ok: z.literal(false), error: z.string().max(500) })
]);
export type RoutineDueAck = z.infer<typeof routineDueAckSchema>;
