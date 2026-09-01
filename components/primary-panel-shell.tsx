"use client";

import type { ReactNode } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

type PrimaryPanelShellProps = {
  eyebrow: string;
  title?: string | null;
  onClose: () => void;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
  headerClassName?: string;
  closeLabel?: string;
  actions?: ReactNode;
  widthClassName?: string;
  showCloseButton?: boolean;
  compact?: boolean;
};

export function PrimaryPanelShell({
  eyebrow,
  title,
  onClose,
  children,
  className,
  bodyClassName,
  headerClassName,
  closeLabel = "Close panel",
  actions,
  widthClassName = "w-full max-w-[min(100%,76rem)]",
  showCloseButton = true,
  compact = false
}: PrimaryPanelShellProps) {
  return (
    <section
      className={cn(
        "flex flex-col",
        compact ? "h-full min-h-0 items-stretch gap-2" : "min-h-[72vh] items-center gap-6",
        className
      )}
    >
      <div
        className={cn(
          "mx-auto flex flex-1 flex-col",
          compact ? "h-full min-h-0 gap-2" : "min-h-[72vh] gap-6",
          widthClassName
        )}
      >
        <header
          className={cn(
            "flex flex-wrap justify-between border-b border-white/8",
            compact ? "gap-2 px-3 py-2" : "gap-4 pb-5",
            title ? "items-start" : "items-center",
            headerClassName
          )}
        >
          <div>
            <div className="text-[11px] uppercase tracking-[0.28em] text-[var(--accent)]">
              {eyebrow}
            </div>
            {title ? <h2 className="mt-2 text-3xl font-semibold text-white">{title}</h2> : null}
          </div>

          <div className="flex items-center gap-3">
            {actions}
            {showCloseButton ? (
              <button
                type="button"
                onClick={onClose}
                className={cn(
                  "ui-button inline-flex items-center justify-center text-white/72 transition hover:bg-white/7 hover:text-white",
                  compact ? "h-9 w-9 rounded-lg" : "h-11 w-11 rounded-xl"
                )}
                aria-label={closeLabel}
              >
                <X className="h-5 w-5" />
              </button>
            ) : null}
          </div>
        </header>

        <div className={cn("min-h-0 flex-1", bodyClassName)}>{children}</div>
      </div>
    </section>
  );
}
