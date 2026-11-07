import { z } from 'zod';

// One embed request to the runner Vault's embedder (vault/embedder.ts): one
// of text, clipText, clipImage.

/** `clipImage` is base64. The route's own body limit bounds its size. */
const embedRequestSchema = z.object({
  text: z.string().optional(),
  clipText: z.string().optional(),
  clipImage: z.string().optional()
});

export type EmbedRequest = z.infer<typeof embedRequestSchema>;
