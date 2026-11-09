import { z } from 'zod';

// The socket inputs of audio rooms (.specs/audio-rooms.md → Events). Ids come
// off the wire, so each is bounded before it reaches a query.

const roomIdSchema = z.string().uuid();
const conversationIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const socketIdSchema = z.string().min(1).max(64);

// An SDP is a few KB; 64 KB leaves room for many candidates without letting a
// relay become a bulk channel.
const SDP_MAX = 65_536;
const CANDIDATE_MAX = 2_048;

export const audioRoomConversationSchema = z.object({
  conversationId: conversationIdSchema
});

export const audioRoomIdSchema = z.object({ roomId: roomIdSchema });

export const audioRoomHandSchema = z.object({
  roomId: roomIdSchema,
  raised: z.boolean()
});

export const audioRoomMuteSchema = z.object({
  roomId: roomIdSchema,
  muted: z.boolean()
});

export const audioRoomSetRoleSchema = z.object({
  roomId: roomIdSchema,
  userId: z.number().int().positive(),
  role: z.enum(['SPEAKER', 'LISTENER'])
});

export const audioRoomRemoveSchema = z.object({
  roomId: roomIdSchema,
  userId: z.number().int().positive()
});

export const audioRoomSignalSchema = z.object({
  roomId: roomIdSchema,
  toSocketId: socketIdSchema,
  signal: z.discriminatedUnion('type', [
    z.object({
      type: z.enum(['offer', 'answer']),
      sdp: z.string().max(SDP_MAX)
    }),
    z.object({
      type: z.literal('candidate'),
      candidate: z.object({
        candidate: z.string().max(CANDIDATE_MAX),
        sdpMid: z.string().max(64).nullish(),
        sdpMLineIndex: z.number().int().min(0).max(64).nullish()
      })
    })
  ])
});
