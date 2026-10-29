export type SourceKind = "sim" | "camera" | "screen";

const OPTIONS: { id: SourceKind; label: string }[] = [
  { id: "sim", label: "Demo (simulated feed)" },
  { id: "camera", label: "Camera" },
  { id: "screen", label: "Screen share" },
];

export function SourcePicker({
  value,
  onChange,
}: {
  value: SourceKind | null;
  onChange: (kind: SourceKind) => void;
}) {
  return (
    <div className="segmented" role="tablist" aria-label="Source">
      {OPTIONS.map((o) => (
        <button
          key={o.id}
          type="button"
          role="tab"
          aria-selected={value === o.id}
          className={value === o.id ? "is-active" : ""}
          onClick={() => onChange(o.id)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
