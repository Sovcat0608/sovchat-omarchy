"use client";

import { APP_BUILD_VERSION } from "@/lib/generated/build-meta";
import {
  RELEASE_HIGHLIGHTS,
  RELEASE_HIGHLIGHT_NOTES,
  RELEASE_HIGHLIGHTS_RANGE,
  RELEASE_HIGHLIGHTS_SUMMARY,
  RELEASE_HIGHLIGHTS_VERSION
} from "@/lib/generated/release-highlights";
import { PrimaryPanelShell } from "@/components/primary-panel-shell";
import { cn } from "@/lib/utils";

type VersionHighlightsPanelProps = {
  onClose: () => void;
};

type ReleaseHighlightKind = "feature" | "fix" | "implementation" | "polish";

const KIND_LABELS: Record<ReleaseHighlightKind, string> = {
  feature: "Feature",
  fix: "Fix",
  implementation: "Implementation",
  polish: "Polish"
};

const KIND_CLASSES: Record<ReleaseHighlightKind, string> = {
  feature: "border-[rgba(126,227,231,0.22)] bg-[rgba(126,227,231,0.08)] text-[#8cf4f7]",
  fix: "border-[rgba(255,202,42,0.22)] bg-[rgba(255,202,42,0.08)] text-[#ffd861]",
  implementation: "border-white/12 bg-white/6 text-white/72",
  polish: "border-[rgba(186,246,247,0.16)] bg-[rgba(186,246,247,0.06)] text-[#baf6f7]"
};

export function VersionHighlightsPanel({ onClose }: VersionHighlightsPanelProps) {
  const releaseNotes = RELEASE_HIGHLIGHT_NOTES;

  return (
    <PrimaryPanelShell
      eyebrow="What changed"
      title={`SovChat ${APP_BUILD_VERSION}`}
      onClose={onClose}
      widthClassName="w-full max-w-[min(100%,58rem)]"
      bodyClassName="overflow-hidden"
    >
      <div className="flex h-full min-h-0 flex-col gap-5 overflow-y-auto pr-1">
        <section className="rounded-lg bg-white/[0.035] p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
          <div className="flex flex-wrap items-center gap-3 text-[11px] uppercase tracking-[0.2em] text-white/40">
            <span>Version {RELEASE_HIGHLIGHTS_VERSION}</span>
            <span className="h-1 w-1 rounded-full bg-white/24" aria-hidden="true" />
            <span>{RELEASE_HIGHLIGHTS_RANGE}</span>
          </div>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-white/68">
            {RELEASE_HIGHLIGHTS_SUMMARY}
          </p>
        </section>

        {releaseNotes.length > 0 ? (
          <section className="rounded-lg bg-white/[0.035] p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
            <div className="text-[11px] uppercase tracking-[0.2em] text-white/40">
              Release notes
            </div>
            <ul className="mt-3 grid gap-2">
              {releaseNotes.map((note, index) => (
                <li
                  key={`${note}:${index}`}
                  className="flex gap-3 text-sm leading-6 text-white/68"
                >
                  <span
                    className="mt-[0.6rem] h-1.5 w-1.5 shrink-0 rounded-full bg-[#8cf4f7]/70"
                    aria-hidden="true"
                  />
                  <span className="min-w-0 break-words">{note}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <section className="grid gap-3 md:grid-cols-2">
          {RELEASE_HIGHLIGHTS.map((item) => (
            <article
              key={`${item.kind}:${item.title}`}
              className="rounded-lg bg-[rgba(13,24,27,0.58)] p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.04),0_14px_34px_rgba(0,0,0,0.18)]"
            >
              <div
                className={cn(
                  "inline-flex rounded-full border px-2.5 py-1 text-[10px] uppercase tracking-[0.16em]",
                  KIND_CLASSES[item.kind]
                )}
              >
                {KIND_LABELS[item.kind]}
              </div>
              <h3 className="mt-3 text-base font-medium text-white/90">{item.title}</h3>
              <p className="mt-2 text-sm leading-6 text-white/58">{item.detail}</p>
            </article>
          ))}
        </section>
      </div>
    </PrimaryPanelShell>
  );
}
