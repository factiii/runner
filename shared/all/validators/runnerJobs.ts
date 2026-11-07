import { z } from 'zod';

// Inputs for the shared runner job + secrets relay (`runnerJobs`, `runnerCli`
// routers). See .specs/runner-secrets-gate.md. Used by the server and by every
// client that calls it (web, mobile, the laptop CLI).

/** A space slug as the router receives it. */
const runnerSpaceSlugSchema = z.string().min(1).max(128);

/** A job name and a job param name. One rule for the server (these
 *  schemas), the runner (jobs.ts, which loads jobs.json) and the gate push
 *  (runnerGatePush.ts), so a name one accepts is never refused by another. */
export const RUNNER_JOB_NAME_REGEX = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const RUNNER_JOB_PARAM_NAME_REGEX = /^[a-z][a-z0-9_]{0,39}$/i;

/** The runner's reply to a cancel or status for a call it does not hold. The
 *  server reads it to close a call whose start it never confirmed. */
export const RUNNER_NO_SUCH_JOB_CALL = 'No such job call on this runner.';

/** A job is named, never a command: a short identifier the runner resolves
 *  against its own allowlist. */
export const runnerJobNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(RUNNER_JOB_NAME_REGEX, {
    message: 'Job names are lowercase letters, digits, "-", "_" and "."'
  });

/** Job params: a small flat map of strings. The runner checks each value
 *  against the regex its job declares; the server only bounds the size. */
export const runnerJobParamsSchema = z
  .record(z.string().regex(RUNNER_JOB_PARAM_NAME_REGEX), z.string().max(512))
  .refine((p) => Object.keys(p).length <= 16, {
    message: 'At most 16 params'
  });

export const RUNNER_SECRET_KEY_REGEX = /^[A-Z][A-Z0-9_]*$/;

/** Upper bound on an encrypted secret update, armor included. */
const RUNNER_SECRET_MAX_BYTES = 1024 * 1024;

const AGE_ARMOR_BEGIN = '-----BEGIN AGE ENCRYPTED FILE-----';
const AGE_ARMOR_END = '-----END AGE ENCRYPTED FILE-----';

/** Age armor, and nothing else: the server relays ciphertext only, so a value
 *  sent in the clear is refused here rather than forwarded. */
const runnerSecretCiphertextSchema = z
  .string()
  .max(RUNNER_SECRET_MAX_BYTES, { message: 'Ciphertext must be under 1 MB' })
  .refine(
    (s) => {
      const t = s.trim();
      return t.startsWith(AGE_ARMOR_BEGIN) && t.endsWith(AGE_ARMOR_END);
    },
    { message: 'Ciphertext must be age armor' }
  );

/** A call that named no runner. The CLI before 0.26.0 sends none, and this
 *  sentence is what its user reads. */
export const RUNNER_ID_REQUIRED =
  'Name the runner: update factiii-runner, run factiii-runner runners to list them, and pass --runner.';

/** The runner a call is for, by its id. Every call names one: the server
 *  never picks a runner for the caller. */
const runnerIdSchema = z.number({ error: RUNNER_ID_REQUIRED }).int().positive();

/** A space alone: the calls that are about the caller's standing on the
 *  board and name no runner (`runners`, `approvals`, `allowedAddresses`). */
export const runnerJobsSpaceSchema = z.object({
  spaceSlug: runnerSpaceSlugSchema
});

export const runnerJobsListSchema = z.object({
  spaceSlug: runnerSpaceSlugSchema,
  runnerId: runnerIdSchema
});

export const runnerJobsCallSchema = z.object({
  spaceSlug: runnerSpaceSlugSchema,
  runnerId: runnerIdSchema,
  job: runnerJobNameSchema,
  params: runnerJobParamsSchema.default({})
});

export const runnerJobsStatusSchema = z.object({
  callId: z.string().uuid(),
  afterSeq: z.number().int().min(-1).default(-1)
});

export const runnerJobsCancelSchema = z.object({
  callId: z.string().uuid()
});

export const runnerJobsRecipientSchema = z.object({
  spaceSlug: runnerSpaceSlugSchema,
  runnerId: runnerIdSchema
});

export const runnerJobsSubmitSecretSchema = z.object({
  spaceSlug: runnerSpaceSlugSchema,
  runnerId: runnerIdSchema,
  key: z.string().min(1).max(128).regex(RUNNER_SECRET_KEY_REGEX, {
    message: 'Key names are UPPER_SNAKE_CASE'
  }),
  kind: z.enum(['env', 'file']),
  ciphertext: runnerSecretCiphertextSchema
});

export const runnerJobsAuditSchema = z.object({
  spaceSlug: runnerSpaceSlugSchema,
  runnerId: runnerIdSchema,
  query: z
    .object({
      limit: z.number().int().min(1).max(500).optional(),
      beforeTs: z.string().max(64).optional(),
      actorUserId: z.string().max(32).optional(),
      job: z.string().max(128).optional(),
      key: z.string().max(128).optional()
    })
    .default({})
});

export const runnerApprovalOptInSchema = z.object({
  spaceSlug: runnerSpaceSlugSchema,
  optIn: z.boolean()
});

// ── Caller IP pin ──
// The server's two refusals on the gated runnerJobs routes (run, cancel,
// submitSecret, audit). The CLI matches the message, the same way it matches
// RUNNER_NO_SUCH_JOB_CALL, so a reworded sentence here must change there too.

/** The account has no usable 2FA: no code could ever confirm an address. */
export const RUNNER_IP_TWOFA_REQUIRED =
  'Turn on two-factor authentication to call runner jobs.';

/** The call came from an address other than the pinned one. The caller
 *  starts a challenge (`runnerJobs.ipChallenge`) and answers it with the
 *  authenticator code (`runnerJobs.verifyIp`) from that same address. */
export const RUNNER_IP_CHALLENGE_REQUIRED =
  'This address is new. Confirm it with your authenticator code.';

export const runnerJobsVerifyIpSchema = z.object({
  challengeId: z.string().uuid(),
  code: z.string().regex(/^[0-9]{6}$/, { message: 'A code is 6 digits' })
});

// ── Laptop CLI device login ──

export const runnerCliStartLoginSchema = z.object({
  /** Shown on the approve page and in the token list, e.g. "jon-mbp". */
  label: z.string().min(1).max(64)
});

/** The code the user sees and types/confirms on the web: XXXX-XXXX. */
export const runnerCliUserCodeSchema = z
  .string()
  .regex(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/, { message: 'Invalid code' });

export const runnerCliCodeSchema = z.object({
  userCode: runnerCliUserCodeSchema
});

export const runnerCliPollLoginSchema = z.object({
  deviceCode: z.string().min(32).max(128)
});

// ── Runner pairing by code (`factiii-runner setup`) ──
// Approve, deny and info take `runnerCliCodeSchema`; the poll takes
// `runnerCliPollLoginSchema`. Same code shape as the CLI login.

export const runnerPairStartSchema = z.object({
  name: z.string().min(1).max(64),
  platform: z.string().max(32).default('unknown')
});

export const runnerCliRevokeSchema = z.object({
  id: z.number().int().positive()
});
