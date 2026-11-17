import { z } from 'zod';

import {
  SECURE_LIMITS,
  type SecureEnvelopeInput,
  type SecureSendInput
} from '../domains/secureChat';
import {
  b64Schema,
  e2eeDeviceIdSchema,
  e2eeDeviceKeysSchema,
  e2eeSignatureSchema
} from './e2ee';

// Inputs of the secure router (.specs/secure-chat.md → Server), matching the
// contract types in domains/secureChat.ts. Everything encrypted is opaque
// base64 to the server: it checks sizes and shapes only.

const userIdSchema = z.number().int().positive();
const chatIdSchema = z.string().min(1).max(64);
/** The name the person sees for a device ("Chrome on Mac", "iPhone 16"). */
const deviceNameSchema = z.string().trim().min(1).max(100);

/** secure.registerPrimary: the phone's keys, self-signed. */
export const secureRegisterPrimarySchema = e2eeDeviceKeysSchema.extend({
  name: deviceNameSchema
});

/** secure.linkStart: a browser's keys, self-signed, to become a pending
 *  linked device. */
export const secureLinkStartSchema = e2eeDeviceKeysSchema.extend({
  name: deviceNameSchema
});

/** The token inside the link QR (SECURE_LINK_QR_PREFIX + token). */
const linkTokenSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{32,128}$/, { message: 'Not a link code' });

export const secureLinkPreviewSchema = z.object({ linkToken: linkTokenSchema });

/** secure.linkApprove: the primary's signature over the linked device's keys
 *  (e2eeLinkSigningText). The server checks it against the caller's live
 *  primary. */
export const secureLinkApproveSchema = z.object({
  linkToken: linkTokenSchema,
  linkSignature: e2eeSignatureSchema
});

export const secureChatIdSchema = z.object({ chatId: chatIdSchema });

export const secureCreateChatSchema = z
  .object({
    kind: z.enum(['DM', 'GROUP']),
    name: z.string().trim().min(1).max(100).optional(),
    /** The others; the caller is added as the chat's admin. */
    memberIds: z
      .array(userIdSchema)
      .min(1)
      .max(SECURE_LIMITS.maxMembers - 1)
  })
  .refine((v) => v.kind === 'GROUP' || v.memberIds.length === 1, {
    message: 'A DM is between two people.'
  });

export const secureAddMembersSchema = z.object({
  chatId: chatIdSchema,
  userIds: z
    .array(userIdSchema)
    .min(1)
    .max(SECURE_LIMITS.maxMembers - 1)
});

export const secureRemoveMemberSchema = z.object({
  chatId: chatIdSchema,
  userId: userIdSchema
});

export const secureRenameChatSchema = z.object({
  chatId: chatIdSchema,
  name: z.string().trim().min(1).max(100)
});

const envelopeSchema = z.object({
  deviceId: e2eeDeviceIdSchema,
  type: z.union([z.literal(0), z.literal(1)]),
  body: b64Schema(SECURE_LIMITS.maxEnvelopeBytes)
}) satisfies z.ZodType<SecureEnvelopeInput>;

export const secureSendSchema = z.object({
  senderDeviceId: e2eeDeviceIdSchema,
  chatId: chatIdSchema.optional(),
  envelopes: z
    .array(envelopeSchema)
    .min(1)
    .max(SECURE_LIMITS.maxEnvelopesPerSend),
  notify: z.boolean()
}) satisfies z.ZodType<SecureSendInput>;

export const secureFetchSchema = z.object({
  deviceId: e2eeDeviceIdSchema,
  /** Rows after this id (the last one of the previous page). */
  cursor: z.number().int().min(0).optional()
});

// The history backup (.specs/secure-chat.md → History). Opaque base64.

/** One sealed backup item (a chunk of a chat's messages), base64. */
const SECURE_BACKUP_ITEM_MAX = 512 * 1024;

export const secureBackupCreateSchema = z.object({
  salt: b64Schema(64),
  wrappedKey: b64Schema(256),
  /** Start over (a forgotten passphrase): the old items are dropped. */
  replace: z.boolean().optional()
});

export const secureBackupUploadSchema = z.object({
  version: z.number().int().positive(),
  items: z
    .array(
      z.object({
        /** The device's own name for the item; the same one replaces it. */
        itemId: z
          .string()
          .min(1)
          .max(128)
          .regex(/^[A-Za-z0-9:_-]+$/),
        data: b64Schema(SECURE_BACKUP_ITEM_MAX)
      })
    )
    .min(1)
    .max(20)
});

export const secureBackupFetchSchema = z.object({
  version: z.number().int().positive(),
  cursor: z.number().int().min(0).optional()
});
