export type ChannelKey = "chat" | "voice";
export type SessionAppVariant = "omarchy";

export type AppSession = {
  sessionId: string;
  userId: string;
  email: string;
  nickname: string;
  appVariant: SessionAppVariant;
  avatarId: string;
  avatarDataUrl: string | null;
  emailVerifiedAt: string;
  expiresAt: string;
};

export type SessionResponse = {
  session: AppSession;
  sessionToken?: string;
};

export type ChatMessage = {
  id: string;
  userId: string;
  nickname: string;
  avatarSrc?: string | null;
  body: string;
  whisper: {
    recipientIds: string[];
    recipients: WhisperTarget[];
  } | null;
  replyTo: {
    id: string;
    nickname: string;
    body: string;
  } | null;
  attachments: ChatAttachment[];
  reactions: ChatReaction[];
  createdAt: string;
  updatedAt: string;
};

export type WhisperTarget = {
  userId: string;
  nickname: string;
  requestId?: number;
};

export type ChatAttachment = {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  url: string;
  dataUrl?: string;
  kind: "image" | "video" | "file";
};

export type ChatReaction = {
  emoji: string;
  count: number;
  reactedByMe: boolean;
  nicknames: string[];
};

export type RoomSummary = {
  id: string;
  name: string;
  code: string;
  avatarDataUrl: string | null;
  fillerMode: boolean;
  dailyStreamLimitMinutes: number;
  isOwned: boolean;
  joinedAt: string;
  lastVisitedAt: string;
};

export type RoomMemberSummary = {
  userId: string;
  nickname: string;
  avatarId: string;
  avatarDataUrl: string | null;
  joinedAt: string;
  lastVisitedAt: string;
  isOwner: boolean;
};

export type RoomBanSummary = {
  userId: string;
  nickname: string;
  avatarId: string;
  avatarDataUrl: string | null;
  bannedAt: string;
};

export type RoomStateResponse = {
  currentRoom: RoomSummary | null;
  ownedRoom: RoomSummary | null;
  joinedRooms: RoomSummary[];
  currentRoomMembers: RoomMemberSummary[];
  ownedRoomMembers: RoomMemberSummary[];
  ownedRoomBans: RoomBanSummary[];
  needsRoomSetup: boolean;
};

export type LiveKitUsageDay = {
  dateKey: string;
  webRtcMinutes: number;
  streamMinutes: number;
  streamGb: number;
};

export type LiveKitUsageSummary = {
  month: string;
  roomName: string | null;
  hasOwnedRoom: boolean;
  daysInMonth: number;
  totalWebRtcMinutes: number;
  averageWebRtcMinutesPerDay: number;
  totalStreamMinutes: number;
  averageStreamMinutesPerDay: number;
  totalStreamGb: number;
  averageStreamGbPerDay: number;
  days: LiveKitUsageDay[];
};

export type LiveKitTokenResponse = {
  token: string;
  roomName: string;
  identity: string;
  serverUrl?: string;
};

export type PresenceResponse = {
  nicknames: string[];
  profiles: Array<{
    userId: string;
    nickname: string;
    avatarSrc?: string | null;
  }>;
};

export type VoicePresenceParticipant = {
  participantId: string;
  userId: string | null;
  displayName: string;
  isStreaming: boolean;
  isSelfMuted: boolean;
  isSelfDeafened: boolean;
  isAfk: boolean;
  avatarSrc?: string | null;
};

export type ProfileResponse = {
  nickname: string;
  avatarId: string;
  avatarDataUrl: string | null;
};

export type VoicePresenceResponse = {
  participants: VoicePresenceParticipant[];
};
