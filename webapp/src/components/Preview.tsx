import type { ReactNode } from "react";

export function Preview({
  label,
  emptyText,
  children,
}: {
  label?: string;
  emptyText?: string;
  children?: ReactNode;
}) {
  return (
    <div className="preview">
      {label ? <span className="preview-label">{label}</span> : null}
      {children ?? (
        <div className="preview-empty">
          {emptyText ?? "Choose a source to start the live preview."}
        </div>
      )}
    </div>
  );
}
