import { useMemo } from 'react';
import { formatJpy } from '../lib/format';
import {
  SOURCES,
  type FxRates,
  type TcgCardHistory,
  type WatchSnapshot,
} from '../types/market';

interface Props {
  snapshots: WatchSnapshot[];
  tcg: TcgCardHistory | undefined;
  cardId: string;
  rates: FxRates;
}

const W = 720;
const H = 260;
const PAD = { top: 12, right: 16, bottom: 26, left: 64 };
const DAY_MS = 86400000;

/**
 * TCGplayerマーケットプライス履歴（週次/日次・最大1年）と、日次スナップショットの
 * 4ソース価格を同じ時間軸に重ね描きするSVG折れ線チャート（JPY換算）。
 * X軸はスナップショットと違い「日付の実位置」でプロットする（TCG履歴は週次期間があるため）。
 */
export function MarketChart({ snapshots, tcg, cardId, rates }: Props) {
  const { series, maxY, minT, maxT } = useMemo(() => {
    const toJpy = (value: number | null, currency: string): number | null => {
      if (value == null) return null;
      if (currency === 'USD') return value * rates.usdJpy;
      if (currency === 'EUR') return value * rates.eurJpy;
      return value;
    };
    const t = (date: string) => new Date(`${date}T00:00:00Z`).getTime();

    // スナップショット由来のソース（TCGはスナップショットではなく密な履歴を使う）
    const series = SOURCES.filter((s) => s.key !== 'tp').map((src) => ({
      src,
      points: snapshots
        .map((s) => {
          const v = s.prices[cardId]?.[src.tupleIndex] ?? null;
          return v == null ? null : { t: t(s.date), v: toJpy(v, src.currency)!, date: s.date };
        })
        .filter((p): p is { t: number; v: number; date: string } => p != null),
    }));

    // TCGplayer マーケットプライス履歴（密）
    const tpSrc = SOURCES.find((s) => s.key === 'tp')!;
    const tpPoints = Object.entries(tcg?.buckets ?? {})
      .map(([date, [price, qty]]) => ({ t: t(date), v: toJpy(price, 'USD')!, date, qty }))
      .sort((a, b) => a.t - b.t);
    series.push({ src: tpSrc, points: tpPoints });

    let maxY = 0;
    let minT = Infinity;
    let maxT = -Infinity;
    for (const s of series) {
      for (const p of s.points) {
        if (p.v > maxY) maxY = p.v;
        if (p.t < minT) minT = p.t;
        if (p.t > maxT) maxT = p.t;
      }
    }
    return { series, maxY, minT, maxT };
  }, [snapshots, tcg, cardId, rates]);

  if (maxY === 0) {
    return <p className="chart-empty">このカードの価格履歴はまだありません。</p>;
  }

  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const span = Math.max(maxT - minT, DAY_MS);
  const x = (t: number) => PAD.left + ((t - minT) / span) * plotW;
  const y = (v: number) => PAD.top + plotH - (v / (maxY * 1.08)) * plotH;

  const gridLines = [0.25, 0.5, 0.75, 1].map((r) => maxY * 1.08 * r);

  // X軸ラベル: 始点・中間・終点
  const fmtDate = (t: number) => {
    const d = new Date(t);
    return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
  };
  const xLabels =
    maxT > minT
      ? [minT, minT + span / 2, maxT].map((t, i) => ({
          t,
          anchor: i === 0 ? 'start' : i === 2 ? 'end' : 'middle',
        }))
      : [{ t: minT, anchor: 'middle' }];

  return (
    <div className="price-chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="価格履歴チャート">
        {gridLines.map((v) => (
          <g key={v}>
            <line
              x1={PAD.left}
              x2={W - PAD.right}
              y1={y(v)}
              y2={y(v)}
              stroke="var(--border)"
              strokeDasharray="3 3"
            />
            <text x={PAD.left - 6} y={y(v) + 4} textAnchor="end" className="chart-axis-text">
              {formatJpy(v)}
            </text>
          </g>
        ))}
        <line
          x1={PAD.left}
          x2={W - PAD.right}
          y1={PAD.top + plotH}
          y2={PAD.top + plotH}
          stroke="var(--border)"
        />
        {xLabels.map(({ t, anchor }) => (
          <text
            key={t}
            x={x(t)}
            y={H - 8}
            textAnchor={anchor as 'start' | 'middle' | 'end'}
            className="chart-axis-text"
          >
            {fmtDate(t)}
          </text>
        ))}
        {series.map(({ src, points }) => {
          if (points.length === 0) return null;
          const pts = points.map((p) => `${x(p.t)},${y(p.v)}`).join(' ');
          return (
            <g key={src.key}>
              <polyline
                points={pts}
                fill="none"
                stroke={src.color}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeDasharray={src.dashed ? '6 4' : undefined}
              />
              {points.length <= 80 &&
                points.map((p) => (
                  <circle key={p.t} cx={x(p.t)} cy={y(p.v)} r={2.6} fill={src.color}>
                    <title>
                      {`${p.date} ${src.label}: ${formatJpy(p.v)}`}
                      {'qty' in p && (p as { qty?: number }).qty ? ` (販売${(p as { qty?: number }).qty}枚)` : ''}
                    </title>
                  </circle>
                ))}
            </g>
          );
        })}
      </svg>
      <div className="chart-legend">
        {series.map(({ src, points }) => {
          const last = points.length > 0 ? points[points.length - 1].v : null;
          return (
            <span key={src.key} className="chart-legend__item">
              <span className="chart-legend__swatch" style={{ background: src.color }} />
              {src.label}
              {last != null && <strong>{formatJpy(last)}</strong>}
            </span>
          );
        })}
      </div>
      <p className="chart-note">
        TCGplayer市場はマーケットプライス（過去1年は週次、追跡開始後は日次で蓄積
        {tcg?.condition && tcg.condition !== 'Near Mint' && `・状態 ${tcg.condition}`}
        ）。他ソースは追跡開始日からの日次記録です。USD/EURは現在のレート（$=
        {Math.round(rates.usdJpy)}円 / €={Math.round(rates.eurJpy)}円）で円換算しています
        {rates.approximate && '（為替API取得失敗のため概算値）'}。
      </p>
    </div>
  );
}
