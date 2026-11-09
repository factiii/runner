import { z } from 'zod';

// A dangerous call an AI made, held for its owner (.specs/ai-actions.md
// "Dangerous routes"). The owner confirms by typing the phrase in
// DangerConfirm, or denies it.

export const aiConfirmationIdSchema = z.object({ id: z.string().uuid() });

export const aiConfirmationConfirmSchema = z.object({
  id: z.string().uuid(),
  // Compared exactly with the stored phrase: no trim, no case folding.
  phrase: z.string().min(1).max(500)
});

export type AiConfirmationConfirmInput = z.infer<
  typeof aiConfirmationConfirmSchema
>;
