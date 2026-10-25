import { useEffect, useRef, useState } from "react";
import type { ConnectionCheck } from "../../worker/domain/connectivity";
import type { SourceStatus } from "../../worker/domain/types";
import { ApiClientError, checkSourceConnection } from "../lib/api";
import { describeError, translations, type UiLocale } from "../lib/i18n";

function utcTime(value: string): string {
  return new Date(value).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
}

const statusLabels = {
  ok: "checkOk",
  not_configured: "checkNotConfigured",
  access_denied: "checkAccessDenied",
  rate_limited: "checkRateLimited",
  timeout: "checkTimeout",
  network_error: "checkNetworkError",
  no_data: "checkNoData",
  upstream_error: "checkUpstreamError",
  quota_exceeded: "quotaExceeded",
  quota_unavailable: "quotaUnavailable",
} as const;

function ConnectionCard({ source, locale }: { source: SourceStatus; locale: UiLocale }) {
  const t = translations[locale];
  const [result, setResult] = useState<ConnectionCheck | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const [retryAt, setRetryAt] = useState(0);
  const [now, setNow] = useState(Date.now);
  const pending = useRef<AbortController | null>(null);
  const cooldownUntil = result ? Date.parse(result.nextCheckAt) : retryAt;
  const coolingDown = cooldownUntil > now;
  const quotaPaused = result?.status === "quota_exceeded" || result?.status === "quota_unavailable";
  const statusClass = !source.configured || result?.status === "not_configured" ? "missing"
    : quotaPaused ? "" : result?.status === "ok" ? "ready" : result ? "failed" : "";

  useEffect(() => () => pending.current?.abort(), []);

  // Only refresh the enabled state when the cooldown ends. Never issue a timed request.
  useEffect(() => {
    if (!coolingDown) return;
    const delay = Math.min(Math.max(0, cooldownUntil - Date.now() + 50), 2_147_483_647);
    const timer = setTimeout(() => setNow(Date.now()), delay);
    return () => clearTimeout(timer);
  }, [cooldownUntil, coolingDown, now]);

  async function check() {
    if (pending.current || !source.configured || cooldownUntil > Date.now()) return;
    const controller = new AbortController();
    pending.current = controller;
    setLoading(true);
    setError(null);
    setResult(null);
    setRetryAt(0);
    try {
      const next = await checkSourceConnection(source.id, locale, controller.signal);
      if (!controller.signal.aborted) {
        setResult(next);
        setNow(Date.now());
      }
    } catch (cause) {
      if (!controller.signal.aborted) {
        setError(cause);
        setNow(Date.now());
        if (cause instanceof ApiClientError && cause.retryAfterSeconds !== undefined) {
          setRetryAt(Date.now() + cause.retryAfterSeconds * 1_000);
        }
      }
    } finally {
      if (!controller.signal.aborted) setLoading(false);
      if (pending.current === controller) pending.current = null;
    }
  }

  return (
    <article className="connection-card" data-source={source.id}>
      <div className="source-row"><span className={`status-dot ${statusClass}`} aria-hidden="true" /><div><b>{source.name}</b><small>{source.configured ? t.configured : t.unavailable}{!source.official ? ` · ${t.unofficial}` : ""}</small></div></div>
      <button type="button" className="connection-button" disabled={loading || !source.configured || coolingDown}
        aria-label={`${t.checkConnection}${locale === "zh-CN" ? "：" : ": "}${source.name}`} onClick={check}>
        {loading ? t.checkingConnection : t.checkConnection}
      </button>
      {!source.configured && <p className="source-message">{t.checkNoSecret}</p>}
      {source.configured && !result && error == null && !loading && <p className="source-message">{t.connectionUnchecked}</p>}
      <div aria-live="polite" aria-busy={loading}>
        {loading && <p className="source-message" role="status">{t.checkingConnection}</p>}
        {error != null && <p className="connection-error" role="status" data-error={error instanceof ApiClientError ? error.code : "NETWORK_ERROR"}>{describeError(error, locale)}</p>}
        {result && <div className="connection-result" role="status" data-status={result.status}>
          <p className="connection-outcome">{t[statusLabels[result.status]]}</p>
          {quotaPaused && <p>{t.quotaCheckSkipped}</p>}
          {result.cached && <p className="connection-reused">{t.checkReused}</p>}
          <dl>
            <div><dt>{t.checkTime}</dt><dd><time dateTime={result.checkedAt}>{utcTime(result.checkedAt)}</time></dd></div>
            <div><dt>{t.checkDuration}</dt><dd>{result.durationMs} ms</dd></div>
            <div><dt>{t.checkSample}</dt><dd>{result.sample.symbol} · {result.sample.start} → {result.sample.end}</dd></div>
            {result.sample.barCount !== undefined && <div><dt>{t.checkBarCount}</dt><dd>{result.sample.barCount}</dd></div>}
            {result.sample.latestBarDate && <div><dt>{t.checkLatestBar}</dt><dd>{result.sample.latestBarDate}</dd></div>}
            {result.error?.upstreamStatus !== undefined && <div><dt>{t.checkUpstreamHttp}</dt><dd>{result.error.upstreamStatus}</dd></div>}
            {result.error?.providerCode !== undefined && <div><dt>{t.checkProviderCode}</dt><dd>{result.error.providerCode}</dd></div>}
            <div><dt>{t.checkRequestId}</dt><dd>{result.requestId}</dd></div>
          </dl>
        </div>}
        {coolingDown && <p className="connection-cooldown">{t.checkNext}: <time dateTime={new Date(cooldownUntil).toISOString()}>{utcTime(new Date(cooldownUntil).toISOString())}</time></p>}
      </div>
    </article>
  );
}

export function ConnectionChecks({ sources, locale }: { sources: SourceStatus[]; locale: UiLocale }) {
  const t = translations[locale];
  return <section className="connection-checks" aria-label={t.connectionChecks}>
    <h4>{t.connectionChecks}</h4>
    <p className="source-message">{t.connectionNote}</p>
    <div className="source-message" data-testid="quota-protection-note">
      <p><b>{t.quotaProtectionTitle}</b> · {t.quotaProtectionScope}</p>
      <p>{t.quotaCheckCost}</p>
      <p>{t.quotaProtectionThreshold} <a href={`/docs/${locale}#quota-protection`}><u>{t.quotaProtectionDocs}</u></a></p>
    </div>
    {sources.map((source) => <ConnectionCard key={source.id} source={source} locale={locale} />)}
  </section>;
}
