import { z } from 'zod';

import { E2EE_ENVELOPE_MAX, E2EE_LIMITS } from '../domains/e2ee';

// Inputs of the e2ee router (.specs/chat-e2ee.md). Keys are unpadded base64
// as vodozemac writes them.

const b64 = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/, { message: 'Expected base64' });

// Curve25519 and Ed25519 public keys are 32 bytes (43 chars); signatures 64.
const publicKeySchema = b64(64);
const signatureSchema = b64(128);
const deviceIdSchema = z.number().int().positive();

const signedKeySchema = z.object({
  keyId: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9+/=_-]+$/),
  publicKey: publicKeySchema,
  signature: signatureSchema
});

export const e2eeRegisterDeviceSchema = z.object({
  curve25519: publicKeySchema,
  ed25519: publicKeySchema,
  signature: signatureSchema
});

export const e2eeUploadKeysSchema = z.object({
  deviceId: deviceIdSchema,
  oneTimeKeys: z.array(signedKeySchema).max(E2EE_LIMITS.maxOneTimeKeys),
  fallbackKey: signedKeySchema.optional()
});

export const e2eeDeviceSchema = z.object({ deviceId: deviceIdSchema });

export const e2eeDevicesSchema = z.object({
  userIds: z.array(z.number().int().positive()).min(1).max(20)
});

export const e2eeClaimKeysSchema = z.object({
  deviceIds: z.array(deviceIdSchema).min(1).max(50)
});

export const e2eeSendToDeviceSchema = z.object({
  senderDeviceId: deviceIdSchema,
  messages: z
    .array(
      z.object({
        deviceId: deviceIdSchema,
        messageType: z.union([z.literal(0), z.literal(1)]),
        ciphertext: b64(E2EE_ENVELOPE_MAX)
      })
    )
    .min(1)
    .max(E2EE_LIMITS.maxToDevicePerSend)
});

export const e2eeAckToDeviceSchema = z.object({
  deviceId: deviceIdSchema,
  ids: z.array(z.number().int().positive()).min(1).max(500)
});
