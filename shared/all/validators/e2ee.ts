import { z } from 'zod';

import { SECURE_LIMITS } from '../domains/secureChat';

// The key directory's inputs, shared by the secure router
// (validators/secureChat.ts, .specs/secure-chat.md). Keys are unpadded base64
// as vodozemac writes them.

export const b64Schema = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/, { message: 'Expected base64' });

// Curve25519 and Ed25519 public keys are 32 bytes (43 chars); signatures 64.
export const e2eePublicKeySchema = b64Schema(64);
export const e2eeSignatureSchema = b64Schema(128);
export const e2eeDeviceIdSchema = z.number().int().positive();

const signedKeySchema = z.object({
  keyId: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9+/=_-]+$/),
  publicKey: e2eePublicKeySchema,
  signature: e2eeSignatureSchema
});

/** A device's own keys, self-signed (e2eeDeviceSigningText). */
export const e2eeDeviceKeysSchema = z.object({
  curve25519: e2eePublicKeySchema,
  ed25519: e2eePublicKeySchema,
  signature: e2eeSignatureSchema
});

export const e2eeUploadKeysSchema = z.object({
  deviceId: e2eeDeviceIdSchema,
  oneTimeKeys: z.array(signedKeySchema).max(SECURE_LIMITS.maxOneTimeKeys),
  fallbackKey: signedKeySchema.optional()
});

export const e2eeDeviceSchema = z.object({ deviceId: e2eeDeviceIdSchema });

export const e2eeDevicesSchema = z.object({
  userIds: z.array(z.number().int().positive()).min(1).max(50)
});

export const e2eeClaimKeysSchema = z.object({
  deviceIds: z.array(e2eeDeviceIdSchema).min(1).max(400)
});

export const e2eeAckToDeviceSchema = z.object({
  deviceId: e2eeDeviceIdSchema,
  ids: z.array(z.number().int().positive()).min(1).max(500)
});
