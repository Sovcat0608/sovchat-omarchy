import type { ChannelKey } from "@/types";

export const APP_NAME = "SovChat";
export const SESSION_COOKIE_NAME = "sovchat_session";
export const SESSION_TTL_MS = 1000 * 60 * 60 * 24;
export const REMEMBER_ME_SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30;
export const EMAIL_VERIFICATION_TTL_MS = 1000 * 60 * 60 * 24;
export const MAX_MESSAGES = 250;
export const GOOGLE_OAUTH_STATE_COOKIE_NAME = "sovchat_google_oauth_state";
export const MAX_MESSAGE_ATTACHMENTS = 6;
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
export const MAX_TOTAL_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_MESSAGE_REQUEST_BYTES = MAX_TOTAL_ATTACHMENT_BYTES + 1024 * 1024;

export const CHANNELS: Array<{
  key: ChannelKey;
  label: string;
  description: string;
}> = [
  {
    key: "voice",
    label: "Voice Channel",
    description: "Hop in for voice chat and screen sharing."
  },
  {
    key: "chat",
    label: "General Chat",
    description: "The main text channel for the group."
  }
];
