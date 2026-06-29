import type { ComponentType, ReactNode } from "react";
import type { LucideProps } from "lucide-react";
import { cn } from "../../lib/ui.js";

export type StatusTone = "good" | "warn" | "bad" | "idle" | "info";

type StatusPillProps = {
  label: ReactNode;
  tone?: StatusTone;
  pulse?: boolean;
  title?: string;
  icon?: ComponentType<LucideProps>;
  className?: string;
};

export function StatusPill({ className, icon: Icon, label, pulse = false, title, tone = "idle" }: StatusPillProps) {
  return (
    <span className={cn("app-status-pill", `app-status-pill--${tone}`, pulse && "is-pulsing", className)} title={title}>
      <i aria-hidden="true" />
      {Icon ? <Icon aria-hidden="true" /> : null}
      <span>{label}</span>
    </span>
  );
}
