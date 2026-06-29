import type { ReactNode } from "react";

type EmptyStateProps = {
  title: ReactNode;
  description?: ReactNode;
};

export function EmptyState({ description, title }: EmptyStateProps) {
  return (
    <div className="ui-empty-state">
      <strong>{title}</strong>
      {description ? <span>{description}</span> : null}
    </div>
  );
}
