import { useEffect, useState } from "react";
import { savePreference } from "../lib/i18n";

type Theme = "light" | "dark";

const storageKey = "mcgeelee-theme";

function currentTheme(): Theme {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute(
    "content",
    theme === "dark" ? "#141713" : "#fbf7ef",
  );
  window.dispatchEvent(new CustomEvent("themechange", { detail: theme }));
}

export function ThemeToggle({ locale }: { locale: "en" | "zh-CN" }) {
  const [theme, setTheme] = useState<Theme>(() => currentTheme());

  useEffect(() => applyTheme(theme), [theme]);

  const nextTheme = theme === "dark" ? "light" : "dark";
  const label = locale === "zh-CN"
    ? `切换到${nextTheme === "dark" ? "夜间" : "日间"}模式`
    : `Switch to ${nextTheme} mode`;

  return (
    <button
      className="theme-switch"
      type="button"
      aria-label={label}
      title={label}
      onClick={() => {
        setTheme(nextTheme);
        savePreference(storageKey, nextTheme);
      }}
    >
      <span aria-hidden="true">{theme === "dark" ? "☀" : "☾"}</span>
    </button>
  );
}
