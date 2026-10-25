import { useEffect, useState } from "react";
import {
  CandlestickSeries,
  ColorType,
  HistogramSeries,
  LineSeries,
  createChart,
} from "lightweight-charts";
import type { MarketBar } from "../../worker/domain/types";
import { chartData } from "../lib/market";

type Props = { bars: MarketBar[]; labels: { candles: string; close: string; returns: string; bars: string } };

function useResponsiveChart(container: HTMLDivElement | null, bars: MarketBar[], kind: "candles" | "close" | "returns", dark: boolean) {
  useEffect(() => {
    if (!container || bars.length === 0) return;
    const colors = dark
      ? { background: "#20251f", text: "#a8aaa0", grid: "#353b34", border: "#596057", crosshair: "#ff9a7f", up: "#ff7957", down: "#7fc093" }
      : { background: "#fffdf8", text: "#5c5b52", grid: "#eee8dc", border: "#d9d0c0", crosshair: "#8e5f4c", up: "#e55b39", down: "#238674" };
    const chart = createChart(container, {
      width: container.clientWidth,
      height: kind === "candles" ? 390 : 230,
      layout: { background: { type: ColorType.Solid, color: colors.background }, textColor: colors.text },
      grid: { vertLines: { color: colors.grid }, horzLines: { color: colors.grid } },
      rightPriceScale: { borderColor: colors.border },
      timeScale: { borderColor: colors.border, timeVisible: false },
      crosshair: { vertLine: { color: colors.crosshair }, horzLine: { color: colors.crosshair } },
    });
    const data = chartData(bars);
    if (kind === "candles") {
      const candles = chart.addSeries(CandlestickSeries, {
        upColor: colors.up,
        downColor: colors.down,
        wickUpColor: colors.up,
        wickDownColor: colors.down,
        borderVisible: false,
      });
      candles.setData(data.candles);
      const volumes = chart.addSeries(HistogramSeries, { priceFormat: { type: "volume" }, priceScaleId: "volume" });
      volumes.priceScale().applyOptions({ scaleMargins: { top: 0.78, bottom: 0 } });
      volumes.setData(data.volume);
    } else if (kind === "close") {
      const line = chart.addSeries(LineSeries, { color: colors.up, lineWidth: 2 });
      line.setData(data.closes);
    } else {
      const returns = chart.addSeries(HistogramSeries, { priceFormat: { type: "price", precision: 2, minMove: 0.01 } });
      returns.setData(data.returns);
    }
    chart.timeScale().fitContent();
    const observer = new ResizeObserver(() => chart.applyOptions({ width: container.clientWidth }));
    observer.observe(container);
    return () => {
      observer.disconnect();
      chart.remove();
    };
  }, [container, bars, kind, dark]);
}

function Chart({ bars, label, barsLabel, kind, dark }: { bars: MarketBar[]; label: string; barsLabel: string; kind: "candles" | "close" | "returns"; dark: boolean }) {
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  useResponsiveChart(container, bars, kind, dark);
  return (
    <section className={`chart-card ${kind === "candles" ? "chart-card--wide" : ""}`} aria-label={label}>
      <div className="chart-title"><h3>{label}</h3><span>{bars.length} {barsLabel}</span></div>
      <div ref={setContainer} className="chart" role="img" aria-label={`${label}, ${bars.length} ${barsLabel}`} />
    </section>
  );
}

export function MarketCharts({ bars, labels }: Props) {
  const [dark, setDark] = useState(() => document.documentElement.dataset.theme === "dark");

  useEffect(() => {
    const update = () => setDark(document.documentElement.dataset.theme === "dark");
    window.addEventListener("themechange", update);
    return () => window.removeEventListener("themechange", update);
  }, []);

  return (
    <div className="chart-grid">
      <Chart bars={bars} label={labels.candles} kind="candles" dark={dark} barsLabel={labels.bars} />
      <Chart bars={bars} label={labels.close} kind="close" dark={dark} barsLabel={labels.bars} />
      <Chart bars={bars} label={labels.returns} kind="returns" dark={dark} barsLabel={labels.bars} />
    </div>
  );
}
