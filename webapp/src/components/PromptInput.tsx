export function PromptInput({
  value,
  onChange,
  onSubmit,
  activePrompt,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  activePrompt: string | null;
  disabled?: boolean;
}) {
  return (
    <div>
      <form
        className="prompt-row"
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit();
        }}
      >
        <input
          className="prompt-input"
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Ask about the stream… e.g. “report every passing event as it happens”"
          aria-label="Session prompt"
          disabled={disabled}
        />
        <button
          className="btn btn-primary"
          type="submit"
          disabled={disabled || value.trim().length === 0}
        >
          Ask
        </button>
      </form>
      {activePrompt ? (
        <p className="prompt-current">
          Session prompt: {activePrompt}
        </p>
      ) : null}
    </div>
  );
}
