import type { TcgHistoryMap, WatchCard, WatchHistory } from '../types/market';

/**
 * 予兆検知 — スパイク「前段」の先行指標を拾う。
 *
 * スパイク検知（spike.ts）が「すでに+10%動いたカード」を確定させるのに対し、
 * こちらは価格がまだ大きく動いていない段階の兆候をスコア化する:
 *
 *   Tier A（常時有効）
 *   - vol_surge:   出来高先行。販売枚数が平常の3倍以上なのに価格は±10%未満（買い集めの兆候）
 *   - stock_drain: 在庫枯渇。晴れる屋+CKの在庫が半減して残りわずか、なのに価格据え置き
 *   - spillover:   波及前。TCGplayerは+15%以上動いたが晴れる屋がまだ追随していない
 *                  （スパイク確定済みカードでもこのシグナルだけは表示する＝日本で買える窓）
 *
 *   Tier B（2026-07-26からの蓄積データがたまり次第、自動で有効化）
 *   - buy_ratio:   CK買取価格が販売価格に先行して上昇（ディーラーの強気）
 *   - edhrec:      EDHRECランクの急上昇（デッキ需要が価格に乗る前）
 *   - floor_lift:  実売の安値が切り上がっているのにマーケットプライスは横ばい
 */
export interface OmenSignal {
  type: 'vol_surge' | 'stock_drain' | 'spillover' | 'buy_ratio' | 'edhrec' | 'floor_lift';
  label: string;
  weight: number;
}

export interface OmenInfo {
  card: WatchCard;
  score: number;
  recentUsd: number | null;
  signals: OmenSignal[];
}

const DAY = 86400000;
const NEW_SET_DAYS = 90;

const WEIGHTS: Record<OmenSignal['type'], number> = {
  vol_surge: 30,
  buy_ratio: 25,
  stock_drain: 20,
  spillover: 20,
  floor_lift: 20,
  edhrec: 10,
};

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function computeOmens(
  cards: WatchCard[],
  tcg: TcgHistoryMap,
  history: WatchHistory | null,
  /** スパイク確定済み（急騰側）のカードID。spillover 以外のシグナルから除外する */
  spikedIds: Set<string>,
): OmenInfo[] {
  const now = Date.now();
  const omens: OmenInfo[] = [];

  const snaps = (history?.snapshots ?? []).filter((s) => now - Date.parse(s.date) < 30 * DAY);
  const oldSnap = snaps[0];
  const newSnap = snaps[snaps.length - 1];
  const snapReady =
    oldSnap != null &&
    newSnap != null &&
    Date.parse(newSnap.date) - Date.parse(oldSnap.date) >= 5 * DAY;

  for (const card of cards) {
    const buckets = tcg[card.id]?.buckets;
    if (!buckets) continue;
    const dates = Object.keys(buckets).sort();
    if (dates.length === 0) continue;

    // 新セットはスパイク検知と同じ理由で除外
    const releasedTs = card.released ? Date.parse(card.released) : null;
    const isNewSet =
      releasedTs != null
        ? now - releasedTs < NEW_SET_DAYS * DAY
        : now - Date.parse(dates[0]) < (NEW_SET_DAYS + 10) * DAY;
    if (isNewSet) continue;

    const real = dates.filter((d) => buckets[d][2] > 0);
    const recentDate = real.filter((d) => now - Date.parse(d) < 14 * DAY).pop();
    const recentUsd = recentDate ? buckets[recentDate][0] : (card.tpMarketUsd ?? null);

    // 価格の短期変化率（スパイク検知と同じ「直近実売 vs 過去30日実売中央値」）
    let shortPct: number | null = null;
    if (recentDate) {
      const rts = Date.parse(recentDate);
      const base = real.filter((d) => {
        const t = Date.parse(d);
        return rts - t >= 7 * DAY && rts - t < 37 * DAY;
      });
      if (base.length >= 2) {
        const bl = median(base.map((d) => buckets[d][0]));
        if (bl > 0) shortPct = buckets[recentDate][0] / bl - 1;
      }
    }
    const priceQuiet = shortPct != null && Math.abs(shortPct) < 0.1;

    const signals: OmenSignal[] = [];
    const spiked = spikedIds.has(card.id);

    // --- vol_surge: 出来高先行 ---
    if (!spiked && priceQuiet && recentUsd != null && recentUsd >= 10) {
      const sales7 = dates
        .filter((d) => now - Date.parse(d) < 7 * DAY)
        .reduce((sum, d) => sum + buckets[d][1], 0);
      const priorQty = dates
        .filter((d) => {
          const age = now - Date.parse(d);
          return age >= 7 * DAY && age < 37 * DAY;
        })
        .reduce((sum, d) => sum + buckets[d][1], 0);
      const weeklyAvg = priorQty / (30 / 7);
      const volRatio = weeklyAvg > 0 ? sales7 / weeklyAvg : null;
      if (sales7 >= 3 && volRatio != null && volRatio >= 3) {
        signals.push({
          type: 'vol_surge',
          label: `販売${sales7}枚/7日（平常の${volRatio.toFixed(1)}倍）なのに価格${shortPct != null && shortPct >= 0 ? '+' : ''}${((shortPct ?? 0) * 100).toFixed(0)}%`,
          weight: WEIGHTS.vol_surge,
        });
      }
    }

    if (snapReady) {
      const oldT = oldSnap.prices[card.id];
      const newT = newSnap.prices[card.id];
      if (oldT && newT) {
        // --- stock_drain: 在庫枯渇 ---
        if (!spiked && priceQuiet) {
          const prevStock = (oldT[5] ?? 0) + (oldT[6] ?? 0);
          const nowStock = (newT[5] ?? 0) + (newT[6] ?? 0);
          if (prevStock >= 4 && nowStock <= 3 && nowStock <= prevStock / 2) {
            signals.push({
              type: 'stock_drain',
              label: `晴れる屋+CK在庫 ${prevStock}→${nowStock}（価格は据え置き）`,
              weight: WEIGHTS.stock_drain,
            });
          }
        }

        // --- spillover: 波及前（TCGは動いたが晴れる屋が未反応） ---
        const tpOld = oldT[3];
        const tpNew = newT[3];
        const hyOld = oldT[1];
        const hyNew = newT[1];
        if (tpOld != null && tpNew != null && tpOld > 0 && hyOld != null && hyNew != null) {
          const tpPct = tpNew / tpOld - 1;
          const hyPct = hyNew / hyOld - 1;
          if (tpPct >= 0.15 && hyPct < 0.05) {
            signals.push({
              type: 'spillover',
              label: `TCG+${(tpPct * 100).toFixed(0)}%に晴れる屋（${(hyPct * 100).toFixed(0)}%）が未追随`,
              weight: WEIGHTS.spillover,
            });
          }
        }

        // --- buy_ratio: CK買取の先行上昇（Tier B: 2026-07-26以降の蓄積で有効化） ---
        const buyOld = oldT[7];
        const buyNew = newT[7];
        const ckOld = oldT[2];
        const ckNew = newT[2];
        if (
          !spiked &&
          buyOld != null &&
          buyNew != null &&
          buyOld > 0 &&
          ckOld != null &&
          ckNew != null &&
          ckOld > 0
        ) {
          const buyPct = buyNew / buyOld - 1;
          const retailPct = ckNew / ckOld - 1;
          if (buyPct >= 0.08 && retailPct < 0.05) {
            signals.push({
              type: 'buy_ratio',
              label: `CK買取+${(buyPct * 100).toFixed(0)}%（販売は${(retailPct * 100).toFixed(0)}%のまま）`,
              weight: WEIGHTS.buy_ratio,
            });
          }
        }

        // --- edhrec: 需要モメンタム（Tier B） ---
        const rankOld = oldT[8];
        const rankNew = newT[8];
        if (!spiked && rankOld != null && rankNew != null && rankOld > 0 && rankNew > 0) {
          const gained = rankOld - rankNew; // ランクは小さいほど人気
          if (gained >= 500 && gained / rankOld >= 0.25) {
            signals.push({
              type: 'edhrec',
              label: `EDHREC ${rankOld.toLocaleString()}位→${rankNew.toLocaleString()}位`,
              weight: WEIGHTS.edhrec,
            });
          }
        }
      }
    }

    // --- floor_lift: 下値切り上げ（Tier B: 安値付きバケットがたまり次第有効化） ---
    if (!spiked && priceQuiet) {
      const lowsOf = (from: number, to: number) =>
        real
          .filter((d) => {
            const age = now - Date.parse(d);
            return age >= from * DAY && age < to * DAY;
          })
          .map((d) => buckets[d][3] ?? 0)
          .filter((v) => v > 0);
      const lowsRecent = lowsOf(0, 14);
      const lowsPrior = lowsOf(14, 37);
      if (lowsRecent.length >= 2 && lowsPrior.length >= 2) {
        const lift = median(lowsRecent) / median(lowsPrior) - 1;
        if (lift >= 0.1) {
          signals.push({
            type: 'floor_lift',
            label: `実売の安値が+${(lift * 100).toFixed(0)}%切り上げ（市場価格は横ばい）`,
            weight: WEIGHTS.floor_lift,
          });
        }
      }
    }

    if (signals.length === 0) continue;
    omens.push({
      card,
      recentUsd,
      signals,
      score: signals.reduce((sum, s) => sum + s.weight, 0),
    });
  }

  omens.sort((a, b) => b.score - a.score);
  return omens;
}
