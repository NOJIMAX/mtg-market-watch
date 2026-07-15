import { Fragment, useEffect, useMemo, useState } from 'react';
import './App.css';
import { MarketChart } from './components/MarketChart';
import { formatJpy, formatPct, formatUsd } from './lib/format';
import {
  FALLBACK_RATES,
  SOURCES,
  type FxRates,
  type SourceDef,
  type TcgHistoryMap,
  type WatchCard,
  type WatchCatalog,
  type WatchHistory,
  type WatchSortKey,
} from './types/market';

function formatEur(value: number): string {
  const abs = Math.abs(value).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return value < 0 ? `-€${abs}` : `€${abs}`;
}

function formatNative(value: number, currency: SourceDef['currency']): string {
  if (currency === 'JPY') return formatJpy(value);
  if (currency === 'USD') return formatUsd(value);
  return formatEur(value);
}

function toJpy(value: number, currency: SourceDef['currency'], rates: FxRates): number {
  if (currency === 'USD') return value * rates.usdJpy;
  if (currency === 'EUR') return value * rates.eurJpy;
  return value;
}

/** 為替レートを取得（1リクエストで JPY / EUR 両方取れる） */
async function fetchRates(): Promise<FxRates> {
  const res = await fetch('https://open.er-api.com/v6/latest/USD');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = (await res.json()) as { result?: string; rates?: Record<string, number> };
  const jpy = json.rates?.JPY;
  const eur = json.rates?.EUR;
  if (json.result !== 'success' || !jpy || !eur) throw new Error('為替APIのレスポンスが不正です');
  return { usdJpy: jpy, eurJpy: jpy / eur, approximate: false };
}

function getPrice(card: WatchCard, key: SourceDef['key']): number | null {
  switch (key) {
    case 'hyBuy':
      return card.hyBuyJpy;
    case 'hy':
      return card.hyJpy ?? null;
    case 'ck':
      return card.ckUsd ?? null;
    case 'tp':
      return card.tpMarketUsd ?? null;
    case 'cm':
      return card.cmEur ?? null;
  }
}

interface ChangeInfo {
  pct: number;
  prevDate: string;
}

/** 最新スナップショットとその1つ前を比較した変化率（ソース別・カード別） */
function buildChanges(history: WatchHistory | null): Map<string, (ChangeInfo | null)[]> {
  const map = new Map<string, (ChangeInfo | null)[]>();
  if (!history || history.snapshots.length < 2) return map;
  const latest = history.snapshots[history.snapshots.length - 1];
  const prev = history.snapshots[history.snapshots.length - 2];
  for (const [id, cur] of Object.entries(latest.prices)) {
    const before = prev.prices[id];
    if (!before) continue;
    const changes = SOURCES.map((src) => {
      const a = before[src.tupleIndex];
      const b = cur[src.tupleIndex];
      if (a == null || b == null || a === 0) return null;
      return { pct: (b - a) / a, prevDate: prev.date };
    });
    map.set(id, changes);
  }
  return map;
}

/** TCGplayerマーケットプライスの変化率（最新値 vs 指定日数前に最も近い過去バケット） */
function tcgChange(tcg: TcgHistoryMap, id: string, days: number): ChangeInfo | null {
  const buckets = tcg[id]?.buckets;
  if (!buckets) return null;
  const dates = Object.keys(buckets).sort();
  if (dates.length < 2) return null;
  const latest = dates[dates.length - 1];
  const target = new Date(`${latest}T00:00:00Z`).getTime() - days * 86400000;
  let prevDate: string | null = null;
  for (const d of dates) {
    if (new Date(`${d}T00:00:00Z`).getTime() <= target) prevDate = d;
    else break;
  }
  if (!prevDate) return null;
  const a = buckets[prevDate][0];
  const b = buckets[latest][0];
  if (!a) return null;
  return { pct: (b - a) / a, prevDate };
}

/** 一度に描画する最大行数 */
const MAX_ROWS = 500;

/** 急上昇ピックアップの対象とする90日上昇率のしきい値 */
const SURGE_MIN_PCT = 0.15;
/** 急上昇ピックアップの最大表示枚数 */
const SURGE_MAX = 12;

export default function App() {
  const [catalog, setCatalog] = useState<WatchCatalog | null>(null);
  const [history, setHistory] = useState<WatchHistory | null>(null);
  const [tcg, setTcg] = useState<TcgHistoryMap>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [rates, setRates] = useState<FxRates>(FALLBACK_RATES);
  const [searchText, setSearchText] = useState('');
  const [activeOnly, setActiveOnly] = useState(false);
  const [foilFilter, setFoilFilter] = useState<'all' | 'foil' | 'nonfoil'>('all');
  /** 空文字 = 全セット */
  const [setFilter, setSetFilter] = useState('');
  const [sortKey, setSortKey] = useState<WatchSortKey>('netProfit');
  const [showJpy, setShowJpy] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const base = import.meta.env.BASE_URL;
        const bust = `?t=${Date.now()}`;
        const [cardsRes, historyRes, tcgRes] = await Promise.all([
          fetch(`${base}data/cards.json${bust}`),
          fetch(`${base}data/history.json${bust}`),
          fetch(`${base}data/tcg-history.json${bust}`),
        ]);
        const parseJson = async <T,>(res: Response, name: string): Promise<T> => {
          if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) {
            throw new Error(`価格データファイル (public/data/${name}) が見つかりません。`);
          }
          return (await res.json()) as T;
        };
        setCatalog(await parseJson<WatchCatalog>(cardsRes, 'cards.json'));
        setHistory(await parseJson<WatchHistory>(historyRes, 'history.json'));
        setTcg(await parseJson<TcgHistoryMap>(tcgRes, 'tcg-history.json'));
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : '価格データの読み込みに失敗しました。');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchRates()
      .then((r) => {
        if (!cancelled) setRates(r);
      })
      .catch(() => {
        // 失敗時は FALLBACK_RATES のまま（approximate 表示になる）
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const changes = useMemo(() => buildChanges(history), [history]);

  /** 追跡中カードに存在するセットの選択肢（枚数の多い順） */
  const setOptions = useMemo(() => {
    if (!catalog) return [];
    const bySet = new Map<string, { code: string; name: string; count: number }>();
    for (const c of catalog.cards) {
      const entry = bySet.get(c.set) ?? { code: c.set, name: c.setName, count: 0 };
      entry.count++;
      bySet.set(c.set, entry);
    }
    return [...bySet.values()].sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
  }, [catalog]);

  /** TCG市場価格が90日で SURGE_MIN_PCT 以上上昇しているカード（上昇率の降順） */
  const surges = useMemo(() => {
    if (!catalog) return [];
    return catalog.cards
      .flatMap((card) => {
        const ch = tcgChange(tcg, card.id, 90);
        return ch != null && ch.pct >= SURGE_MIN_PCT ? [{ card, change: ch }] : [];
      })
      .sort((a, b) => b.change.pct - a.change.pct);
  }, [catalog, tcg]);

  /** 急上昇チップのクリック: フィルタを解除してその行を展開・スクロール */
  const jumpToCard = (id: string) => {
    setSearchText('');
    setActiveOnly(false);
    setFoilFilter('all');
    setSetFilter('');
    setExpandedId(id);
    // フィルタ解除後の再描画を待ってからスクロールする
    requestAnimationFrame(() => {
      document.getElementById(`row-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  };

  const rows = useMemo(() => {
    if (!catalog) return [];
    const search = searchText.trim().toLowerCase();
    const filtered = catalog.cards.filter((c) => {
      if (activeOnly && !c.active && !c.watchSet) return false;
      if (foilFilter !== 'all' && (c.finish !== 'nonfoil') !== (foilFilter === 'foil')) return false;
      if (setFilter && c.set !== setFilter) return false;
      if (search && !`${c.name} ${c.setName} ${c.set}`.toLowerCase().includes(search)) return false;
      return true;
    });
    const sorted = [...filtered];
    const desc = (fn: (c: WatchCard) => number | null) => {
      sorted.sort((a, b) => {
        const va = fn(a);
        const vb = fn(b);
        if (va == null && vb == null) return 0;
        if (va == null) return 1;
        if (vb == null) return -1;
        return vb - va;
      });
    };
    switch (sortKey) {
      case 'name':
        sorted.sort((a, b) => a.name.localeCompare(b.name));
        break;
      case 'netProfit':
        desc((c) => c.netProfitJpy);
        break;
      case 'hyBuyPrice':
        desc((c) => c.hyBuyJpy);
        break;
      case 'tpPrice':
        desc((c) => c.tpMarketUsd ?? null);
        break;
      case 'tpChange7d':
        desc((c) => {
          const ch = tcgChange(tcg, c.id, 7);
          return ch == null ? null : Math.abs(ch.pct);
        });
        break;
      case 'tpChange30d':
        desc((c) => {
          const ch = tcgChange(tcg, c.id, 30);
          return ch == null ? null : Math.abs(ch.pct);
        });
        break;
      case 'tpChange90d':
        // 急上昇の把握用なので絶対値ではなく上昇率そのままの降順（下落は下位に沈む）
        desc((c) => tcgChange(tcg, c.id, 90)?.pct ?? null);
        break;
      case 'spread':
        // 販売系ソース間の差額（円換算した最高値 − 最安値）
        desc((c) => {
          const vals = SOURCES.filter((s) => s.key !== 'hyBuy').flatMap((s) => {
            const v = getPrice(c, s.key);
            return v == null ? [] : [toJpy(v, s.currency, rates)];
          });
          return vals.length < 2 ? null : Math.max(...vals) - Math.min(...vals);
        });
        break;
    }
    return sorted;
  }, [catalog, searchText, activeOnly, foilFilter, setFilter, sortKey, tcg, rates]);

  if (loading) {
    return (
      <div className="app">
        <PageHeader />
        <section className="panel">
          <p className="data-status__loading">価格データを読み込み中...</p>
        </section>
      </div>
    );
  }

  if (loadError || !catalog) {
    return (
      <div className="app">
        <PageHeader />
        <section className="panel panel--error">
          <h2 className="panel__title">価格データ</h2>
          <p className="data-status__error">{loadError ?? 'データがありません。'}</p>
          <p className="data-status__hint">
            初回またはデータ未生成の場合は、ターミナルで <code>npm run update</code>{' '}
            を実行して価格データを取得してください。
          </p>
        </section>
      </div>
    );
  }

  const updated = new Date(catalog.updatedAt);
  const isStale = Date.now() - updated.getTime() > 36 * 3600000;
  const s = catalog.settings;

  return (
    <div className="app">
      <PageHeader />

      <section className="panel">
        <h2 className="panel__title">
          追跡データ（1日1回自動更新・{catalog.snapshotCount}日分の履歴）
        </h2>
        <div className="data-status">
          <span className={`data-status__badge${isStale ? ' data-status__badge--stale' : ''}`}>
            最終更新: {updated.toLocaleString('ja-JP')}
            {isStale && '（データが古い可能性があります）'}
          </span>
          <span className="data-status__counts">
            追跡 {catalog.counts.cards}枚（ヒット中 {catalog.counts.active}枚
            {(catalog.counts.watchSet ?? 0) > 0 && `・セット監視 ${catalog.counts.watchSet}枚`}）/
            TCG履歴{' '}
            {catalog.counts.tcgplayer}枚 / 晴れる屋在庫 {catalog.counts.hareruya}枚 / CK{' '}
            {catalog.counts.cardKingdom}枚 / CM {catalog.counts.cardmarket}枚
          </span>
          <span className="data-status__counts">
            ヒット条件: 実質利益 ¥{s.minProfitJpy.toLocaleString('ja-JP')} 以上かつ利益率{' '}
            {s.minRatePct}% 以上（為替手数料 {s.fxFeePct}% / 状態ダウン {s.condDownPct}% 控除・上位
            {s.watchMax}枚まで・USD/JPY={catalog.usdJpy.toFixed(1)}）
          </span>
        </div>
        {catalog.warnings.length > 0 && (
          <details className="data-status__warnings">
            <summary>取得時の警告 {catalog.warnings.length}件</summary>
            <ul>
              {catalog.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </details>
        )}
      </section>

      {surges.length > 0 && (
        <section className="panel">
          <h2 className="panel__title">
            急上昇ピックアップ（TCGplayer市場価格が90日で+{SURGE_MIN_PCT * 100}%以上・
            {surges.length}枚）
          </h2>
          <div className="watch-surge-list">
            {surges.slice(0, SURGE_MAX).map(({ card, change }) => (
              <button
                key={card.id}
                type="button"
                className="watch-surge-chip"
                title={`${change.prevDate} 比 / クリックで履歴チャートを表示`}
                onClick={() => jumpToCard(card.id)}
              >
                {card.img && <img src={card.img} alt="" loading="lazy" />}
                <span className="watch-surge-chip__body">
                  <span className="watch-surge-chip__name">{card.name}</span>
                  <span className="watch-surge-chip__sub">
                    {card.set.toUpperCase()} #{card.cn}
                    {card.finish !== 'nonfoil' && ' Foil'}
                  </span>
                  <span className="watch-surge-chip__price">
                    {card.tpMarketUsd != null && formatUsd(card.tpMarketUsd)}
                    <strong className="tracker-change--up">
                      ▲{(change.pct * 100).toFixed(0)}%
                    </strong>
                  </span>
                </span>
              </button>
            ))}
          </div>
          {surges.length > SURGE_MAX && (
            <p className="watch-surge-more">
              他 {surges.length - SURGE_MAX}枚は並び順「TCG市場の90日上昇が大きい順」で確認できます。
            </p>
          )}
        </section>
      )}

      <section className="panel">
        <div className="panel__grid">
          <label className="field">
            <span className="field__label">カード名検索</span>
            <input
              type="search"
              value={searchText}
              placeholder="例: Mana Crypt"
              onChange={(e) => setSearchText(e.target.value)}
            />
          </label>
          <label className="field">
            <span className="field__label">セット</span>
            <select value={setFilter} onChange={(e) => setSetFilter(e.target.value)}>
              <option value="">すべて（{setOptions.length}セット）</option>
              {setOptions.map((s) => (
                <option key={s.code} value={s.code}>
                  {s.code.toUpperCase()} — {s.name}（{s.count}枚）
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field__label">Foil</span>
            <select
              value={foilFilter}
              onChange={(e) => setFoilFilter(e.target.value as typeof foilFilter)}
            >
              <option value="all">すべて</option>
              <option value="foil">Foilのみ</option>
              <option value="nonfoil">非Foilのみ</option>
            </select>
          </label>
          <label className="field">
            <span className="field__label">並び順</span>
            <select value={sortKey} onChange={(e) => setSortKey(e.target.value as WatchSortKey)}>
              <option value="netProfit">実質利益が大きい順</option>
              <option value="tpChange7d">TCG市場の7日変動が大きい順</option>
              <option value="tpChange30d">TCG市場の30日変動が大きい順</option>
              <option value="tpChange90d">TCG市場の90日上昇が大きい順</option>
              <option value="spread">販売ソース間の差額が大きい順</option>
              <option value="hyBuyPrice">晴れる屋買取が高い順</option>
              <option value="tpPrice">TCG市場価格が高い順</option>
              <option value="name">カード名順</option>
            </select>
          </label>
          <label className="field field--checkbox">
            <input
              type="checkbox"
              checked={activeOnly}
              onChange={(e) => setActiveOnly(e.target.checked)}
            />
            <span>現在ヒット中のみ（過去に追跡したカードを隠す）</span>
          </label>
          <label className="field field--checkbox">
            <input type="checkbox" checked={showJpy} onChange={(e) => setShowJpy(e.target.checked)} />
            <span>
              円換算で表示（$={Math.round(rates.usdJpy)} / €={Math.round(rates.eurJpy)}
              {rates.approximate && '・概算'}）
            </span>
          </label>
        </div>
      </section>

      <div className="table-wrapper">
        <table className="result-table tracker-table">
          <thead>
            <tr>
              <th>カード</th>
              <th className="num">実質利益</th>
              {SOURCES.map((src) => (
                <th key={src.key} className="num">
                  <span className="tracker-th-dot" style={{ background: src.color }} />
                  {src.label}
                  <span className="tracker-th-currency">
                    {src.currency === 'JPY' ? '¥' : src.currency === 'USD' ? '$' : '€'}
                  </span>
                </th>
              ))}
              <th>履歴</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, MAX_ROWS).map((card) => {
              const cardChanges = changes.get(card.id);
              const expanded = expandedId === card.id;
              const tp7 = tcgChange(tcg, card.id, 7);
              return (
                <Fragment key={card.id}>
                  <tr
                    id={`row-${card.id}`}
                    className={`tracker-row${expanded ? ' tracker-row--expanded' : ''}${card.active || card.watchSet ? '' : ' watch-row--inactive'}`}
                    onClick={() => setExpandedId(expanded ? null : card.id)}
                  >
                    <td className="tracker-card-cell">
                      {card.img && (
                        <img src={card.img} alt="" loading="lazy" className="tracker-thumb" />
                      )}
                      <span className="tracker-card-main">
                        <a
                          href={card.scryfallUri}
                          target="_blank"
                          rel="noreferrer"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {card.name}
                        </a>
                        <span className="tracker-card-sub">
                          {card.set.toUpperCase()} #{card.cn}
                          {card.finish !== 'nonfoil' && <span className="tracker-foil">Foil</span>}
                          {card.language && card.language !== 'English' && (
                            <span className="watch-lang">{card.language}</span>
                          )}
                          {!card.active &&
                            (card.watchSet ? (
                              <span className="watch-inactive-badge watch-set-badge">
                                セット監視
                              </span>
                            ) : (
                              <span className="watch-inactive-badge">ヒット外</span>
                            ))}
                        </span>
                      </span>
                    </td>
                    <td className="num">
                      {card.netProfitJpy == null ? (
                        <span className="tracker-na">—</span>
                      ) : (
                        <>
                          <span
                            className={`watch-profit${card.netProfitJpy > 0 ? '' : ' watch-profit--minus'}`}
                          >
                            {formatJpy(card.netProfitJpy)}
                          </span>
                          <span className="tracker-cell-sub">
                            {card.profitRate != null && (
                              <span className="tracker-stock">{formatPct(card.profitRate)}</span>
                            )}
                            {card.ckBuylistUsd != null && (
                              <span
                                className="tracker-stock"
                                title={`Card Kingdom 買取 ${formatUsd(card.ckBuylistUsd)}（上限${card.ckMaxQty}枚）`}
                              >
                                CK買取{formatUsd(card.ckBuylistUsd)}
                              </span>
                            )}
                            {card.cautions.length > 0 && (
                              <span className="watch-caution" title={card.cautions.join(' / ')}>
                                ⚠{card.cautions.length}
                              </span>
                            )}
                          </span>
                        </>
                      )}
                    </td>
                    {SOURCES.map((src, i) => {
                      const value = getPrice(card, src.key);
                      // TCG列は密な履歴から7日変動、他列は前回スナップショット比
                      const change = src.key === 'tp' ? tp7 : (cardChanges?.[i] ?? null);
                      const url = src.key === 'hyBuy' ? card.hyBuyUrl : card.urls[src.key];
                      const stock =
                        src.key === 'hy' ? card.hyStock : src.key === 'ck' ? card.ckQty : undefined;
                      const cond =
                        src.key === 'hy'
                          ? card.hyCond && card.hyCond !== 'NM'
                            ? card.hyCond
                            : undefined
                          : src.key === 'tp'
                            ? card.tpCond && card.tpCond !== 'Near Mint'
                              ? card.tpCond
                              : undefined
                            : undefined;
                      return (
                        <td key={src.key} className="num">
                          {value == null ? (
                            <span className="tracker-na">{src.key === 'hy' ? '在庫なし' : '—'}</span>
                          ) : (
                            <>
                              {url ? (
                                <a
                                  href={url}
                                  target="_blank"
                                  rel="noreferrer"
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  {showJpy
                                    ? formatJpy(toJpy(value, src.currency, rates))
                                    : formatNative(value, src.currency)}
                                </a>
                              ) : showJpy ? (
                                formatJpy(toJpy(value, src.currency, rates))
                              ) : (
                                formatNative(value, src.currency)
                              )}
                              {cond && (
                                <span
                                  className="tracker-cond"
                                  title="NM在庫・NM実績がないため、この状態の価格を表示しています"
                                >
                                  {cond}
                                </span>
                              )}
                              {((change != null && Math.abs(change.pct) >= 0.0005) ||
                                (stock != null && stock > 0)) && (
                                <span className="tracker-cell-sub">
                                  {change != null && Math.abs(change.pct) >= 0.0005 && (
                                    <span
                                      className={`tracker-change tracker-change--${change.pct > 0 ? 'up' : 'down'}`}
                                      title={
                                        src.key === 'tp'
                                          ? `7日前 (${change.prevDate}) 比`
                                          : `前回 (${change.prevDate}) 比`
                                      }
                                    >
                                      {change.pct > 0 ? '▲' : '▼'}
                                      {Math.abs(change.pct * 100).toFixed(1)}%
                                    </span>
                                  )}
                                  {stock != null && stock > 0 && (
                                    <span className="tracker-stock">在庫{stock}</span>
                                  )}
                                </span>
                              )}
                            </>
                          )}
                        </td>
                      );
                    })}
                    <td
                      className="tracker-expand-hint"
                      title={expanded ? '閉じる' : '価格履歴チャートを表示'}
                    >
                      {expanded ? '▲' : '▼'}
                    </td>
                  </tr>
                  {expanded && history && (
                    <tr className="tracker-chart-row">
                      <td colSpan={SOURCES.length + 3}>
                        <MarketChart
                          snapshots={history.snapshots}
                          tcg={tcg[card.id]}
                          cardId={card.id}
                          rates={rates}
                        />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
        {rows.length === 0 && <p className="table-empty">条件に一致するカードがありません。</p>}
        {rows.length > MAX_ROWS && (
          <p className="table-empty">
            {rows.length}枚中、上位{MAX_ROWS}枚のみ表示しています。検索で絞り込んでください。
          </p>
        )}
      </div>
    </div>
  );
}

function PageHeader() {
  return (
    <header className="app-header">
      <h1>MTG マーケットウォッチ</h1>
      <p className="app-header__sub">
        利益チェッカーのヒットカード（晴れる屋買取 vs Card Kingdom Buylist
        で利益が出そうなカード）を自動追跡し、TCGplayer のマーケットプライス履歴と
        4ソースの販売価格を毎日記録
      </p>
    </header>
  );
}
