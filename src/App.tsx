import { Fragment, useEffect, useMemo, useState } from 'react';
import './App.css';
import { MarketChart } from './components/MarketChart';
import { UpdateButton } from './components/UpdateButton';
import { WatchlistPanel } from './components/WatchlistPanel';
import { computeSpikes } from './lib/spike';
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

/** スパイク検知（上昇）の最大表示枚数 */
const SPIKE_MAX = 20;
/** 急落検知の最大表示枚数 */
const DROP_MAX = 10;

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
  /** インクリメントすると価格データを再読み込みする（手動更新の完了時） */
  const [reloadKey, setReloadKey] = useState(0);

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
  }, [reloadKey]);

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

  /** 出来高・他ソース同調を加味したスパイク検知（スコア降順） */
  const spikeResult = useMemo(
    () => (catalog ? computeSpikes(catalog.cards, tcg, history) : null),
    [catalog, tcg, history],
  );

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
      if (activeOnly && !c.active && !c.watchSet && !c.manual) return false;
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
          <UpdateButton onCompleted={() => setReloadKey((k) => k + 1)} />
          <span className="data-status__counts">
            追跡 {catalog.counts.cards}枚（ヒット中 {catalog.counts.active}枚
            {(catalog.counts.watchSet ?? 0) > 0 && `・セット監視 ${catalog.counts.watchSet}枚`}
            {(catalog.counts.manual ?? 0) > 0 && `・手動 ${catalog.counts.manual}枚`}）/ TCG履歴{' '}
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

      {spikeResult &&
        (
          [
            {
              key: 'up',
              list: spikeResult.ups,
              max: SPIKE_MAX,
              title: 'スパイク検知（実売ベースの上昇率 × 出来高 × 他ソース同調のスコア上位',
              mark: '▲',
              markClass: 'tracker-change--up',
              word: '上昇',
            },
            {
              key: 'down',
              list: spikeResult.downs,
              max: DROP_MAX,
              title: '急落検知（実売ベースの下落率 × 出来高 × 他ソース同調のスコア上位',
              mark: '▼',
              markClass: 'watch-drop',
              word: '下落',
            },
          ] as const
        ).map(
          ({ key, list, max, title, mark, markClass, word }) =>
            list.length > 0 && (
              <section className="panel" key={key}>
                <h2 className="panel__title">
                  {title}・候補{list.length}枚）
                </h2>
                <div className="watch-surge-list">
                  {list.slice(0, max).map((s) => (
                    <button
                      key={s.card.id}
                      type="button"
                      className="watch-surge-chip"
                      title="基準値 = 過去30日の実売中央値 / クリックで履歴チャートを表示"
                      onClick={() => jumpToCard(s.card.id)}
                    >
                      {s.card.img && <img src={s.card.img} alt="" loading="lazy" />}
                      <span className="watch-surge-chip__body">
                        <span className="watch-surge-chip__name">{s.card.name}</span>
                        <span className="watch-surge-chip__sub">
                          {s.card.set.toUpperCase()} #{s.card.cn}
                          {s.card.finish !== 'nonfoil' && ' Foil'}
                        </span>
                        <span className="watch-surge-chip__price">
                          {formatUsd(s.recentUsd)}
                          <strong className={markClass}>
                            {mark}
                            {Math.abs(s.shortPct * 100).toFixed(0)}%
                          </strong>
                          <span className="watch-spike-vs">
                            対30日中央値{formatUsd(s.baselineUsd)}
                          </span>
                        </span>
                        <span className="watch-spike-evidence">
                          {s.sales7 > 0
                            ? `販売${s.sales7}枚/7日`
                            : `直近実売 ${s.recentDate.slice(5).replace('-', '/')}`}
                          {s.sales7 > 0 &&
                            s.volRatio != null &&
                            s.volRatio >= 1.5 &&
                            `（平常の${s.volRatio.toFixed(1)}倍）`}
                          {s.confirmCount > 0 &&
                            ` ・ ${(['hy', 'ck', 'cm'] as const)
                              .filter((k) => {
                                const p = s.confirm[k];
                                return p != null && (key === 'up' ? p >= 0.08 : p <= -0.08);
                              })
                              .map((k) => ({ hy: '晴れる屋', ck: 'CK', cm: 'CM' })[k])
                              .join('/')}も${word}`}
                        </span>
                      </span>
                    </button>
                  ))}
                </div>
                <p className="watch-surge-more">
                  条件: 直近14日に実売あり・{word === '上昇' ? '$10以上' : '下落前$10以上'}
                  ・変化額$5以上・{word}率10%以上（実売0のバケットと発売90日未満の新セット
                  {spikeResult.newSetCount}枚は除外）
                  {!spikeResult.confirmReady &&
                    '。他ソース同調は履歴が5日分たまり次第判定されます'}
                </p>
              </section>
            ),
        )}

      <WatchlistPanel trackedIds={new Set(catalog.cards.map((c) => c.id))} />

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
                    className={`tracker-row${expanded ? ' tracker-row--expanded' : ''}${card.active || card.watchSet || card.manual ? '' : ' watch-row--inactive'}`}
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
                            (card.manual ? (
                              <span className="watch-inactive-badge watch-manual-badge">手動</span>
                            ) : card.watchSet ? (
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
