"use client";

interface Option {
  code: string;
  label: string;
  flag: string;
}

interface LanguageSelectProps {
  label: string;
  value: string;
  onChange: (val: string) => void;
  options: Option[];
}

export function LanguageSelect({ label, value, onChange, options }: LanguageSelectProps) {
  const selected = options.find((o) => o.code === value);

  return (
    <div>
      <label
        className="block text-xs font-medium mb-1.5"
        style={{ color: "var(--color-text-tertiary)" }}
      >
        {label}
      </label>
      <div className="relative">
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-full appearance-none rounded-[var(--radius-md)] pl-3 pr-8 py-2.5 text-sm transition-colors"
          style={{
            background: "var(--color-surface-2)",
            border: "1px solid var(--color-border-subtle)",
            color: "var(--color-text-primary)",
            cursor: "pointer",
          }}
        >
          {options.map((opt) => (
            <option key={opt.code} value={opt.code}>
              {opt.flag} {opt.label}
            </option>
          ))}
        </select>
        <div
          className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M2 4l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </div>
      </div>
    </div>
  );
}
