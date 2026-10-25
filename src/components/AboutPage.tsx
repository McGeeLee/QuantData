import { defaultDateRange } from "../../worker/lib/dates";
import { translations, type UiLocale } from "../lib/i18n";
import { CopyButton } from "./CopyButton";
import { SiteHeader } from "./SiteHeader";
import { SiteFooter } from "./SiteFooter";

export function AboutPage({ locale, onLocale }: { locale: UiLocale; onLocale: (locale: UiLocale) => void }) {
  const t = translations[locale];
  const range = defaultDateRange();
  const apiExample = `curl '${window.location.origin}/api/v1/market-data?${new URLSearchParams({ source: "yahoo", symbol: "AAPL", ...range, lang: locale }).toString()}'`;
  const mcpUrl = `${window.location.origin}/mcp`;

  return <main id="main" className="about-shell">
    <SiteHeader locale={locale} onLocale={onLocale} active="about" />
    <header className="hero">
      <div className="hero-copy">
        <span className="eyebrow">CLOUDFLARE EDGE · API + MCP</span>
        <h1>{t.tagline}</h1>
        <p>{t.subtitle}</p>
        <a className="primary-button about-cta" href="/">{t.openDashboard}<span aria-hidden="true">↗</span></a>
        <div className="hero-pills"><span>{t.publicApi}</span><span>{t.cache}</span><span>{t.raw}</span></div>
      </div>
      <div className="hero-art" aria-hidden="true"><div className="orb orb-one"/><div className="orb orb-two"/><div className="signal-line">∿</div><span>1D</span></div>
    </header>

    <section className="about-features" aria-label={t.overview}>
      <article><span className="eyebrow">01 · {t.dashboard}</span><h2>{t.aboutDashboardTitle}</h2><p>{t.aboutDashboardBody}</p><a href="/">{t.openDashboard} →</a></article>
      <article><span className="eyebrow">02 · REST + OPENAPI</span><h2>{t.rest}</h2><p>{t.aboutApiBody}</p><a href={`/docs/${locale}`}>{t.documentation} →</a></article>
      <article><span className="eyebrow">03 · MCP</span><h2>{t.mcpTools}</h2><p>{t.aboutMcpBody}</p><a href={`/docs/${locale}#mcp`}>{t.documentation} →</a></article>
    </section>

    <section className="developer-section">
      <div className="section-heading"><span className="step">↗</span><div><h2>{t.integrationTitle}</h2><p>REST · OpenAPI 3.1 · Streamable HTTP MCP</p></div></div>
      <div className="code-grid">
        <article><div><span>{t.apiExample}</span><CopyButton value={apiExample} label={t.copy} copiedLabel={t.copied} failedLabel={t.copyFailed} /></div><pre><code>{apiExample}</code></pre></article>
        <article><div><span>{t.mcpExample}</span><CopyButton value={mcpUrl} label={t.copy} copiedLabel={t.copied} failedLabel={t.copyFailed} /></div><pre><code>{mcpUrl}</code></pre></article>
      </div>
      <p className="about-data-note">{t.priceBasis}</p>
    </section>
    <SiteFooter locale={locale} />
  </main>;
}
