import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { DataSource, MarketDataResponse, SourceStatus } from "../worker/domain/types";
import { AboutPage } from "./components/AboutPage";
import { SiteHeader } from "./components/SiteHeader";
import { SiteFooter } from "./components/SiteFooter";
import { ConnectionChecks } from "./components/ConnectionChecks";
import { DocsPage } from "./components/DocsPage";
import { MarketCharts } from "./components/MarketCharts";
import { ApiClientError, fetchMarketData, fetchSources } from "./lib/api";
import { describeError, detectLocale, localizeWarning, savePreference, translations, type UiLocale } from "./lib/i18n";
import { calculateSnapshot, formatNumber } from "./lib/market";
import { defaultDateRange } from "../worker/lib/dates";
import { normalizeMarketQuery } from "../worker/lib/query";

export default function App() {
  const path = window.location.pathname.replace(/\/+$/, "") || "/";
  const isAbout = path === "/about";
  const isDocs = path.startsWith("/docs/");
  const isDashboard = !isAbout && !isDocs;
  const docsLocale = path === "/docs/zh-CN"
    ? "zh-CN"
    : path === "/docs/en" ? "en" : undefined;
  const [locale, setLocaleState] = useState<UiLocale>(() => docsLocale ?? detectLocale());
  const [sources, setSources] = useState<SourceStatus[]>([]);
  const [source, setSource] = useState<DataSource>("tiingo");
  const [symbol, setSymbol] = useState("AAPL");
  const [start, setStart] = useState(() => defaultDateRange().start);
  const [end, setEnd] = useState(() => defaultDateRange().end);
  const [data, setData] = useState<MarketDataResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [sourcesError, setSourcesError] = useState<unknown>(null);
  const [sourcesLoading, setSourcesLoading] = useState(true);
  const [sourceAttempt, setSourceAttempt] = useState(0);
  const [requested, setRequested] = useState(false);
  const pending = useRef<AbortController | null>(null);
  const t = translations[locale];

  const setLocale = useCallback((next: UiLocale) => {
    setLocaleState(next);
    savePreference("quant-data-locale", next);
    document.documentElement.lang = next;
  }, []);

  useEffect(() => {
    document.documentElement.lang = locale;
    // An explicit documentation URL is also the language for the next page.
    if (docsLocale) savePreference("quant-data-locale", docsLocale);
    const skip = document.querySelector(".skip-link");
    if (skip) skip.textContent = translations[locale].skip;
    if (!isDashboard) return;
    const controller = new AbortController();
    void fetchSources(locale, controller.signal).then((items) => {
      if (controller.signal.aborted) return;
      setSources(items);
      setSourcesError(null);
    }).catch((cause: unknown) => {
      if (!controller.signal.aborted) setSourcesError(cause);
    }).finally(() => {
      if (!controller.signal.aborted) setSourcesLoading(false);
    });
    return () => controller.abort();
  }, [docsLocale, isDashboard, locale, sourceAttempt]);

  useEffect(() => () => pending.current?.abort(), []);

  const submit = useCallback(async (event?: FormEvent) => {
    event?.preventDefault();
    // The ref closes the gap before React disables the submit button.
    if (pending.current) return;
    setError(null);
    setData(null);
    setRequested(true);
    let query;
    try {
      query = normalizeMarketQuery({ source, symbol, start, end });
      if (sources.find((item) => item.id === source)?.configured === false) {
        throw new ApiClientError("SOURCE_NOT_CONFIGURED");
      }
    } catch (cause) {
      setError(cause);
      return;
    }
    const controller = new AbortController();
    pending.current = controller;
    setLoading(true);
    try {
      const result = await fetchMarketData({ ...query, lang: locale }, controller.signal);
      if (!controller.signal.aborted) setData(result);
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause);
    } finally {
      if (!controller.signal.aborted) setLoading(false);
      if (pending.current === controller) pending.current = null;
    }
  }, [end, locale, source, sources, start, symbol]);

  const selectedSource = sources.find((item) => item.id === source);
  const snapshot = useMemo(() => calculateSnapshot(data?.bars ?? []), [data]);
  if (isAbout) return <AboutPage locale={locale} onLocale={setLocale} />;

  if (isDocs) {
    return <DocsPage locale={locale} onLocale={(next) => {
      window.history.replaceState({}, "", `/docs/${next}`);
      setLocale(next);
    }} />;
  }

  return (
    <main id="main" className="dashboard-shell">
      <SiteHeader locale={locale} onLocale={setLocale} active="dashboard" />
      <header className="dashboard-heading">
        <h1>{t.dashboard}</h1>
        <p>{t.historical}</p>
      </header>

      <section id="dashboard" className="workspace">
        <aside className="control-panel">
          <form aria-label={t.marketQuery} onSubmit={submit} noValidate>
            <fieldset disabled={loading}>
            <label>{t.source}<select value={source} onChange={(event) => {
              const next = event.target.value as DataSource;
              setSource(next);
              const status = sources.find((item) => item.id === next);
              if (status?.symbolExamples[0]) setSymbol(status.symbolExamples[0]);
            }}><option value="yahoo">Yahoo Finance</option><option value="tushare">Tushare Pro</option><option value="tiingo">Tiingo</option></select></label>
            <label>{t.symbol}<input value={symbol} onChange={(event) => setSymbol(event.target.value)} maxLength={40} autoCapitalize="characters" required /><small>{t.examples}: {selectedSource?.symbolExamples.join(" · ") ?? "AAPL"}</small></label>
            <div className="date-row"><label>{t.start}<input type="date" value={start} max={end} onChange={(event) => setStart(event.target.value)} required /></label><label>{t.end}<input type="date" value={end} min={start} onChange={(event) => setEnd(event.target.value)} required /></label></div>
            </fieldset>
            <button className="primary-button" type="submit" disabled={loading}>{loading ? t.loading : t.fetch}<span>↗</span></button>
          </form>
          <div className="source-feedback">
            {sourcesLoading && <p className="source-message" role="status">{t.sourcesLoading}</p>}
            {sourcesError != null && <div className="source-message" role="status"><p>{t.sourcesFailed} {describeError(sourcesError, locale)}</p><button type="button" className="retry-button" disabled={sourcesLoading} onClick={() => { setSourcesLoading(true); setSourceAttempt((attempt) => attempt + 1); }}>{t.retry}</button></div>}
          </div>
          <details className="source-details">
            <summary>{t.sourceDetails}</summary>
            <div className="source-status">
              <ConnectionChecks sources={sources} locale={locale} />
              <p className="source-message">{t.sourceNote}</p>
            </div>
          </details>
        </aside>

        <div className="results" aria-live="polite" aria-busy={loading}>
          {error != null && <div className="error-state" role="alert"><b>{t.requestFailed}</b><p>{describeError(error, locale)}</p></div>}
          {error == null && !snapshot && <div className="empty-state" role="status">{loading ? t.loading : requested ? t.noData : t.initial}</div>}
          {data && snapshot && <>
            <div className="result-header"><div><span className="source-badge">{data.meta.source}</span><h2>{data.meta.symbol}</h2><p>{snapshot.date} · {data.meta.count} {t.bars}</p></div><div className="warning-chip">{t.nativePrices} · {data.meta.interval}</div></div>
            <div className="data-freshness">
              <strong>{t.historical}</strong>
              <dl>
                <div><dt>{t.latestBar}</dt><dd>{data.meta.latestBarDate}</dd></div>
                <div><dt>{t.fetchedAt}</dt><dd><time dateTime={data.meta.fetchedAt}>{data.meta.fetchedAt.replace("T", " ").replace(/\.\d+Z$/, " UTC")}</time></dd></div>
                <div><dt>{data.meta.cache.status === "hit" ? t.cacheHit : data.meta.cache.status === "miss" ? t.cacheMiss : t.cacheUnavailable}</dt><dd>{t.cacheAge}: {data.meta.cache.ageSeconds} {t.seconds} · {t.cacheTtl}: {data.meta.cache.ttlSeconds} {t.seconds}</dd></div>
              </dl>
              <p>{t.freshnessNote}</p>
              <p>{t.priceBasis}</p>
              {data.meta.truncated && <p>{t.truncated}</p>}
            </div>
            <div className="metric-grid">
              <article><span>{t.latestClose}</span><strong>{formatNumber(snapshot.close, 4, locale)}</strong><small>{snapshot.date}</small></article>
              <article><span>{t.change}</span><strong className={(snapshot.change ?? 0) >= 0 ? "positive" : "negative"}>{snapshot.change === null ? "—" : `${snapshot.change >= 0 ? "+" : ""}${formatNumber(snapshot.change, 4, locale)}`}</strong><small>{t.previousClose}</small></article>
              <article><span>{t.changePercent}</span><strong className={(snapshot.changePercent ?? 0) >= 0 ? "positive" : "negative"}>{snapshot.changePercent === null ? "—" : `${snapshot.changePercent >= 0 ? "+" : ""}${formatNumber(snapshot.changePercent, 2, locale)}%`}</strong><small>1D</small></article>
              <article><span>{t.volume}</span><strong>{formatNumber(snapshot.volume, 0, locale)}</strong><small>{data.meta.source === "tushare" ? t.lots : t.providerUnits}</small></article>
            </div>
            <MarketCharts bars={data.bars} labels={{ candles: t.candlestick, close: t.closeHistory, returns: t.dailyReturns, bars: t.bars }} />
            <div className="data-notes">{data.meta.warnings.map((warning) => <p key={warning}>• {localizeWarning(warning, locale)}</p>)}{data.meta.attribution && <p>• {data.meta.attribution}</p>}</div>
          </>}
        </div>
      </section>

      <SiteFooter locale={locale} />
    </main>
  );
}
