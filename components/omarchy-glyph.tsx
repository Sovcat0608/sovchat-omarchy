import type { SVGProps } from "react";

export type OmarchyGlyphKind =
  | "chat"
  | "headphones"
  | "headphones-off"
  | "microphone"
  | "microphone-off"
  | "noise"
  | "settings"
  | "share"
  | "share-off"
  | "volume"
  | "volume-off"
  | "voice";

type OmarchyGlyphProps = {
  kind: OmarchyGlyphKind;
  className?: string;
} & Omit<SVGProps<SVGSVGElement>, "children">;

export function OmarchyGlyph({ kind, className, ...props }: OmarchyGlyphProps) {
  const sharedProps = {
    ...props,
    className,
    viewBox: "0 0 20 20",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.5,
    strokeLinecap: "square" as const,
    strokeLinejoin: "miter" as const,
    "aria-hidden": true
  };

  if (kind === "noise") {
    return (
      <svg {...sharedProps}>
        <path d="M2.5 10h3l1.5-5 2.2 10 2.1-8 1.4 5h4.8" />
        <path d="M2.5 4v3M2.5 13v3M17.5 4v3M17.5 13v3" opacity=".55" />
      </svg>
    );
  }

  if (kind === "share" || kind === "share-off") {
    return (
      <svg {...sharedProps}>
        <path d="M2.5 4.5h9v8h-9zM5 15.5h7M8.5 12.5v3" />
        <path d="M11 8.5 17 2.5M13 2.5h4v4" />
        {kind === "share-off" ? <path d="m3 2 14 16" strokeWidth="2" /> : null}
      </svg>
    );
  }

  if (kind === "chat") {
    return (
      <svg {...sharedProps}>
        <path d="M2.5 3.5h15v10h-8l-4.5 3v-3H2.5z" />
        <path d="M6 7.5h8M6 10h5" opacity=".7" />
      </svg>
    );
  }

  if (kind === "microphone" || kind === "microphone-off") {
    return (
      <svg {...sharedProps}>
        <path d="M7 2.5h6v9H7z" />
        <path d="M4.5 9v2.5c0 2.2 2.4 4 5.5 4s5.5-1.8 5.5-4V9M10 15.5v2M7 17.5h6" />
        {kind === "microphone-off" ? <path d="m3 2 14 16" strokeWidth="2" /> : null}
      </svg>
    );
  }

  if (kind === "headphones" || kind === "headphones-off") {
    return (
      <svg {...sharedProps}>
        <path d="M3 10V8.5C3 4.9 5.8 2 10 2s7 2.9 7 6.5V10" />
        <path d="M3 9.5h3v7H3zM14 9.5h3v7h-3z" />
        {kind === "headphones-off" ? <path d="m3 2 14 16" strokeWidth="2" /> : null}
      </svg>
    );
  }

  if (kind === "settings") {
    return (
      <svg {...sharedProps}>
        <path d="M2.5 5h15M2.5 10h15M2.5 15h15" />
        <path d="M6 3v4M13.5 8v4M8.5 13v4" strokeWidth="2" />
      </svg>
    );
  }

  if (kind === "volume" || kind === "volume-off") {
    return (
      <svg {...sharedProps}>
        <path d="M2.5 8h3l4-3.5v11L5.5 12h-3z" />
        {kind === "volume" ? (
          <path d="M12 7.5c1.5 1.4 1.5 3.6 0 5M14.5 5c3 2.8 3 7.2 0 10" />
        ) : (
          <path d="m12.5 8 5 5M17.5 8l-5 5" />
        )}
      </svg>
    );
  }

  return (
    <svg {...sharedProps}>
      <path d="M3 13V7M7.5 16V4M12.5 14V6M17 12V8" strokeWidth="2.2" />
    </svg>
  );
}
