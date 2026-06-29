import type { HTMLAttributes } from "react";
import { cn } from "../../lib/ui.js";

type BadgeProps = HTMLAttributes<HTMLSpanElement> & {
  tone?: "neutral" | "good" | "warn" | "bad" | "info";
};

export function Badge({ className, tone = "neutral", ...props }: BadgeProps) {
  return <span className={cn("ui-badge", `ui-badge--${tone}`, className)} {...props} />;
}
