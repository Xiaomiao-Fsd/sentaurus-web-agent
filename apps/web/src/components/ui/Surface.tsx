import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../../lib/ui.js";

type SurfaceProps = HTMLAttributes<HTMLElement> & {
  as?: "section" | "article" | "div" | "aside";
  title?: ReactNode;
  actions?: ReactNode;
};

export function Surface({ actions, as: Element = "section", children, className, title, ...props }: SurfaceProps) {
  return (
    <Element className={cn("app-surface", className)} {...props}>
      {title || actions ? (
        <div className="app-surface-header">
          <div>{title}</div>
          {actions ? <div className="app-surface-actions">{actions}</div> : null}
        </div>
      ) : null}
      <div className="app-surface-body">{children}</div>
    </Element>
  );
}
