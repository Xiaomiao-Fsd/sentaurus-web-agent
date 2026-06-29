import type { ReactNode } from "react";

type TooltipProps = {
  label: string;
  children: ReactNode;
};

export function Tooltip({ children, label }: TooltipProps) {
  return (
    <span className="ui-tooltip" data-tooltip={label}>
      {children}
    </span>
  );
}
