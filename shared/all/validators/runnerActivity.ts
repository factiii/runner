import { z } from 'zod';

import {
  RUNNER_ACTIVITY_RETENTION_MAX_DAYS,
  RUNNER_ACTIVITY_RETENTION_MIN_DAYS,
  RUNNER_JOB_ENGINES,
  RUNNER_JOB_HISTORY_PAGE_MAX,
  RUNNER_JOB_TYPES
} from '../domains/runnerActivity';

// The runner's Activity actions (.specs/runner.md "Activity"). The runner
// parses each payload with these; the apps derive their payload types here.

const jobIdSchema = z.string().min(1).max(128);

/** runnerJobHistory: finished jobs, newest first, a page at a time. Every
 *  filter is optional; `query` matches the title, board and starter. */
export const runnerJobHistorySchema = z.object({
  query: z.string().trim().max(200).optional(),
  type: z.enum(RUNNER_JOB_TYPES).optional(),
  engine: z.enum(RUNNER_JOB_ENGINES).optional(),
  board: z.string().min(1).max(128).optional(),
  starter: z.string().trim().min(1).max(200).optional(),
  /** The `next` of the page before: jobs that ended before this time. */
  before: z.number().finite().optional(),
  limit: z.number().int().min(1).max(RUNNER_JOB_HISTORY_PAGE_MAX).optional()
});
export type RunnerJobHistoryPayload = z.infer<typeof runnerJobHistorySchema>;

/** runnerJobLog and runnerJobStop: one job, by its id. */
export const runnerJobIdSchema = z.object({ id: jobIdSchema });
export type RunnerJobIdPayload = z.infer<typeof runnerJobIdSchema>;

/** runnerActivitySettings (owner only): how many days History keeps, and
 *  whether sessions may be started here from other runners. Either one, or
 *  both. */
export const runnerActivitySettingsSchema = z
  .object({
    retentionDays: z
      .number()
      .int()
      .min(RUNNER_ACTIVITY_RETENTION_MIN_DAYS)
      .max(RUNNER_ACTIVITY_RETENTION_MAX_DAYS)
      .optional(),
    allowRemoteStarts: z.boolean().optional()
  })
  .refine(
    (v) => v.retentionDays !== undefined || v.allowRemoteStarts !== undefined,
    'Nothing to change.'
  );
export type RunnerActivitySettingsPayload = z.infer<
  typeof runnerActivitySettingsSchema
>;
