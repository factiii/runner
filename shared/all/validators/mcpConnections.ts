import { z } from 'zod';

// Connecting an outside AI assistant (Grok, ChatGPT, Claude, ...) to /mcp over
// OAuth. The approve page (web /oauth/authorize) reads the request from its
// query string; the server checks client and return address again on approve.

const clientIdSchema = z.string().min(1).max(100);
const redirectUriSchema = z.string().url().max(2000);

export const mcpAuthorizeInfoSchema = z.object({
  clientId: clientIdSchema,
  redirectUri: redirectUriSchema
});

export const mcpApproveSchema = z.object({
  clientId: clientIdSchema,
  redirectUri: redirectUriSchema,
  // S256 of a 43-128 character verifier: 43 base64url characters.
  codeChallenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  runnerId: z.number().int().positive()
});

export const mcpRevokeSchema = z.object({
  id: z.number().int().positive()
});

export type McpApproveInput = z.infer<typeof mcpApproveSchema>;

// Approving from the phone (server helpers/mcpPhoneApproval.ts).
const phoneApprovalIdSchema = z.string().uuid();
// Minted by the approve page and kept there: only it can collect the code.
const phoneNonceSchema = z.string().min(32).max(128);

export const mcpPhoneRequestSchema = z.object({
  username: z.string().trim().min(1).max(320),
  clientId: clientIdSchema,
  redirectUri: redirectUriSchema,
  codeChallenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  nonce: phoneNonceSchema
});

export const mcpPhoneStatusSchema = z.object({
  id: phoneApprovalIdSchema,
  nonce: phoneNonceSchema
});

export const mcpPhoneIdSchema = z.object({ id: phoneApprovalIdSchema });

export const mcpPhoneAnswerSchema = z.object({
  id: phoneApprovalIdSchema,
  number: z.string().regex(/^\d{2}$/),
  runnerId: z.number().int().positive()
});
