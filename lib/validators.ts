import { z } from "zod";
import { MAX_DAILY_STREAM_LIMIT_MINUTES } from "@/lib/media-limits";

export const nicknameSchema = z
  .string()
  .trim()
  .min(2, "Nickname must be at least 2 characters.")
  .max(20, "Nickname must be 20 characters or fewer.")
  .regex(/^[A-Za-z0-9_ ]+$/, "Nickname may only contain letters, numbers, spaces, and underscores.");

export const avatarIdSchema = z
  .string()
  .trim()
  .regex(/^avatar-\d+$/, "Invalid avatar.");

export const avatarDataUrlSchema = z
  .string()
  .trim()
  .max(600_000, "Avatar image is too large.")
  .refine((value) => value.startsWith("data:image/"), "Invalid avatar image.");

export const roomAvatarDataUrlSchema = z
  .string()
  .trim()
  .max(900_000, "Room image is too large.")
  .refine((value) => value.startsWith("data:image/"), "Invalid room image.");

export const profileUpdateSchema = z
  .object({
    nickname: nicknameSchema.optional(),
    avatarId: avatarIdSchema.optional(),
    avatarDataUrl: avatarDataUrlSchema.nullable().optional()
  })
  .refine(
    (value) =>
      value.nickname !== undefined ||
      value.avatarId !== undefined ||
      value.avatarDataUrl !== undefined,
    "No profile updates provided."
  );

export const emailSchema = z
  .string()
  .trim()
  .email("Enter a valid email address.")
  .transform((value) => value.toLowerCase());

export const passwordSchema = z
  .string()
  .min(8, "Password must be at least 8 characters.")
  .max(72, "Password must be 72 characters or fewer.");

export const loginSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  rememberMe: z.boolean().optional().default(false),
  disconnectOtherSessions: z.boolean().optional().default(false)
});

export const signupSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  nickname: nicknameSchema,
  betaAccessCode: z
    .string()
    .trim()
    .min(6, "Enter your beta access code.")
    .max(80, "Beta access code is too long.")
});

export const betaAccessRequestSchema = z.object({
  name: z.string().trim().min(2, "Enter your name.").max(80, "Name is too long."),
  email: emailSchema,
  message: z.string().trim().max(1_000, "Message is too long.").optional().default(""),
  website: z.string().max(200).optional().default(""),
  startedAt: z.number().int().positive(),
  turnstileToken: z.string().trim().min(1, "Complete the security check.").max(2_048)
});

export const resendVerificationSchema = z.object({
  email: emailSchema
});

export const messageSchema = z.object({
  body: z
    .string()
    .trim()
    .max(4_000, "Message is too long."),
  replyToMessageId: z.string().trim().min(1).max(191).nullable().optional(),
  whisperRecipientIds: z
    .array(z.string().trim().min(1).max(191))
    .max(32, "Choose fewer whisper recipients.")
    .optional()
    .default([])
});

export const messageReactionSchema = z.object({
  messageId: z.string().trim().min(1, "Choose a message first."),
  emoji: z
    .string()
    .trim()
    .min(1, "Choose a reaction.")
    .max(16, "Reaction is too long.")
});

export const roomNameSchema = z
  .string()
  .trim()
  .min(2, "Room name must be at least 2 characters.")
  .max(32, "Room name must be 32 characters or fewer.");

export const roomCodeSchema = z
  .string()
  .trim()
  .transform((value) => value.toUpperCase().replace(/[^A-Z0-9]/g, ""))
  .pipe(
    z
      .string()
      .min(6, "Room code must be at least 6 characters.")
      .max(12, "Room code must be 12 characters or fewer.")
      .regex(/^[A-Z0-9]+$/, "Room code may only contain letters and numbers.")
  );

export const roomActionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("create"),
    name: roomNameSchema,
    code: roomCodeSchema
  }),
  z.object({
    action: z.literal("join"),
    code: roomCodeSchema
  }),
  z.object({
    action: z.literal("switch"),
    roomId: z.string().trim().min(1, "Choose a room first.")
  }),
  z.object({
    action: z.literal("reset-owned-code")
  }),
  z.object({
    action: z.literal("reset-owned-stream-usage")
  }),
  z.object({
    action: z.literal("update-owned"),
    name: roomNameSchema,
    fillerMode: z.boolean(),
    dailyStreamLimitMinutes: z
      .number()
      .int()
      .min(0, "Use 0 to disable the stream limit.")
      .max(MAX_DAILY_STREAM_LIMIT_MINUTES, "Stream limit must be 1440 minutes or fewer.")
      .optional(),
    avatarDataUrl: roomAvatarDataUrlSchema.nullable().optional()
  }),
  z.object({
    action: z.literal("remove-owned-member"),
    userId: z.string().trim().min(1, "Choose a member first.")
  }),
  z.object({
    action: z.literal("ban-owned-member"),
    userId: z.string().trim().min(1, "Choose a member first.")
  }),
  z.object({
    action: z.literal("unban-owned-member"),
    userId: z.string().trim().min(1, "Choose a banned user first.")
  })
]);
