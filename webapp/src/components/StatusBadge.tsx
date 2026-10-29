export type SessionStatus = "idle" | "starting" | "live" | "ended" | "error";

const MAP: Record<SessionStatus, { label: string; cls: string }> = {
  idle: { label: "Idle", cls: "idle" },
  starting: { label: "Connecting…", cls: "starting" },
  live: { label: "Live", cls: "live" },
  ended: { label: "Ended", cls: "ended" },
  error: { label: "Error", cls: "error" },
};

export function StatusBadge({ status }: { status: SessionStatus }) {
  const m = MAP[status];
  return (
    <span className={`status-badge ${m.cls}`} role="status">
      {m.label}
    </span>
  );
}
