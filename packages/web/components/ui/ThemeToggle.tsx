"use client";

import { useEffect, useState } from "react";

type Theme = "dark" | "light" | "system";

function SunIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
    </svg>
  );
}

function SystemIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </svg>
  );
}

const THEMES: { value: Theme; icon: React.ReactNode; label: string }[] = [
  { value: "light",  icon: <SunIcon />,    label: "浅色" },
  { value: "dark",   icon: <MoonIcon />,   label: "深色" },
  { value: "system", icon: <SystemIcon />, label: "跟随系统" },
];

function applyTheme(theme: Theme) {
  const root = document.documentElement;
  if (theme === "system") {
    root.removeAttribute("data-theme");
  } else {
    root.setAttribute("data-theme", theme);
  }
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("dark");

  useEffect(() => {
    const saved = (localStorage.getItem("subgen-theme") as Theme) || "dark";
    setTheme(saved);
    applyTheme(saved);
  }, []);

  function handleChange(t: Theme) {
    setTheme(t);
    localStorage.setItem("subgen-theme", t);
    applyTheme(t);
  }

  return (
    <div className="inline-flex p-0.5 overflow-hidden"
      style={{ background: "var(--color-surface-2)", border: "0.5px solid var(--color-border-subtle)", borderRadius: "var(--radius-md)" }}>
      {THEMES.map((t) => (
        <button
          key={t.value}
          onClick={() => handleChange(t.value)}
          title={t.label}
          className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs transition-all duration-150"
          style={{
            borderRadius: "var(--radius-sm)",
            background: theme === t.value ? "var(--color-accent-muted)" : "transparent",
            color: theme === t.value ? "var(--color-accent)" : "var(--color-text-tertiary)",
            boxShadow: "none",
          }}>
          {t.icon}
          <span className="hidden sm:inline">{t.label}</span>
        </button>
      ))}
    </div>
  );
}
