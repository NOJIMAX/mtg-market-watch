import type { TcgHistoryMap, WatchCard, WatchHistory } from '../types/market';

/**
 * スパイク検知
 *
 * TCGplayer 履歴の各バケット [価格, 販売枚数, 取引数] のうち「実売のあった
 * バケット」だけを使い、出来高と他ソースの同調を加味した複合スコアで
 * ランキングする。しきい値の一覧表示と違い、偽スパイク（発売前の
 * プレースホルダー価格・実売ゼロの引き継ぎ価格・低額カードの比率マジック）を
 * 除外し、上位だけを根拠つきで示すのが目的。
 */
export interface SpikeInfo {
  card: WatchCard;
  /** up = 急騰、down = 急落 */
  direction: 'up' | 'down';
  score: number;
  /** 直近の実売価格 ÷ 基準値（過去30日の実売中央値）- 1 */
  shortPct: number;
  /** 基準値（過去30日の実売バケットの中央値 USD） */
  baselineUsd: number;
  /** 直近の実売バケットの価格 (USD) と日付 */
  recentUsd: number;
  recentDate: string;
  /** 直近7日間の販売枚数 */
  sales7: number;
  /** 直近7日の販売枚数 ÷ 過去30日の週平均。平常時の実売が無い場合は null */
  volRatio: number | null;
  /** 他ソースの同期間の変化率。履歴が5日分たまるまでは null */
  confirm: { ck: number | null; cm: number | null; hy: number | null };
  /** 同方向に8%以上同調している他ソースの数 */
  confirmCount: number;
}

export interface SpikeResult {
  /** 急騰（スコア降順） */
  ups: SpikeInfo[];
  /** 急落（スコア降順） */
  downs: SpikeInfo[];
  /** 発売90日未満のため除外した「新セット」カード数 */
  newSetCount: number;
  /** 他ソース同調の判定に履歴が足りているか（5日分未満だと全カード null） */
  confirmReady: boolean;
}

const DAY = 86400000;

/** スコアの重み。shortPct は%換算でそのまま、出来高比は5点/倍（8倍で頭打ち）、同調は15点/ソース */
const WEIGHT_VOL = 5;
const VOL_CAP = 8;
const WEIGHT_CONFIRM = 15;

/** 候補の最低条件 */
const MIN_RECENT_USD = 10;
const MIN_ABS_CHANGE_USD = 5;
const MIN_SHORT_PCT = 0.1;
/** 発売からこの日数未満は「新セット」として除外 */
const NEW_SET_DAYS = 90;
/** 他ソース同調と判定する変化率 */
const CONFIRM_PCT = 0.08;

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function computeSpikes(
  cards: WatchCard[],
  tcg: TcgHistoryMap,
  history: WatchHistory | null,
): SpikeResult {
  const now = Date.now();
  const spikes: SpikeInfo[] = [];
  let newSetCount = 0;

  // 他ソース同調: 直近30日窓の最古スナップショットと最新スナップショットを比較する。
  // 窓が5日未満しかない（運用初期）うちは判定しない
  const snaps = (history?.snapshots ?? []).filter((s) => now - Date.parse(s.date) < 30 * DAY);
  const oldSnap = snaps[0];
  const newSnap = snaps[snaps.length - 1];
  const confirmReady =
    oldSnap != null && newSnap != null && Date.parse(newSnap.date) - Date.parse(oldSnap.date) >= 5 * DAY;

  const sourcePct = (id: string, tupleIndex: 1 | 2 | 4): number | null => {
    if (!confirmReady) return null;
    const a = oldSnap.prices[id]?.[tupleIndex];
    const b = newSnap.prices[id]?.[tupleIndex];
    return a != null && b != null && a > 0 ? b / a - 1 : null;
  };

  for (const card of cards) {
    const buckets = tcg[card.id]?.buckets;
    if (!buckets) continue;

    const dates = Object.keys(buckets).sort();
    if (dates.length === 0) continue;

    // 発売90日未満の版は「発売による価格形成」をスパイクと誤検知しやすいため除外。
    // released が無い旧データでは「最古バケットが約90日より新しい」ことで代用する
    // （初回取得は過去1年分の週次なので、古いカードの最古バケットは約1年前になる）
    const releasedTs = card.released ? Date.parse(card.released) : null;
    const isNewSet =
      releasedTs != null
        ? now - releasedTs < NEW_SET_DAYS * DAY
        : now - Date.parse(dates[0]) < (NEW_SET_DAYS + 10) * DAY;
    if (isNewSet) {
      newSetCount++;
      continue;
    }

    // 実売のあったバケットのみ（取引0の引き継ぎ価格はノイズ）
    const real = dates.filter((d) => buckets[d][2] > 0);
    if (real.length < 4) continue;

    // 直近14日以内の実売がなければ「今スパイク中」とは言えない
    const recentDate = real.filter((d) => now - Date.parse(d) < 14 * DAY).pop();
    if (!recentDate) continue;
    const recentUsd = buckets[recentDate][0];
    const recentTs = Date.parse(recentDate);

    // 基準値: 直近を除いた過去30日（7〜37日前）の実売中央値。
    // 検知期間を1ヶ月に収めるため、これより古い実売には遡らない
    // （1ヶ月内に実売が2回未満のカードは流動性不足として対象外）
    const base = real.filter((d) => {
      const t = Date.parse(d);
      return recentTs - t >= 7 * DAY && recentTs - t < 37 * DAY;
    });
    if (base.length < 2) continue;
    const baselineUsd = median(base.map((d) => buckets[d][0]));
    if (baselineUsd <= 0) continue;

    // 上昇・下落を対称に判定する。下落側は「下落前に$10以上だったカード」が対象
    // （急落後の現在価格ではなく基準値に価格下限をかける）
    const shortPct = recentUsd / baselineUsd - 1;
    let direction: 'up' | 'down';
    if (
      shortPct >= MIN_SHORT_PCT &&
      recentUsd >= MIN_RECENT_USD &&
      recentUsd - baselineUsd >= MIN_ABS_CHANGE_USD
    ) {
      direction = 'up';
    } else if (
      shortPct <= -MIN_SHORT_PCT &&
      baselineUsd >= MIN_RECENT_USD &&
      baselineUsd - recentUsd >= MIN_ABS_CHANGE_USD
    ) {
      direction = 'down';
    } else {
      continue;
    }

    // 出来高: 直近7日の販売枚数と、それ以前30日（7〜37日前）の週平均の比
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

    const confirm = {
      hy: sourcePct(card.id, 1),
      ck: sourcePct(card.id, 2),
      cm: sourcePct(card.id, 4),
    };
    // 同調は検知と同じ方向の変化だけを数える
    const confirmCount = Object.values(confirm).filter(
      (p) => p != null && (direction === 'up' ? p >= CONFIRM_PCT : p <= -CONFIRM_PCT),
    ).length;

    const score =
      Math.abs(shortPct) * 100 +
      Math.min(volRatio ?? 0, VOL_CAP) * WEIGHT_VOL +
      confirmCount * WEIGHT_CONFIRM;

    spikes.push({
      card,
      direction,
      score,
      shortPct,
      baselineUsd,
      recentUsd,
      recentDate,
      sales7,
      volRatio,
      confirm,
      confirmCount,
    });
  }

  spikes.sort((a, b) => b.score - a.score);
  return {
    ups: spikes.filter((s) => s.direction === 'up'),
    downs: spikes.filter((s) => s.direction === 'down'),
    newSetCount,
    confirmReady,
  };
}
