import { translations, type UiLocale } from "../lib/i18n";

export function SiteFooter({ locale }: { locale: UiLocale }) {
  const t = translations[locale];
  return (
    <footer>
      <div className="brand"><span className="brand-mark">Q</span><span>QuantData</span></div>
      <p>{t.disclaimer}</p>
      <div>
        <a href="/">{t.dashboard}</a>
        <a href="/about">{t.about}</a>
        <a href={`/docs/${locale}`}>{t.documentation}</a>
        <a href="/openapi.json">{t.apiContract}</a>
        <a href="/llms.txt">llms.txt</a>
        <a href="/llms-full.txt">llms-full.txt</a>
        <a href="https://github.com/McGeeLee/QuantData">GitHub</a>
      </div>
    </footer>
  );
}
