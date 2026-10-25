import { translations, type UiLocale } from "../lib/i18n";
import { ThemeToggle } from "./ThemeToggle";

type SiteHeaderProps = {
  locale: UiLocale;
  onLocale: (locale: UiLocale) => void;
  active: "dashboard" | "about" | "docs";
};

export function SiteHeader({ locale, onLocale, active }: SiteHeaderProps) {
  const t = translations[locale];
  return (
    <nav className={`topbar site-header${active === "docs" ? " docs-topbar" : ""}`} aria-label="Primary">
      <a className="brand" href="/"><span className="brand-mark">Q</span><span>QuantData</span></a>
      <div className="primary-nav">
        <a href="/" aria-current={active === "dashboard" ? "page" : undefined}>{t.dashboard}</a>
        <a href="/about" aria-current={active === "about" ? "page" : undefined}>{t.about}</a>
        <a href={`/docs/${locale}`} aria-current={active === "docs" ? "page" : undefined}>{t.documentation}</a>
      </div>
      <div className="secondary-nav">
        <a href="/openapi.json">{t.apiContract}</a>
        <a href={`/docs/${locale}#mcp`}>{t.mcp}</a>
      </div>
      <div className="nav-actions">
        <ThemeToggle locale={locale} />
        <button className="lang-switch" type="button" onClick={() => onLocale(locale === "en" ? "zh-CN" : "en")} aria-label="Switch language">
          {locale === "en" ? "中文" : "EN"}
        </button>
      </div>
    </nav>
  );
}
