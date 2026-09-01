"use client";

import type { PropsWithChildren } from "react";
import { cn } from "@/lib/utils";

type HoverTooltipProps = PropsWithChildren<{
  label: string;
  className?: string;
  bubbleClassName?: string;
}>;

export function HoverTooltip({ label, className, bubbleClassName, children }: HoverTooltipProps) {
  return (
    <span className={cn("ui-tooltip", className)}>
      {children}
      <span className={cn("ui-tooltip__bubble", bubbleClassName)} role="tooltip">
        {label}
      </span>
    </span>
  );
}
