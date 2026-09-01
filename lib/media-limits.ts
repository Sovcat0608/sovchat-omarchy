export const ROOM_USER_LIMIT = 10;
export const LIVE_VOICE_USER_LIMIT = 8;
export const HARD_IDLE_DISCONNECT_MINUTES = 240;
export const DEFAULT_DAILY_STREAM_LIMIT_MINUTES = 15;
export const MAX_DAILY_STREAM_LIMIT_MINUTES = 1440;

export function getUtcDateKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

export function sanitizeDailyStreamLimitMinutes(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_DAILY_STREAM_LIMIT_MINUTES;
  }

  return Math.max(0, Math.min(MAX_DAILY_STREAM_LIMIT_MINUTES, Math.round(value)));
}
