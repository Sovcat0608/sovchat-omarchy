"use client";

import {
  FormEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from "react";
import {
  AtSign,
  ChevronDown,
  Check,
  CornerUpLeft,
  Copy,
  Download,
  ExternalLink,
  FileText,
  LoaderCircle,
  Maximize2,
  MessageSquareText,
  Minimize2,
  Move,
  Paperclip,
  RotateCcw,
  SendHorizontal,
  SmilePlus,
  Trash2,
  X,
  ZoomIn,
  ZoomOut
} from "lucide-react";
import { ChatMarkdown, extractMessageUrls } from "@/components/chat-markdown";
import { PrimaryPanelShell } from "@/components/primary-panel-shell";
import { apiFetch, createApiAssetUrl, createApiEventSource } from "@/lib/api-client";
import { getPerformanceNow, recordPerformanceTiming } from "@/lib/performance-diagnostics";
import { formatTimestamp } from "@/lib/utils";
import { cn } from "@/lib/utils";
import type {
  ChatAttachment,
  ChatMessage,
  PresenceResponse,
  RoomMemberSummary,
  RoomSummary,
  WhisperTarget
} from "@/types";

type ChatViewProps = {
  isOpen: boolean;
  onClose: () => void;
  currentUserId: string;
  nickname: string;
  currentRoom: RoomSummary | null;
  roomMembers?: RoomMemberSummary[];
  initialWhisperTarget?: WhisperTarget | null;
  variant?: "panel" | "stage";
  compact?: boolean;
};

type PresenceProfile = PresenceResponse["profiles"][number];
type WhisperCandidate = {
  userId: string;
  nickname: string;
  avatarSrc: string | null;
  isOnline: boolean;
};

type MessageEvent =
  | {
      type: "message-created" | "message-updated";
      message: ChatMessage;
    }
  | {
      type: "message-deleted";
      messageId: string;
    };

type MessagesPayload = {
  messages?: ChatMessage[];
  avatars?: Record<string, string>;
};

type DraftAttachment = {
  id: string;
  file: File;
  previewUrl: string;
};

type PreviewImage = {
  src: string;
  fetchSrc?: string;
  fileName: string;
  mimeType?: string;
  sizeBytes?: number;
};

type PreviewAttachment = {
  id: string;
  src: string;
  fetchSrc: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  kind: ChatAttachment["kind"];
};

type LinkPreview = {
  url: string;
  title: string;
  description: string;
  siteName: string;
  image: string;
  contentType: string;
};

type ReplyTarget = {
  id: string;
  nickname: string;
  body: string;
};

const LINK_PREVIEW_CACHE_LIMIT = 80;
const CHAT_BOTTOM_STICKINESS_PX = 12;
const MESSAGE_CACHE_MAX_ROOMS = 4;
const MESSAGE_CACHE_MAX_BYTES = 2 * 1024 * 1024;
const linkPreviewCache = new Map<string, LinkPreview | null>();
const linkPreviewRequests = new Map<string, Promise<LinkPreview | null>>();
const messageCache = new Map<string, ChatMessage[]>();
const messageAvatarCache = new Map<string, Map<string, string>>();
let cachedPresenceProfiles: PresenceProfile[] | null = null;

const REACTION_PRESETS = [
  "\u{1F44D}",
  "\u2764\uFE0F",
  "\u{1F602}",
  "\u{1F525}",
  "\u{1F389}",
  "\u{1F440}",
  "\u2705",
  "\u{1F44F}"
] as const;

function upsertMessage(previous: ChatMessage[], next: ChatMessage) {
  const index = previous.findIndex((message) => message.id === next.id);

  if (index === -1) {
    return [...previous, next].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  return previous.map((message) => (message.id === next.id ? next : message));
}

function removeMessage(previous: ChatMessage[], messageId: string) {
  return previous
    .filter((message) => message.id !== messageId)
    .map((message) =>
      message.replyTo?.id === messageId
        ? {
            ...message,
            replyTo: null
          }
        : message
    );
}

function estimateStringBytes(value: string | null | undefined) {
  return value ? value.length * 2 : 0;
}

function estimateAttachmentCacheBytes(attachment: ChatAttachment) {
  return (
    estimateStringBytes(attachment.id) +
    estimateStringBytes(attachment.fileName) +
    estimateStringBytes(attachment.mimeType) +
    estimateStringBytes(attachment.url) +
    estimateStringBytes(attachment.dataUrl)
  );
}

function estimateMessageCacheBytes(message: ChatMessage) {
  return (
    estimateStringBytes(message.id) +
    estimateStringBytes(message.userId) +
    estimateStringBytes(message.nickname) +
    estimateStringBytes(message.avatarSrc) +
    estimateStringBytes(message.body) +
    estimateStringBytes(message.whisper?.recipientIds.join(",")) +
    (message.whisper?.recipients.reduce(
      (total, recipient) =>
        total + estimateStringBytes(recipient.userId) + estimateStringBytes(recipient.nickname),
      0
    ) ?? 0) +
    estimateStringBytes(message.replyTo?.id) +
    estimateStringBytes(message.replyTo?.nickname) +
    estimateStringBytes(message.replyTo?.body) +
    message.attachments.reduce((total, attachment) => total + estimateAttachmentCacheBytes(attachment), 0) +
    message.reactions.reduce(
      (total, reaction) =>
        total +
        estimateStringBytes(reaction.emoji) +
        reaction.nicknames.reduce((innerTotal, nickname) => innerTotal + estimateStringBytes(nickname), 0),
      0
    )
  );
}

function estimateAvatarCacheBytes(avatars: Map<string, string> | undefined) {
  if (!avatars) {
    return 0;
  }

  let total = 0;
  for (const [userId, avatarSrc] of avatars.entries()) {
    total += estimateStringBytes(userId) + estimateStringBytes(avatarSrc);
  }
  return total;
}

function estimateMessageCacheTotalBytes() {
  let total = 0;
  for (const [roomId, messages] of messageCache.entries()) {
    total += estimateStringBytes(roomId);
    total += messages.reduce((innerTotal, message) => innerTotal + estimateMessageCacheBytes(message), 0);
    total += estimateAvatarCacheBytes(messageAvatarCache.get(roomId));
  }
  return total;
}

function pruneMessageCache() {
  while (
    messageCache.size > MESSAGE_CACHE_MAX_ROOMS ||
    estimateMessageCacheTotalBytes() > MESSAGE_CACHE_MAX_BYTES
  ) {
    const oldestRoomId = messageCache.keys().next().value;
    if (!oldestRoomId) {
      break;
    }

    messageCache.delete(oldestRoomId);
    messageAvatarCache.delete(oldestRoomId);
  }
}

function getCachedRoomMessages(roomId: string) {
  const messages = messageCache.get(roomId);
  if (!messages) {
    return null;
  }

  const avatars = messageAvatarCache.get(roomId);
  messageCache.delete(roomId);
  messageCache.set(roomId, messages);

  if (avatars) {
    messageAvatarCache.delete(roomId);
    messageAvatarCache.set(roomId, avatars);
  }

  return { messages, avatars };
}

function setCachedRoomMessages(
  roomId: string,
  messages: ChatMessage[],
  avatars = messageAvatarCache.get(roomId) ?? new Map<string, string>()
) {
  messageCache.delete(roomId);
  messageAvatarCache.delete(roomId);
  messageCache.set(roomId, messages);
  messageAvatarCache.set(roomId, avatars);
  pruneMessageCache();
}

function setCachedRoomAvatars(roomId: string, avatars: Map<string, string>) {
  const messages = messageCache.get(roomId);
  if (messages) {
    setCachedRoomMessages(roomId, messages, avatars);
    return;
  }

  messageAvatarCache.delete(roomId);
  messageAvatarCache.set(roomId, avatars);
  pruneMessageCache();
}

function formatFileSize(sizeBytes: number) {
  if (sizeBytes < 1024) {
    return `${sizeBytes} B`;
  }

  if (sizeBytes < 1024 * 1024) {
    return `${(sizeBytes / 1024).toFixed(1)} KB`;
  }

  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}

function initialsFor(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

function avatarSrcForRoomMember(member: RoomMemberSummary) {
  return member.avatarDataUrl ?? `/avatars/${member.avatarId}.png`;
}

const IMAGE_ZOOM_MIN = 1;
const IMAGE_ZOOM_MAX = 4;
const IMAGE_ZOOM_STEP = 0.25;
const IMAGE_PAN_KEYBOARD_STEP = 44;
const IMAGE_PAN_LIMIT = 2400;

function clampNumber(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function clampImageZoom(value: number) {
  return clampNumber(Number.isFinite(value) ? value : 1, IMAGE_ZOOM_MIN, IMAGE_ZOOM_MAX);
}

function clampImagePanValue(value: number) {
  return clampNumber(Number.isFinite(value) ? value : 0, -IMAGE_PAN_LIMIT, IMAGE_PAN_LIMIT);
}

function isPdfAttachment(attachment: Pick<PreviewAttachment, "fileName" | "mimeType">) {
  return (
    attachment.mimeType.toLowerCase().includes("pdf") ||
    attachment.fileName.trim().toLowerCase().endsWith(".pdf")
  );
}

async function loadAttachmentBlob(source: string) {
  const response = source.startsWith("/api/")
    ? await apiFetch(source, { cache: "no-store" })
    : await fetch(source, { cache: "no-store", credentials: "include" });

  if (!response.ok) {
    throw new Error(`Unable to load attachment. Server returned ${response.status}.`);
  }

  return await response.blob();
}

async function loadImageBlob(image: PreviewImage) {
  const blob = await loadAttachmentBlob(image.fetchSrc ?? image.src);
  if (!blob.type.startsWith("image/")) {
    throw new Error("This attachment is not an image.");
  }

  return blob;
}

function downloadBlob(blob: Blob, fileName: string) {
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = fileName.trim() || "image";
  anchor.rel = "noopener";
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}

function openUrlInNewTab(url: string) {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.target = "_blank";
  anchor.rel = "noopener noreferrer";
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

async function convertImageBlobToPng(blob: Blob) {
  if (blob.type === "image/png") {
    return blob;
  }

  const objectUrl = URL.createObjectURL(blob);

  try {
    const image = new Image();
    image.decoding = "async";
    const loadPromise = new Promise<HTMLImageElement>((resolve, reject) => {
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("Unable to prepare image for clipboard."));
    });
    image.src = objectUrl;
    await loadPromise;

    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth || image.width;
    canvas.height = image.naturalHeight || image.height;
    const context = canvas.getContext("2d");

    if (!context || canvas.width === 0 || canvas.height === 0) {
      throw new Error("Unable to prepare image for clipboard.");
    }

    context.drawImage(image, 0, 0);

    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((pngBlob) => {
        if (pngBlob) {
          resolve(pngBlob);
          return;
        }

        reject(new Error("Unable to prepare image for clipboard."));
      }, "image/png");
    });
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

async function copyImageBlobToClipboard(blob: Blob) {
  if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
    throw new Error("Image clipboard is not available in this browser.");
  }

  const pngBlob = await convertImageBlobToPng(blob);
  await navigator.clipboard.write([
    new ClipboardItem({
      [pngBlob.type || "image/png"]: pngBlob
    })
  ]);
}

function getAttachmentKind(file: File): ChatAttachment["kind"] {
  if (file.type.startsWith("image/")) {
    return "image";
  }

  if (file.type.startsWith("video/")) {
    return "video";
  }

  return "file";
}

function cacheLinkPreview(url: string, preview: LinkPreview | null) {
  if (linkPreviewCache.has(url)) {
    linkPreviewCache.delete(url);
  }

  while (linkPreviewCache.size >= LINK_PREVIEW_CACHE_LIMIT) {
    const oldestUrl = linkPreviewCache.keys().next().value;
    if (!oldestUrl) {
      break;
    }

    linkPreviewCache.delete(oldestUrl);
  }

  linkPreviewCache.set(url, preview);
}

function loadLinkPreview(url: string) {
  if (linkPreviewCache.has(url)) {
    return Promise.resolve(linkPreviewCache.get(url) ?? null);
  }

  const existingRequest = linkPreviewRequests.get(url);
  if (existingRequest) {
    return existingRequest;
  }

  const request = apiFetch(`/api/link-preview?url=${encodeURIComponent(url)}`, { cache: "no-store" })
    .then((response) => (response.ok ? response.json() : null))
    .then((payload) => {
      const preview = payload ? (payload as LinkPreview) : null;
      cacheLinkPreview(url, preview);
      return preview;
    })
    .catch(() => {
      cacheLinkPreview(url, null);
      return null;
    })
    .finally(() => {
      linkPreviewRequests.delete(url);
    });

  linkPreviewRequests.set(url, request);
  return request;
}

function useLinkPreview(url: string) {
  const [preview, setPreview] = useState<LinkPreview | null>(null);

  useEffect(() => {
    let active = true;

    if (linkPreviewCache.has(url)) {
      setPreview(linkPreviewCache.get(url) ?? null);
      return () => {
        active = false;
      };
    }

    setPreview(null);

    void loadLinkPreview(url)
      .then((payload) => {
        if (!active || !payload) {
          return;
        }

        setPreview(payload);
      });

    return () => {
      active = false;
    };
  }, [url]);

  return preview;
}

function LinkPreviewCard({ url }: { url: string }) {
  const preview = useLinkPreview(url);
  const [imageVisible, setImageVisible] = useState(true);

  let youtubeFallback:
    | {
        url: string;
        title: string;
        description: string;
        siteName: string;
        image: string;
      }
    | null = null;

  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.replace(/^www\./, "");
    let videoId = "";

    if (hostname === "youtu.be") {
      videoId = parsed.pathname.split("/").filter(Boolean)[0] ?? "";
    } else if (hostname === "youtube.com" || hostname === "m.youtube.com") {
      if (parsed.pathname === "/watch") {
        videoId = parsed.searchParams.get("v")?.trim() ?? "";
      } else if (parsed.pathname.startsWith("/shorts/") || parsed.pathname.startsWith("/embed/")) {
        videoId = parsed.pathname.split("/").filter(Boolean)[1] ?? "";
      }
    }

    if (videoId) {
      youtubeFallback = {
        url,
        title: "YouTube video",
        description: "Watch on YouTube",
        siteName: "YouTube",
        image: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`
      };
    }
  } catch {}

  const resolvedPreview = useMemo(() => {
    if (!preview) {
      return youtubeFallback;
    }

    const previewLooksGeneric =
      !preview.image &&
      (!preview.description || preview.description === "text/html") &&
      preview.title.trim().toLowerCase() === preview.siteName.trim().toLowerCase();

    const previewIsWeakYouTubeCard =
      youtubeFallback &&
      (preview.siteName.trim().toLowerCase().includes("youtube") ||
        preview.url.includes("youtube.com") ||
        preview.url.includes("youtu.be")) &&
      (previewLooksGeneric || preview.title.trim().toLowerCase() === "www.youtube.com");

    if (previewIsWeakYouTubeCard && youtubeFallback) {
      return {
        url: preview.url,
        title: youtubeFallback.title,
        description: youtubeFallback.description,
        siteName: youtubeFallback.siteName,
        image: youtubeFallback.image,
        contentType: "text/html"
      };
    }

    return preview;
  }, [preview, youtubeFallback]);

  if (!resolvedPreview) {
    let hostname = url;
    try {
      hostname = new URL(url).hostname;
    } catch {}

    return (
      <a href={url} target="_blank" rel="noreferrer" className="chat-link-preview">
        {youtubeFallback?.image && imageVisible ? (
          <img
            src={youtubeFallback.image}
            alt=""
            className="chat-link-preview__image"
            onError={() => setImageVisible(false)}
          />
        ) : null}
        <div className="min-w-0 flex-1">
          <div className="chat-link-preview__site">{youtubeFallback?.siteName ?? hostname}</div>
          <div className="chat-link-preview__title">{youtubeFallback?.title ?? url}</div>
          {youtubeFallback?.description ? (
            <div className="chat-link-preview__description">{youtubeFallback.description}</div>
          ) : null}
        </div>
      </a>
    );
  }

  return (
    <a href={resolvedPreview.url} target="_blank" rel="noreferrer" className="chat-link-preview">
      {resolvedPreview.image && imageVisible ? (
        <img
          src={resolvedPreview.image}
          alt=""
          className="chat-link-preview__image"
          onError={() => setImageVisible(false)}
        />
      ) : null}
      <div className="min-w-0 flex-1">
        <div className="chat-link-preview__site">{resolvedPreview.siteName}</div>
        <div className="chat-link-preview__title">{resolvedPreview.title}</div>
        {resolvedPreview.description ? (
          <div className="chat-link-preview__description">{resolvedPreview.description}</div>
        ) : null}
      </div>
    </a>
  );
}

function AttachmentStack({
  attachments,
  onOpenImage,
  onOpenAttachment
}: {
  attachments: ChatAttachment[];
  onOpenImage: (image: PreviewImage) => void;
  onOpenAttachment: (attachment: PreviewAttachment) => void;
}) {
  if (attachments.length === 0) {
    return null;
  }

  async function handleDownloadAttachment(attachment: PreviewAttachment) {
    try {
      const blob = await loadAttachmentBlob(attachment.fetchSrc);
      downloadBlob(blob, attachment.fileName);
    } catch (error) {
      console.error("Attachment download failed; opening attachment instead.", error);
      openUrlInNewTab(attachment.src);
    }
  }

  return (
    <div className="chat-attachment-stack">
      {attachments.map((attachment) => {
        const attachmentUrl = attachment.dataUrl ?? createApiAssetUrl(attachment.url);
        const attachmentFetchSrc = attachment.dataUrl ?? attachment.url;
        const previewAttachment: PreviewAttachment = {
          id: attachment.id,
          src: attachmentUrl,
          fetchSrc: attachmentFetchSrc,
          fileName: attachment.fileName,
          mimeType: attachment.mimeType,
          sizeBytes: attachment.sizeBytes,
          kind: attachment.kind
        };

        return (
          <div key={attachment.id} className="chat-attachment">
            {attachment.kind === "image" ? (
              <button
                type="button"
                onClick={() =>
                  onOpenImage({
                    src: attachmentUrl,
                    fetchSrc: attachmentFetchSrc,
                    fileName: attachment.fileName,
                    mimeType: attachment.mimeType,
                    sizeBytes: attachment.sizeBytes
                  })
                }
                className="chat-attachment__image-button"
                aria-label={`Open large preview for ${attachment.fileName}`}
              >
                <img
                  src={attachmentUrl}
                  alt={attachment.fileName}
                  className="chat-attachment__image"
                  loading="lazy"
                  decoding="async"
                />
              </button>
            ) : attachment.kind === "video" ? (
              <div className="chat-attachment__media-card">
                <video src={attachmentUrl} controls className="chat-attachment__video" preload="metadata" />
                <div className="chat-attachment__media-actions">
                  <button
                    type="button"
                    className="chat-attachment__action"
                    onClick={() => onOpenAttachment(previewAttachment)}
                  >
                    <Maximize2 className="h-3.5 w-3.5" />
                    <span>View</span>
                  </button>
                  <button
                    type="button"
                    className="chat-attachment__action"
                    onClick={() => void handleDownloadAttachment(previewAttachment)}
                  >
                    <Download className="h-3.5 w-3.5" />
                    <span>Download</span>
                  </button>
                </div>
              </div>
            ) : (
              <div className="chat-attachment__file-card">
                <button
                  type="button"
                  onClick={() => onOpenAttachment(previewAttachment)}
                  className="chat-attachment__file"
                  aria-label={`Open attachment preview for ${attachment.fileName}`}
                >
                  <span className="chat-attachment__file-icon">
                    {isPdfAttachment(previewAttachment) ? (
                      <FileText className="h-4 w-4" />
                    ) : (
                      <Paperclip className="h-4 w-4" />
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="chat-attachment__file-name">{attachment.fileName}</span>
                    <span className="chat-attachment__file-meta">
                      {isPdfAttachment(previewAttachment) ? "PDF" : attachment.mimeType || "File"} -{" "}
                      {formatFileSize(attachment.sizeBytes)}
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  className="chat-attachment__download"
                  onClick={() => void handleDownloadAttachment(previewAttachment)}
                  aria-label={`Download ${attachment.fileName}`}
                  title="Download"
                >
                  <Download className="h-4 w-4" />
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function MessageRow({
  message,
  currentUserId,
  myNickname,
  avatarSrc,
  isDeleting,
  onOpenImage,
  onOpenAttachment,
  onReply,
  onDelete,
  onToggleReaction
}: {
  message: ChatMessage;
  currentUserId: string;
  myNickname: string;
  avatarSrc?: string;
  isDeleting: boolean;
  onOpenImage: (image: PreviewImage) => void;
  onOpenAttachment: (attachment: PreviewAttachment) => void;
  onReply: (message: ReplyTarget) => void;
  onDelete: (messageId: string) => void;
  onToggleReaction: (messageId: string, emoji: string) => void;
}) {
  const urls = extractMessageUrls(message.body);
  const [reactionPickerOpen, setReactionPickerOpen] = useState(false);
  const isOwnMessage = message.userId === currentUserId;
  const whisperNames = message.whisper?.recipients.map((recipient) => recipient.nickname) ?? [];
  const whisperLabel = message.whisper
    ? isOwnMessage
      ? `Whisper to ${whisperNames.length ? whisperNames.join(", ") : "you"}`
      : whisperNames.some((name) => name === myNickname)
        ? "Whisper to you"
        : whisperNames.length
          ? `Whisper to ${whisperNames.join(", ")}`
          : "Whisper"
    : null;

  return (
    <article
      className={cn("chat-message-row", message.whisper && "chat-message-row-whisper")}
      onMouseLeave={() => setReactionPickerOpen(false)}
    >
      <div className="chat-message-row__avatar">
        {avatarSrc ? (
          <img src={avatarSrc} alt="" className="h-10 w-10 rounded-full object-contain" />
        ) : (
          <span>{initialsFor(message.nickname)}</span>
        )}
      </div>

      <div className="min-w-0 flex-1">
        <div className="chat-message-row__header">
          <div className="min-w-0 flex items-center gap-3">
            <span className="truncate text-[15px] font-semibold text-white">{message.nickname}</span>
            {message.nickname === myNickname ? (
              <span className="rounded-full bg-[rgba(255,202,42,0.14)] px-2 py-0.5 text-[10px] uppercase tracking-[0.18em] text-[var(--accent)]">
                You
              </span>
            ) : null}
            {whisperLabel ? (
              <span className="chat-whisper-badge">
                <MessageSquareText className="h-3 w-3" />
                <span>{whisperLabel}</span>
              </span>
            ) : null}
          </div>

          <div className="chat-message-row__meta">
            <div className="chat-message-row__header-actions">
              <button type="button" onClick={() => onReply(message)} className="chat-inline-icon" aria-label="Reply">
                <CornerUpLeft className="h-3.5 w-3.5" />
              </button>
              {isOwnMessage ? (
                <button
                  type="button"
                  onClick={() => onDelete(message.id)}
                  className="chat-inline-icon chat-inline-icon-danger"
                  aria-label="Delete message"
                  disabled={isDeleting}
                >
                  {isDeleting ? (
                    <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Trash2 className="h-3.5 w-3.5" />
                  )}
                </button>
              ) : null}
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setReactionPickerOpen((previous) => !previous)}
                  className="chat-inline-icon"
                  aria-label="Add reaction"
                >
                  <SmilePlus className="h-3.5 w-3.5" />
                </button>
                {reactionPickerOpen ? (
                  <div className="chat-reaction-popover">
                    {REACTION_PRESETS.map((emoji) => (
                      <button
                        key={emoji}
                        type="button"
                        onClick={() => {
                          onToggleReaction(message.id, emoji);
                          setReactionPickerOpen(false);
                        }}
                        className="chat-reaction-popover__item"
                      >
                        {emoji}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            </div>
            <span className="text-xs text-white/38">{formatTimestamp(message.createdAt)}</span>
          </div>
        </div>

        {message.replyTo ? (
          <button type="button" onClick={() => onReply(message.replyTo!)} className="chat-message-row__reply">
            <CornerUpLeft className="h-3.5 w-3.5" />
            <span className="truncate">
              Replying to <strong>{message.replyTo.nickname}</strong>: {message.replyTo.body}
            </span>
          </button>
        ) : null}

        {message.body ? <ChatMarkdown value={message.body} /> : null}
        <AttachmentStack
          attachments={message.attachments}
          onOpenImage={onOpenImage}
          onOpenAttachment={onOpenAttachment}
        />

        {urls.length > 0 ? (
          <div className="mt-3 space-y-2">
            {urls.map((url) => (
              <LinkPreviewCard key={url} url={url} />
            ))}
          </div>
        ) : null}

        {message.reactions.length > 0 ? (
          <div className="chat-message-row__reactions">
            {message.reactions.map((reaction) => (
              <button
                key={reaction.emoji}
                type="button"
                onClick={() => onToggleReaction(message.id, reaction.emoji)}
                className={cn("chat-reaction-chip", reaction.reactedByMe && "chat-reaction-chip-active")}
                title={reaction.nicknames.join(", ")}
              >
                <span>{reaction.emoji}</span>
                <span>{reaction.count}</span>
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </article>
  );
}

function ImageLightbox({ image, onClose }: { image: PreviewImage; onClose: () => void }) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const dragStateRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    panX: number;
    panY: number;
  } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isCopying, setIsCopying] = useState(false);
  const [copySucceeded, setCopySucceeded] = useState(false);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState(false);

  useEffect(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setIsPanning(false);
    setIsSaving(false);
    setIsCopying(false);
    setCopySucceeded(false);
    setActionMessage(null);
    setActionError(false);
  }, [image.src]);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  useEffect(() => {
    if (zoom <= 1) {
      setPan({ x: 0, y: 0 });
    }
  }, [zoom]);

  useEffect(() => {
    function handleFullscreenChange() {
      const surface = surfaceRef.current;
      const fullscreenElement = document.fullscreenElement;
      setIsFullscreen(Boolean(surface && fullscreenElement && fullscreenElement === surface));
    }

    document.addEventListener("fullscreenchange", handleFullscreenChange);
    handleFullscreenChange();

    return () => {
      document.removeEventListener("fullscreenchange", handleFullscreenChange);
    };
  }, []);

  useEffect(() => {
    return () => {
      if (surfaceRef.current && document.fullscreenElement === surfaceRef.current) {
        void document.exitFullscreen().catch(() => undefined);
      }
    };
  }, []);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        if (document.fullscreenElement) {
          void document.exitFullscreen().catch(() => undefined);
          return;
        }

        void handleClose();
        return;
      }

      if ((event.key === "+" || event.key === "=") && !event.metaKey && !event.ctrlKey) {
        event.preventDefault();
        setZoom((previous) => clampImageZoom(previous + IMAGE_ZOOM_STEP));
        return;
      }

      if (event.key === "-" && !event.metaKey && !event.ctrlKey) {
        event.preventDefault();
        setZoom((previous) => clampImageZoom(previous - IMAGE_ZOOM_STEP));
        return;
      }

      if (event.key === "0" && !event.metaKey && !event.ctrlKey) {
        event.preventDefault();
        resetView();
        return;
      }

      if (zoom > 1 && ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) {
        event.preventDefault();
        const nextX =
          event.key === "ArrowLeft"
            ? pan.x + IMAGE_PAN_KEYBOARD_STEP
            : event.key === "ArrowRight"
              ? pan.x - IMAGE_PAN_KEYBOARD_STEP
              : pan.x;
        const nextY =
          event.key === "ArrowUp"
            ? pan.y + IMAGE_PAN_KEYBOARD_STEP
            : event.key === "ArrowDown"
              ? pan.y - IMAGE_PAN_KEYBOARD_STEP
              : pan.y;

        setPan({
          x: clampImagePanValue(nextX),
          y: clampImagePanValue(nextY)
        });
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  });

  function resetView() {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }

  async function handleClose() {
    dragStateRef.current = null;
    setIsPanning(false);

    if (document.fullscreenElement) {
      await document.exitFullscreen().catch(() => undefined);
    }

    onClose();
  }

  async function toggleFullscreen() {
    if (document.fullscreenElement) {
      await document.exitFullscreen().catch(() => undefined);
      return;
    }

    if (!document.fullscreenEnabled || !surfaceRef.current?.requestFullscreen) {
      setActionError(true);
      setActionMessage("Fullscreen is not available in this browser.");
      return;
    }

    await surfaceRef.current.requestFullscreen().catch((error) => {
      setActionError(true);
      setActionMessage(error instanceof Error ? error.message : "Unable to enter fullscreen.");
    });
  }

  function handleWheel(event: ReactWheelEvent<HTMLDivElement>) {
    event.preventDefault();
    const zoomDelta = event.deltaY < 0 ? IMAGE_ZOOM_STEP : -IMAGE_ZOOM_STEP;
    setZoom((previous) => clampImageZoom(previous + zoomDelta));
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (zoom <= 1 || event.button !== 0) {
      return;
    }

    event.preventDefault();
    dragStateRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      panX: pan.x,
      panY: pan.y
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setIsPanning(true);
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const dragState = dragStateRef.current;
    if (!dragState || dragState.pointerId !== event.pointerId) {
      return;
    }

    event.preventDefault();
    setPan({
      x: clampImagePanValue(dragState.panX + event.clientX - dragState.startX),
      y: clampImagePanValue(dragState.panY + event.clientY - dragState.startY)
    });
  }

  function stopPanning(event: ReactPointerEvent<HTMLDivElement>) {
    const dragState = dragStateRef.current;
    if (dragState?.pointerId === event.pointerId) {
      dragStateRef.current = null;
    }

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    setIsPanning(false);
  }

  async function handleSaveImage() {
    setIsSaving(true);
    setActionError(false);
    setActionMessage(null);

    try {
      const blob = await loadImageBlob(image);
      downloadBlob(blob, image.fileName);
      setActionMessage("Save started");
    } catch (error) {
      setActionError(true);
      setActionMessage(error instanceof Error ? error.message : "Unable to save image.");
    } finally {
      setIsSaving(false);
    }
  }

  async function handleCopyImage() {
    setIsCopying(true);
    setCopySucceeded(false);
    setActionError(false);
    setActionMessage(null);

    try {
      const blob = await loadImageBlob(image);
      await copyImageBlobToClipboard(blob);
      setCopySucceeded(true);
      setActionMessage("Copied image");
      window.setTimeout(() => setCopySucceeded(false), 1800);
    } catch (error) {
      setActionError(true);
      setActionMessage(error instanceof Error ? error.message : "Unable to copy image.");
    } finally {
      setIsCopying(false);
    }
  }

  return (
    <div className="chat-image-lightbox" role="dialog" aria-modal="true" aria-label={image.fileName}>
      <button
        type="button"
        className="chat-image-lightbox__backdrop"
        onClick={() => void handleClose()}
        aria-label="Dismiss image preview"
      />
      <div ref={surfaceRef} className="chat-image-lightbox__surface">
        <div className="chat-image-lightbox__toolbar">
          <div className="min-w-0">
            <div className="truncate text-sm font-medium text-white">{image.fileName}</div>
            <div className="chat-image-lightbox__meta">
              <span>{Math.round(zoom * 100)}% zoom</span>
              {image.sizeBytes ? <span>{formatFileSize(image.sizeBytes)}</span> : null}
              {zoom > 1 ? (
                <span className="inline-flex items-center gap-1">
                  <Move className="h-3 w-3" />
                  Drag to pan
                </span>
              ) : null}
              {actionMessage ? (
                <span
                  className={cn(
                    "chat-image-lightbox__status",
                    actionError && "chat-image-lightbox__status-error"
                  )}
                  aria-live="polite"
                >
                  {actionMessage}
                </span>
              ) : null}
            </div>
          </div>
          <div className="chat-image-lightbox__actions">
            <button
              type="button"
              onClick={() => setZoom((previous) => clampImageZoom(previous - IMAGE_ZOOM_STEP))}
              className="chat-inline-icon"
              aria-label="Zoom out"
              title="Zoom out"
              disabled={zoom <= IMAGE_ZOOM_MIN}
            >
              <ZoomOut className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => setZoom((previous) => clampImageZoom(previous + IMAGE_ZOOM_STEP))}
              className="chat-inline-icon"
              aria-label="Zoom in"
              title="Zoom in"
              disabled={zoom >= IMAGE_ZOOM_MAX}
            >
              <ZoomIn className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={resetView}
              className="chat-inline-icon"
              aria-label="Reset image view"
              title="Reset view"
              disabled={zoom === 1 && pan.x === 0 && pan.y === 0}
            >
              <RotateCcw className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => void toggleFullscreen()}
              className="chat-inline-icon"
              aria-label={isFullscreen ? "Exit fullscreen" : "View fullscreen"}
              title={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
            >
              {isFullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
            </button>
            <button
              type="button"
              onClick={() => void handleCopyImage()}
              className={cn("chat-inline-icon", copySucceeded && "chat-inline-icon-success")}
              aria-label="Copy image to clipboard"
              title="Copy image"
              disabled={isCopying}
            >
              {copySucceeded ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
            </button>
            <button
              type="button"
              onClick={() => void handleSaveImage()}
              className="chat-inline-icon"
              aria-label="Save image"
              title="Save image"
              disabled={isSaving}
            >
              {isSaving ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
            </button>
            <button
              type="button"
              onClick={() => void handleClose()}
              className="chat-inline-icon"
              aria-label="Dismiss image preview"
              title="Dismiss"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div
          className={cn(
            "chat-image-lightbox__viewport",
            zoom > 1 && "chat-image-lightbox__viewport-pannable",
            isPanning && "chat-image-lightbox__viewport-panning"
          )}
          onWheel={handleWheel}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={stopPanning}
          onPointerCancel={stopPanning}
          onDoubleClick={() => {
            if (zoom === 1) {
              setZoom(2);
            } else {
              resetView();
            }
          }}
        >
          <img
            src={image.src}
            alt={image.fileName}
            className="chat-image-lightbox__image"
            draggable={false}
            style={{ transform: `translate3d(${pan.x}px, ${pan.y}px, 0) scale(${zoom})` }}
          />
        </div>
      </div>
    </div>
  );
}

function AttachmentPreviewModal({
  attachment,
  onClose
}: {
  attachment: PreviewAttachment;
  onClose: () => void;
}) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState(false);
  const canPreviewPdf = isPdfAttachment(attachment);
  const canPreviewVideo = attachment.kind === "video";

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  useEffect(() => {
    setIsSaving(false);
    setActionMessage(null);
    setActionError(false);
  }, [attachment.src]);

  useEffect(() => {
    function handleFullscreenChange() {
      const surface = surfaceRef.current;
      const fullscreenElement = document.fullscreenElement;
      setIsFullscreen(Boolean(surface && fullscreenElement && fullscreenElement === surface));
    }

    document.addEventListener("fullscreenchange", handleFullscreenChange);
    handleFullscreenChange();

    return () => {
      document.removeEventListener("fullscreenchange", handleFullscreenChange);
    };
  }, []);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") {
        return;
      }

      if (document.fullscreenElement) {
        void document.exitFullscreen().catch(() => undefined);
        return;
      }

      void handleClose();
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  });

  useEffect(() => {
    return () => {
      if (surfaceRef.current && document.fullscreenElement === surfaceRef.current) {
        void document.exitFullscreen().catch(() => undefined);
      }
    };
  }, []);

  async function handleClose() {
    if (document.fullscreenElement) {
      await document.exitFullscreen().catch(() => undefined);
    }

    onClose();
  }

  async function toggleFullscreen() {
    if (document.fullscreenElement) {
      await document.exitFullscreen().catch(() => undefined);
      return;
    }

    if (!document.fullscreenEnabled || !surfaceRef.current?.requestFullscreen) {
      setActionError(true);
      setActionMessage("Fullscreen is not available in this browser.");
      return;
    }

    await surfaceRef.current.requestFullscreen().catch((error) => {
      setActionError(true);
      setActionMessage(error instanceof Error ? error.message : "Unable to enter fullscreen.");
    });
  }

  async function handleDownloadAttachment() {
    setIsSaving(true);
    setActionError(false);
    setActionMessage(null);

    try {
      const blob = await loadAttachmentBlob(attachment.fetchSrc);
      downloadBlob(blob, attachment.fileName);
      setActionMessage("Download started");
    } catch (error) {
      setActionError(true);
      setActionMessage(error instanceof Error ? error.message : "Unable to download attachment.");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="chat-attachment-preview" role="dialog" aria-modal="true" aria-label={attachment.fileName}>
      <button
        type="button"
        className="chat-attachment-preview__backdrop"
        onClick={() => void handleClose()}
        aria-label="Dismiss attachment preview"
      />
      <div ref={surfaceRef} className="chat-attachment-preview__surface">
        <div className="chat-attachment-preview__toolbar">
          <div className="min-w-0">
            <div className="truncate text-sm font-medium text-white">{attachment.fileName}</div>
            <div className="chat-attachment-preview__meta">
              <span>{attachment.mimeType || "Attachment"}</span>
              <span>{formatFileSize(attachment.sizeBytes)}</span>
              {actionMessage ? (
                <span
                  className={cn(
                    "chat-attachment-preview__status",
                    actionError && "chat-attachment-preview__status-error"
                  )}
                  aria-live="polite"
                >
                  {actionMessage}
                </span>
              ) : null}
            </div>
          </div>
          <div className="chat-attachment-preview__actions">
            <button
              type="button"
              onClick={() => openUrlInNewTab(attachment.src)}
              className="chat-inline-icon"
              aria-label="Open attachment in a new tab"
              title="Open in browser"
            >
              <ExternalLink className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => void handleDownloadAttachment()}
              className="chat-inline-icon"
              aria-label="Download attachment"
              title="Download"
              disabled={isSaving}
            >
              {isSaving ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
            </button>
            <button
              type="button"
              onClick={() => void toggleFullscreen()}
              className="chat-inline-icon"
              aria-label={isFullscreen ? "Exit fullscreen" : "View fullscreen"}
              title={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
            >
              {isFullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
            </button>
            <button
              type="button"
              onClick={() => void handleClose()}
              className="chat-inline-icon"
              aria-label="Dismiss attachment preview"
              title="Dismiss"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="chat-attachment-preview__body">
          {canPreviewPdf ? (
            <iframe
              src={attachment.src}
              title={attachment.fileName}
              className="chat-attachment-preview__frame"
            />
          ) : canPreviewVideo ? (
            <video
              src={attachment.src}
              controls
              autoPlay
              className="chat-attachment-preview__video"
            />
          ) : (
            <div className="chat-attachment-preview__empty">
              <span className="chat-attachment-preview__empty-icon">
                <Paperclip className="h-7 w-7" />
              </span>
              <div className="min-w-0">
                <div className="truncate text-base font-semibold text-white">{attachment.fileName}</div>
                <p className="mt-2 max-w-md text-sm leading-6 text-white/58">
                  This file type cannot be previewed inline. You can open it in the browser or download it.
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function ChatView({
  isOpen,
  onClose,
  currentUserId,
  nickname,
  currentRoom,
  roomMembers = [],
  initialWhisperTarget = null,
  variant = "panel",
  compact = false
}: ChatViewProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [messageAvatarLookup, setMessageAvatarLookup] = useState<Map<string, string>>(new Map());
  const [profiles, setProfiles] = useState<PresenceProfile[]>([]);
  const [draft, setDraft] = useState("");
  const [draftAttachments, setDraftAttachments] = useState<DraftAttachment[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [replyTarget, setReplyTarget] = useState<ReplyTarget | null>(null);
  const [deletingMessageIds, setDeletingMessageIds] = useState<Set<string>>(() => new Set());
  const [mentionQuery, setMentionQuery] = useState("");
  const [mentionRange, setMentionRange] = useState<{ start: number; end: number } | null>(null);
  const [selectedWhisperTarget, setSelectedWhisperTarget] = useState<WhisperTarget | null>(null);
  const [whisperMenuOpen, setWhisperMenuOpen] = useState(false);
  const [emojiPickerOpen, setEmojiPickerOpen] = useState(false);
  const [previewImage, setPreviewImage] = useState<PreviewImage | null>(null);
  const [previewAttachment, setPreviewAttachment] = useState<PreviewAttachment | null>(null);
  const [isInitialScrollReady, setIsInitialScrollReady] = useState(false);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const scrollContentRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const whisperSelectorRef = useRef<HTMLDivElement>(null);
  const allowAnimatedScrollRef = useRef(false);
  const previousMessageCountRef = useRef(0);
  const previousRoomIdRef = useRef(currentRoom?.id ?? null);
  const previousWhisperFilterRef = useRef<string | null>(null);
  const initialOpenScrollPendingRef = useRef(false);
  const initialScrollGraceUntilRef = useRef(0);

  function jumpToBottom() {
    const scroller = scrollerRef.current;
    if (!scroller) {
      return;
    }

    scroller.scrollTop = scroller.scrollHeight;
  }

  function syncTextareaHeight() {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }

    const minimumHeight = compact ? 44 : 56;
    const maximumHeight = compact ? 112 : 160;
    textarea.style.height = "0px";
    const nextHeight = textarea.value.length === 0
      ? minimumHeight
      : Math.min(textarea.scrollHeight, maximumHeight);
    textarea.style.height = `${Math.max(minimumHeight, nextHeight)}px`;
  }

  function focusComposer() {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }

    try {
      textarea.focus({ preventScroll: true });
    } catch {
      textarea.focus();
    }
  }

  const avatarLookup = useMemo(() => {
    const map = new Map<string, string>();

    for (const profile of profiles) {
      if (profile.avatarSrc) {
        map.set(profile.nickname, profile.avatarSrc);
      }
    }

    return map;
  }, [profiles]);

  const filteredMentions = useMemo(() => {
    if (!mentionRange) {
      return [];
    }

    const query = mentionQuery.trim().toLowerCase();
    return profiles
      .filter((profile) => profile.nickname !== nickname)
      .filter((profile) => !query || profile.nickname.toLowerCase().includes(query))
      .slice(0, 6);
  }, [mentionQuery, mentionRange, nickname, profiles]);

  const whisperCandidates = useMemo(() => {
    const candidatesByUserId = new Map<string, WhisperCandidate>();
    const profilesByUserId = new Map(profiles.map((profile) => [profile.userId, profile]));

    for (const member of roomMembers) {
      if (member.userId === currentUserId) {
        continue;
      }

      const onlineProfile = profilesByUserId.get(member.userId);
      candidatesByUserId.set(member.userId, {
        userId: member.userId,
        nickname: onlineProfile?.nickname ?? member.nickname,
        avatarSrc: onlineProfile?.avatarSrc ?? avatarSrcForRoomMember(member),
        isOnline: Boolean(onlineProfile)
      });
    }

    for (const profile of profiles) {
      if (profile.userId === currentUserId || candidatesByUserId.has(profile.userId)) {
        continue;
      }

      candidatesByUserId.set(profile.userId, {
        userId: profile.userId,
        nickname: profile.nickname,
        avatarSrc: profile.avatarSrc ?? null,
        isOnline: true
      });
    }

    return Array.from(candidatesByUserId.values()).sort((left, right) =>
      left.nickname.localeCompare(right.nickname, undefined, { sensitivity: "base" })
    );
  }, [currentUserId, profiles, roomMembers]);
  const selectedWhisperCandidate = selectedWhisperTarget
    ? whisperCandidates.find((profile) => profile.userId === selectedWhisperTarget.userId)
    : null;
  const activeWhisperTarget = selectedWhisperCandidate
    ? {
        userId: selectedWhisperCandidate.userId,
        nickname: selectedWhisperCandidate.nickname
      }
    : selectedWhisperTarget;
  const activeWhisperUserId = activeWhisperTarget?.userId ?? null;
  const visibleMessages = useMemo(() => {
    if (!activeWhisperUserId) {
      return messages;
    }

    return messages.filter((message) =>
      message.whisper?.recipientIds.includes(activeWhisperUserId)
    );
  }, [activeWhisperUserId, messages]);
  const composerPlaceholder = activeWhisperTarget
    ? `Whisper to ${activeWhisperTarget.nickname}`
    : `Message ${currentRoom?.name ?? "room"}`;

  useEffect(() => {
    if (!initialWhisperTarget || !isOpen) {
      return;
    }

    setSelectedWhisperTarget(initialWhisperTarget);
    setWhisperMenuOpen(false);
    const focusDelayMs = variant === "stage" ? (compact ? 100 : 430) : 0;
    const timeoutId = window.setTimeout(focusComposer, focusDelayMs);

    return () => window.clearTimeout(timeoutId);
  }, [
    initialWhisperTarget?.requestId,
    initialWhisperTarget?.userId,
    initialWhisperTarget?.nickname,
    isOpen,
    compact,
    variant
  ]);

  useEffect(() => {
    if (previousRoomIdRef.current !== currentRoom?.id) {
      setSelectedWhisperTarget(null);
      setWhisperMenuOpen(false);
      previousRoomIdRef.current = currentRoom?.id ?? null;
    }
  }, [currentRoom?.id]);

  useEffect(() => {
    if (!whisperMenuOpen) {
      return undefined;
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (whisperSelectorRef.current?.contains(event.target as Node)) {
        return;
      }

      setWhisperMenuOpen(false);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setWhisperMenuOpen(false);
      }
    };

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [whisperMenuOpen]);

  useEffect(() => {
    if (!isOpen || !currentRoom) {
      return;
    }

    let active = true;
    const roomId = currentRoom.id;
    const cachedRoomMessages = getCachedRoomMessages(roomId);
    const loadStartedAt = getPerformanceNow();
    allowAnimatedScrollRef.current = false;
    initialOpenScrollPendingRef.current = true;
    initialScrollGraceUntilRef.current = performance.now() + 1200;
    previousMessageCountRef.current = 0;
    setIsInitialScrollReady(false);
    setError(null);

    if (cachedRoomMessages) {
      setMessages(cachedRoomMessages.messages);
      setMessageAvatarLookup(cachedRoomMessages.avatars ?? new Map());
      setIsLoading(false);
      recordPerformanceTiming("chat.open", loadStartedAt, {
        status: "cache",
        messageCount: cachedRoomMessages.messages.length
      });
    } else {
      setMessages([]);
      setMessageAvatarLookup(new Map());
      setIsLoading(true);
    }

    if (cachedPresenceProfiles) {
      setProfiles(cachedPresenceProfiles);
    }

    async function loadMessages() {
      const response = await apiFetch("/api/messages", { cache: "no-store" }).catch(() => null);
      if (!active) {
        return;
      }

      if (!response?.ok) {
        setError("Unable to load this room chat right now.");
        setIsLoading(false);
        recordPerformanceTiming("chat.open", loadStartedAt, { status: "error" });
        return;
      }

      const payload = (await response.json().catch(() => null)) as MessagesPayload | null;
      const nextMessages = payload?.messages ?? [];
      const nextAvatars = new Map(Object.entries(payload?.avatars ?? {}));
      setCachedRoomMessages(roomId, nextMessages, nextAvatars);
      setMessages(nextMessages);
      setMessageAvatarLookup(nextAvatars);
      setIsLoading(false);
      recordPerformanceTiming("chat.open", loadStartedAt, {
        status: "network",
        messageCount: nextMessages.length
      });
    }

    async function loadPresence() {
      const response = await apiFetch("/api/presence", { cache: "no-store" }).catch(() => null);
      if (!active || !response?.ok) {
        return;
      }

      const payload = (await response.json().catch(() => null)) as PresenceResponse | null;
      if (payload) {
        cachedPresenceProfiles = payload.profiles;
        setProfiles(payload.profiles);
      }
    }

    void loadMessages();
    void loadPresence();

    const source = createApiEventSource("/api/messages/stream");
    source.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data) as MessageEvent;
        if (payload.type === "message-deleted") {
          setMessages((previous) => {
            const nextMessages = removeMessage(previous, payload.messageId);
            setCachedRoomMessages(roomId, nextMessages);
            return nextMessages;
          });
          setReplyTarget((previous) => (previous?.id === payload.messageId ? null : previous));
          setDeletingMessageIds((previous) => {
            if (!previous.has(payload.messageId)) {
              return previous;
            }

            const nextIds = new Set(previous);
            nextIds.delete(payload.messageId);
            return nextIds;
          });
          return;
        }

        setMessages((previous) => {
          const nextMessages = upsertMessage(previous, payload.message);
          setCachedRoomMessages(roomId, nextMessages);
          return nextMessages;
        });
        if (payload.message.avatarSrc) {
          setMessageAvatarLookup((previous) => {
            const nextLookup = new Map(previous);
            nextLookup.set(payload.message.userId, payload.message.avatarSrc!);
            setCachedRoomAvatars(roomId, nextLookup);
            return nextLookup;
          });
        }
      } catch {
        return;
      }
    };

    const presenceInterval = window.setInterval(() => {
      void loadPresence();
    }, 5000);

    return () => {
      active = false;
      source.close();
      window.clearInterval(presenceInterval);
    };
  }, [currentRoom?.id, isOpen]);

  useEffect(() => {
    if (!isOpen) {
      allowAnimatedScrollRef.current = false;
      initialOpenScrollPendingRef.current = true;
      initialScrollGraceUntilRef.current = 0;
      previousMessageCountRef.current = visibleMessages.length;
      previousWhisperFilterRef.current = activeWhisperUserId;
      setIsInitialScrollReady(false);
      return;
    }
  }, [activeWhisperUserId, isOpen, visibleMessages.length]);

  useEffect(() => {
    if (!activeWhisperUserId) {
      return;
    }

    setReplyTarget((previous) => {
      if (!previous) {
        return previous;
      }

      const replyMessage = messages.find((message) => message.id === previous.id);
      return replyMessage?.whisper?.recipientIds.includes(activeWhisperUserId) ? previous : null;
    });
  }, [activeWhisperUserId, messages]);

  useEffect(() => {
    if (isOpen && !currentRoom) {
      setIsInitialScrollReady(true);
    }
  }, [currentRoom, isOpen]);

  useLayoutEffect(() => {
    if (!isOpen || isLoading || initialOpenScrollPendingRef.current) {
      previousWhisperFilterRef.current = activeWhisperUserId;
      return;
    }

    if (previousWhisperFilterRef.current === activeWhisperUserId) {
      return;
    }

    previousWhisperFilterRef.current = activeWhisperUserId;
    previousMessageCountRef.current = visibleMessages.length;
    allowAnimatedScrollRef.current = true;
    setIsInitialScrollReady(true);

    let firstFrame = 0;
    let secondFrame = 0;
    jumpToBottom();
    firstFrame = window.requestAnimationFrame(() => {
      jumpToBottom();
      secondFrame = window.requestAnimationFrame(jumpToBottom);
    });

    return () => {
      window.cancelAnimationFrame(firstFrame);
      window.cancelAnimationFrame(secondFrame);
    };
  }, [activeWhisperUserId, isLoading, isOpen, visibleMessages.length]);

  useLayoutEffect(() => {
    if (!isOpen || isLoading || !initialOpenScrollPendingRef.current) {
      return;
    }

    const content = scrollContentRef.current;

    if (!content) {
      jumpToBottom();
      previousMessageCountRef.current = visibleMessages.length;
      initialOpenScrollPendingRef.current = false;
      allowAnimatedScrollRef.current = true;
      setIsInitialScrollReady(true);
      return;
    }

    let settleTimeout = 0;
    let settleFrame = 0;
    let previousObservedScrollHeight = scrollerRef.current?.scrollHeight ?? 0;

    const snapToBottom = () => {
      jumpToBottom();
      previousMessageCountRef.current = visibleMessages.length;
      previousObservedScrollHeight = scrollerRef.current?.scrollHeight ?? previousObservedScrollHeight;
    };

    const finishInitialScroll = () => {
      snapToBottom();
      initialOpenScrollPendingRef.current = false;
      allowAnimatedScrollRef.current = true;
      setIsInitialScrollReady(true);
    };

    const scheduleFinish = () => {
      window.clearTimeout(settleTimeout);
      window.cancelAnimationFrame(settleFrame);
      settleTimeout = window.setTimeout(() => {
        settleFrame = window.requestAnimationFrame(() => {
          finishInitialScroll();
        });
      }, 48);
    };

    snapToBottom();

    if (typeof ResizeObserver === "undefined") {
      scheduleFinish();
      return () => {
        window.clearTimeout(settleTimeout);
        window.cancelAnimationFrame(settleFrame);
      };
    }

    const resizeObserver = new ResizeObserver(() => {
      const withinInitialGraceWindow = performance.now() < initialScrollGraceUntilRef.current;
      const scroller = scrollerRef.current;
      const wasPinnedToBottom = scroller
        ? scroller.scrollTop + scroller.clientHeight >=
          previousObservedScrollHeight - CHAT_BOTTOM_STICKINESS_PX
        : false;

      if (!initialOpenScrollPendingRef.current && !withinInitialGraceWindow && !wasPinnedToBottom) {
        previousObservedScrollHeight = scroller?.scrollHeight ?? previousObservedScrollHeight;
        return;
      }

      snapToBottom();
      if (initialOpenScrollPendingRef.current) {
        scheduleFinish();
      }
    });

    resizeObserver.observe(content);
    scheduleFinish();

    return () => {
      resizeObserver.disconnect();
      window.clearTimeout(settleTimeout);
      window.cancelAnimationFrame(settleFrame);
    };
  }, [isOpen, isLoading, currentRoom?.id, activeWhisperUserId, visibleMessages.length]);

  useEffect(() => {
    if (!isOpen || !allowAnimatedScrollRef.current) {
      return;
    }

    const scroller = scrollerRef.current;
    if (!scroller) {
      return;
    }

    const hadMoreMessages = visibleMessages.length > previousMessageCountRef.current;
    previousMessageCountRef.current = visibleMessages.length;

    if (!hadMoreMessages) {
      return;
    }

    scroller.scrollTo({
      top: scroller.scrollHeight,
      behavior: "smooth"
    });
  }, [isOpen, visibleMessages.length]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    syncTextareaHeight();
  }, [compact, draft, isOpen]);

  useLayoutEffect(() => {
    if (!isOpen) {
      return;
    }

    function handleWindowResize() {
      syncTextareaHeight();
    }

    window.addEventListener("resize", handleWindowResize);

    return () => {
      window.removeEventListener("resize", handleWindowResize);
    };
  }, [compact, isOpen]);

  useEffect(() => {
    return () => {
      for (const attachment of draftAttachments) {
        URL.revokeObjectURL(attachment.previewUrl);
      }
    };
  }, [draftAttachments]);

  if (!isOpen) {
    return null;
  }

  function handleDraftChange(nextValue: string) {
    setDraft(nextValue);

    const textarea = textareaRef.current;
    const cursor = textarea?.selectionStart ?? nextValue.length;
    const beforeCursor = nextValue.slice(0, cursor);
    const quotedMatch = beforeCursor.match(/@"([^"]*)$/);

    if (quotedMatch) {
      setMentionQuery(quotedMatch[1] ?? "");
      setMentionRange({ start: cursor - quotedMatch[0].length, end: cursor });
      return;
    }

    const plainMatch = beforeCursor.match(/(^|\s)@([A-Za-z0-9_]*)$/);
    if (plainMatch) {
      setMentionQuery(plainMatch[2] ?? "");
      setMentionRange({ start: cursor - (plainMatch[2]?.length ?? 0) - 1, end: cursor });
      return;
    }

    setMentionRange(null);
    setMentionQuery("");
  }

  function insertAtCursor(value: string) {
    const textarea = textareaRef.current;
    const start = textarea?.selectionStart ?? draft.length;
    const end = textarea?.selectionEnd ?? draft.length;
    const nextDraft = `${draft.slice(0, start)}${value}${draft.slice(end)}`;
    setDraft(nextDraft);
    window.requestAnimationFrame(() => {
      try {
        textarea?.focus({ preventScroll: true });
      } catch {
        textarea?.focus();
      }
      const nextPosition = start + value.length;
      textarea?.setSelectionRange(nextPosition, nextPosition);
    });
  }

  function insertMention(name: string) {
    if (!mentionRange) {
      return;
    }

    const nextMention = name.includes(" ") ? `@"${name}" ` : `@${name} `;
    const nextDraft = draft.slice(0, mentionRange.start) + nextMention + draft.slice(mentionRange.end);

    setDraft(nextDraft);
    setMentionRange(null);
    setMentionQuery("");
    window.requestAnimationFrame(() => {
      focusComposer();
    });
  }

  function addDraftFiles(files: File[]) {
    if (!files.length) {
      return;
    }

    const nextAttachments = files.map((file) => ({
      id: `${file.name}-${file.size}-${file.lastModified}-${Math.random().toString(36).slice(2, 8)}`,
      file,
      previewUrl: URL.createObjectURL(file)
    }));

    setDraftAttachments((previous) => [...previous, ...nextAttachments].slice(0, 6));
  }

  function handleFilesSelected(fileList: FileList | null) {
    addDraftFiles(Array.from(fileList ?? []));
  }

  function removeDraftAttachment(id: string) {
    setDraftAttachments((previous) => {
      const match = previous.find((attachment) => attachment.id === id);
      if (match) {
        URL.revokeObjectURL(match.previewUrl);
      }
      return previous.filter((attachment) => attachment.id !== id);
    });
  }

  async function handleToggleReaction(messageId: string, emoji: string) {
    const response = await apiFetch("/api/messages/reactions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messageId, emoji })
    }).catch(() => null);

    if (!response?.ok) {
      return;
    }

    const payload = (await response.json().catch(() => null)) as { message?: ChatMessage } | null;
    if (payload?.message) {
      setMessages((previous) => {
        const nextMessages = upsertMessage(previous, payload.message as ChatMessage);
        if (currentRoom) {
          setCachedRoomMessages(currentRoom.id, nextMessages);
        }
        return nextMessages;
      });
    }
  }

  async function handleDeleteMessage(messageId: string) {
    if (!currentRoom) {
      return;
    }

    setDeletingMessageIds((previous) => {
      if (previous.has(messageId)) {
        return previous;
      }

      return new Set(previous).add(messageId);
    });
    setError(null);

    let response: Response | null = null;
    let payload: { error?: string; messageId?: string } | null = null;

    try {
      response = await apiFetch("/api/messages", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messageId })
      });
      const rawPayload = await response.text();
      payload = rawPayload
        ? (JSON.parse(rawPayload) as { error?: string; messageId?: string })
        : null;
    } catch {
      response = null;
      payload = null;
    }

    if (!response?.ok) {
      setError(
        payload?.error ??
          (response ? `Unable to delete message. Server returned ${response.status}.` : "Unable to reach chat server.")
      );
      setDeletingMessageIds((previous) => {
        const nextIds = new Set(previous);
        nextIds.delete(messageId);
        return nextIds;
      });
      return;
    }

    const deletedMessageId = payload?.messageId ?? messageId;
    setMessages((previous) => {
      const nextMessages = removeMessage(previous, deletedMessageId);
      setCachedRoomMessages(currentRoom.id, nextMessages);
      return nextMessages;
    });
    setReplyTarget((previous) => (previous?.id === deletedMessageId ? null : previous));
    setDeletingMessageIds((previous) => {
      const nextIds = new Set(previous);
      nextIds.delete(messageId);
      nextIds.delete(deletedMessageId);
      return nextIds;
    });
  }

  async function sendMessage() {
    if (!currentRoom) {
      return;
    }

    const formData = new FormData();
    formData.set(
      "payload",
      JSON.stringify({
        body: draft,
        replyToMessageId: replyTarget?.id ?? null,
        whisperRecipientIds: activeWhisperTarget ? [activeWhisperTarget.userId] : []
      })
    );

    for (const attachment of draftAttachments) {
      formData.append("files", attachment.file);
    }

    setIsSending(true);
    setError(null);

    const response = await apiFetch("/api/messages", {
      method: "POST",
      body: formData
    }).catch(() => null);

    const payload = (await response?.json().catch(() => null)) as { error?: string; message?: ChatMessage } | null;

    if (!response?.ok) {
      setError(payload?.error ?? "Unable to send message.");
      setIsSending(false);
      return;
    }

    if (payload?.message) {
      setMessages((previous) => {
        const nextMessages = upsertMessage(previous, payload.message as ChatMessage);
        setCachedRoomMessages(currentRoom.id, nextMessages);
        return nextMessages;
      });
    }

    for (const attachment of draftAttachments) {
      URL.revokeObjectURL(attachment.previewUrl);
    }

    setDraft("");
    setDraftAttachments([]);
    setReplyTarget(null);
    setEmojiPickerOpen(false);
    setIsSending(false);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await sendMessage();
  }

  const chatBody = (
    <div className="flex h-full min-h-0 min-w-0 w-full flex-col overflow-hidden">
      <div
        ref={scrollerRef}
        className={cn(
          "chat-scroll min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto",
          !isInitialScrollReady && visibleMessages.length > 0 && "opacity-0",
          variant === "stage"
            ? compact
              ? "px-3 py-3"
              : "px-5 py-5"
            : "px-5 py-5 sm:px-8"
        )}
      >
        <div ref={scrollContentRef} className="flex min-h-full min-w-0 w-full flex-col">
          {!currentRoom ? (
            <div className="chat-empty-state">Join or create a room first to open its persistent chat.</div>
          ) : isLoading ? (
            <div className="chat-empty-state">
              <LoaderCircle className="h-5 w-5 animate-spin text-[var(--accent)]" />
              <span>Loading room chat...</span>
            </div>
          ) : visibleMessages.length === 0 ? (
            <div className="chat-empty-state">
              <span>
                {activeWhisperTarget
                  ? `No whispers with ${activeWhisperTarget.nickname} yet.`
                  : "No messages yet. Start the room conversation."}
              </span>
            </div>
          ) : (
            visibleMessages.map((message) => (
              <MessageRow
                key={message.id}
                message={message}
                currentUserId={currentUserId}
                myNickname={nickname}
                avatarSrc={
                  message.avatarSrc ??
                  messageAvatarLookup.get(message.userId) ??
                  avatarLookup.get(message.nickname)
                }
                isDeleting={deletingMessageIds.has(message.id)}
                onOpenImage={setPreviewImage}
                onOpenAttachment={setPreviewAttachment}
                onReply={(target) => setReplyTarget(target)}
                onDelete={handleDeleteMessage}
                onToggleReaction={handleToggleReaction}
              />
            ))
          )}
        </div>
      </div>

      <div
        className={cn(
          "mt-auto shrink-0",
          variant === "stage"
            ? compact
              ? "px-3 pb-3 pt-2"
              : "px-5 pb-6 pt-3"
            : "px-5 pb-5 pt-2 sm:px-8 sm:pb-6 sm:pt-3"
        )}
      >
        {replyTarget ? (
          <div className="chat-composer-banner">
            <div className="min-w-0">
              <div className="text-[11px] uppercase tracking-[0.22em] text-[var(--accent)]">
                Replying to {replyTarget.nickname}
              </div>
              <div className="truncate text-sm text-white/64">{replyTarget.body}</div>
            </div>
            <button type="button" onClick={() => setReplyTarget(null)} className="chat-inline-action">
              Clear
            </button>
          </div>
        ) : null}

        {draftAttachments.length > 0 ? (
          <div className="chat-draft-attachments">
            {draftAttachments.map((attachment) => (
              <div key={attachment.id} className="chat-draft-attachment">
                {getAttachmentKind(attachment.file) === "image" ? (
                  <button
                    type="button"
                    onClick={() =>
                      setPreviewImage({
                        src: attachment.previewUrl,
                        fileName: attachment.file.name,
                        mimeType: attachment.file.type,
                        sizeBytes: attachment.file.size
                      })
                    }
                    className="chat-draft-attachment__image-button"
                    aria-label={`Open large preview for ${attachment.file.name}`}
                  >
                    <img
                      src={attachment.previewUrl}
                      alt={attachment.file.name}
                      className="chat-draft-attachment__image"
                    />
                  </button>
                ) : getAttachmentKind(attachment.file) === "video" ? (
                  <video src={attachment.previewUrl} className="chat-draft-attachment__image" />
                ) : (
                  <div className="chat-draft-attachment__file">
                    <Paperclip className="h-4 w-4" />
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm text-white">{attachment.file.name}</div>
                  <div className="text-xs text-white/42">{formatFileSize(attachment.file.size)}</div>
                </div>
                <button
                  type="button"
                  onClick={() => removeDraftAttachment(attachment.id)}
                  className="chat-inline-action"
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        ) : null}

        {error ? <p className="mb-3 text-sm text-[var(--danger)]">{error}</p> : null}

        <form onSubmit={handleSubmit} className="chat-composer-form">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(event) => handleFilesSelected(event.target.files)}
          />
          <div
            className={cn("chat-composer-shell", activeWhisperTarget && "chat-composer-shell-whisper")}
          >
            <div ref={whisperSelectorRef} className="chat-whisper-selector">
              <button
                type="button"
                onClick={() => setWhisperMenuOpen((previous) => !previous)}
                className="chat-whisper-trigger"
                aria-label="Choose message recipients"
                aria-expanded={whisperMenuOpen}
              >
                <span className="chat-whisper-trigger__label">
                  {activeWhisperTarget?.nickname ?? "All"}
                </span>
                <ChevronDown className="h-4 w-4" />
              </button>

              {whisperMenuOpen ? (
                <div className="chat-whisper-menu" role="listbox" aria-label="Message recipients">
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedWhisperTarget(null);
                      setWhisperMenuOpen(false);
                      focusComposer();
                    }}
                    className={cn(
                      "chat-whisper-option chat-whisper-option-sticky",
                      !activeWhisperTarget && "chat-whisper-option-active"
                    )}
                    role="option"
                    aria-selected={!activeWhisperTarget}
                  >
                    <span className="chat-whisper-option__avatar chat-whisper-option__avatar-all">
                      All
                    </span>
                    <span>All</span>
                  </button>

                  <div className="chat-whisper-option-list">
                    {whisperCandidates.length > 0 ? (
                      whisperCandidates.map((participant) => (
                        <button
                          key={participant.userId}
                          type="button"
                          onClick={() => {
                            setSelectedWhisperTarget({
                              userId: participant.userId,
                              nickname: participant.nickname
                            });
                            setWhisperMenuOpen(false);
                            focusComposer();
                          }}
                          className={cn(
                            "chat-whisper-option",
                            participant.isOnline && "chat-whisper-option-online",
                            activeWhisperTarget?.userId === participant.userId && "chat-whisper-option-active"
                          )}
                          role="option"
                          aria-selected={activeWhisperTarget?.userId === participant.userId}
                        >
                          <span className="chat-whisper-option__avatar">
                            {participant.avatarSrc ? (
                              <img src={participant.avatarSrc} alt="" />
                            ) : (
                              initialsFor(participant.nickname)
                            )}
                          </span>
                          <span className="truncate">{participant.nickname}</span>
                        </button>
                      ))
                    ) : (
                      <div className="chat-whisper-empty">No one else is in this room.</div>
                    )}
                  </div>
                </div>
              ) : null}
            </div>

            <textarea
              ref={textareaRef}
              value={draft}
              onChange={(event) => handleDraftChange(event.target.value)}
              onPaste={(event) => {
                const files = Array.from(event.clipboardData.files).filter((file) =>
                  file.type.startsWith("image/")
                );
                if (files.length > 0) {
                  event.preventDefault();
                  addDraftFiles(files);
                }
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  if (!isSending && (draft.trim() || draftAttachments.length > 0)) {
                    void sendMessage();
                  }
                }
              }}
              rows={1}
              placeholder={composerPlaceholder}
              className={cn("chat-composer", !draft && "chat-composer-empty")}
            />

            <div className="chat-composer-actions">
              <div className="chat-composer-action-slot">
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="chat-composer-icon-button chat-composer-icon-button-attach"
                  aria-label="Attach file"
                >
                  <span className="chat-composer-icon-button__glyph">
                    <Paperclip className="h-4 w-4" />
                  </span>
                </button>
              </div>
              <div className="chat-composer-action-slot chat-composer-action-slot-emoji">
                <button
                  type="button"
                  onClick={() => setEmojiPickerOpen((previous) => !previous)}
                  className="chat-composer-icon-button chat-composer-icon-button-emoji"
                  aria-label="Insert emoji"
                >
                  <span className="chat-composer-icon-button__glyph">
                    <SmilePlus className="h-4 w-4" />
                  </span>
                </button>
                {emojiPickerOpen ? (
                  <div className="chat-reaction-popover chat-reaction-popover-composer">
                    {REACTION_PRESETS.map((emoji) => (
                      <button
                        key={emoji}
                        type="button"
                        onClick={() => {
                          insertAtCursor(emoji);
                          setEmojiPickerOpen(false);
                        }}
                        className="chat-reaction-popover__item"
                      >
                        {emoji}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
              <div className="chat-composer-action-slot">
                <button
                  type="submit"
                  disabled={isSending || (!draft.trim() && draftAttachments.length === 0)}
                  className="chat-composer-icon-button chat-composer-icon-button-send"
                  aria-label="Send message"
                >
                  <span className="chat-composer-icon-button__glyph">
                    {isSending ? (
                      <LoaderCircle className="h-4 w-4 animate-spin" />
                    ) : (
                      <SendHorizontal className="h-4 w-4" />
                    )}
                  </span>
                </button>
              </div>
            </div>
          </div>

          {filteredMentions.length > 0 ? (
            <div className="chat-mentions-popover">
              {filteredMentions.map((profile) => (
                <button
                  key={profile.userId}
                  type="button"
                  onClick={() => insertMention(profile.nickname)}
                  className="chat-mentions-popover__item"
                >
                  <span className="chat-mentions-popover__icon">
                    <AtSign className="h-3.5 w-3.5" />
                  </span>
                  <span>{profile.nickname}</span>
                </button>
              ))}
            </div>
          ) : null}
        </form>
      </div>

      {previewImage ? <ImageLightbox image={previewImage} onClose={() => setPreviewImage(null)} /> : null}
      {previewAttachment ? (
        <AttachmentPreviewModal
          attachment={previewAttachment}
          onClose={() => setPreviewAttachment(null)}
        />
      ) : null}
    </div>
  );

  if (variant === "stage") {
    return (
      <section
        className={cn(
          "chat-stage-shell flex h-full min-h-0 flex-col overflow-hidden border border-white/8 bg-[rgba(24,38,42,0.88)] shadow-[0_24px_60px_rgba(0,0,0,0.28),inset_0_1px_0_rgba(255,255,255,0.04)] backdrop-blur-xl",
          compact ? "compact-chat-stage w-full max-w-full rounded-none border-x-0 border-b-0" : "rounded-l-[1.35rem]"
        )}
      >
        <header
          className={cn(
            "flex items-center justify-between gap-4 border-b border-white/8",
            compact ? "px-3 py-2" : "px-5 py-4"
          )}
        >
          <div className="min-w-0">
            <div className="text-[11px] uppercase tracking-[0.28em] text-[var(--accent)]">
              Room Chat
            </div>
            <div className="mt-1 truncate text-sm text-white/62">{currentRoom?.name ?? "No room"}</div>
          </div>

          <button
            type="button"
            onClick={onClose}
            className={cn(
              "ui-button inline-flex items-center justify-center text-white/72 transition hover:bg-white/7 hover:text-white",
              compact ? "h-9 w-9 rounded-lg" : "h-10 w-10 rounded-xl"
            )}
            aria-label="Close chat"
          >
            <X className="h-5 w-5" />
          </button>
        </header>

        <div className="min-h-0 flex-1">{chatBody}</div>
      </section>
    );
  }

  return (
    <PrimaryPanelShell
      onClose={onClose}
      eyebrow="Room Chat"
      title={null}
      closeLabel="Close chat"
      className="h-[calc(100vh-10.5rem)] max-h-[calc(100vh-10.5rem)] min-h-[36rem]"
      bodyClassName="h-full min-h-0 max-h-full overflow-hidden"
    >
      {chatBody}
    </PrimaryPanelShell>
  );
}
