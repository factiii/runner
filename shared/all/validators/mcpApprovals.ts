import { z } from 'zod';

// A person's answer to an action their AI proposed through the MCP
// (.specs/mcp-approvals.md; server routers/mcpApprovals.ts).

/** The longest YOLO mode an approval may open: the secrets gate's 12h. */
export const MCP_APPROVAL_MAX_WINDOW_MINUTES = 720;
export const MCP_APPROVAL_LOG_PAGE = 30;

const approvalId = z.string().uuid();

export const mcpApprovalApproveSchema = z.object({
  id: approvalId,
  // Minutes of YOLO mode: every write from the same asker runs unasked until
  // then. 0 = this one action. Ignored on a destructive action, which always
  // asks.
  unlockFor: z
    .number()
    .int()
    .min(0)
    .max(MCP_APPROVAL_MAX_WINDOW_MINUTES)
    .default(0)
});

export const mcpApprovalDenySchema = z.object({
  id: approvalId,
  // Also every other proposal waiting from the same asker.
  all: z.boolean().optional()
});

export const mcpApprovalLogSchema = z.object({
  // The createdAt of the last row of the page before, as an ISO string.
  cursor: z.string().datetime().optional()
});

export const mcpApprovalEndWindowsSchema = z.object({
  // One assistant's YOLO mode; left out, every one this person has open.
  id: approvalId.optional()
});
