/** マーケットウォッチ（public/data/*.json）の型定義 */

export interface WatchCard {
  /** `${ScryfallID}:${finish}` */
  id: string;
  sid: string;
  name: string;
  set: string;
  setName: string;
  cn: string;
  finish: 'nonfoil' | 'foil';
  img: string;
  scryfallUri: string;
  tid: number | null;
  /** 現在もヒット条件を満たしているか（false = 過去にヒットして履歴継続中） */
  active: boolean;
  /** INCLUDED_SETS によるセット単位の監視対象（ヒット判定と無関係に追跡） */
  watchSet?: boolean;
  /** 版の発売日 (YYYY-MM-DD)。2026-07-18以前のデータには存在しない */
  released?: string | null;
  firstTracked: string;
  /** 晴れる屋側のセットコード（買取行由来） */
  hySetCode: string;
  /** ヒットした買取行の言語 */
  language: string;

  /* ヒット情報（利益チェッカー由来） */
  hyBuyJpy: number | null;
  hyBuyUrl: string;
  ckBuylistUsd: number | null;
  ckMaxQty: number;
  netProfitJpy: number | null;
  profitRate: number | null;
  cautions: string[];

  /* 当日の販売価格 */
  hyJpy?: number | null;
  hyStock?: number;
  hyCond?: string;
  ckUsd?: number | null;
  ckQty?: number;
  /** TCGplayer マーケットプライス（履歴の最新値） */
  tpMarketUsd?: number | null;
  tpMarketDate?: string;
  tpCond?: string;
  cmEur?: number | null;

  urls: { tp?: string; cm?: string; hy?: string; ck?: string };
}

export interface WatchSettings {
  minProfitJpy: number;
  minRatePct: number;
  fxFeePct: number;
  condDownPct: number;
  watchMax: number;
}

export interface WatchCatalog {
  updatedAt: string;
  profitDataUpdatedAt: string | null;
  usdJpy: number;
  settings: WatchSettings;
  counts: {
    cards: number;
    active: number;
    /** 2026-07-15以前のデータには存在しない */
    watchSet?: number;
    hareruya: number;
    cardKingdom: number;
    tcgplayer: number;
    cardmarket: number;
  };
  snapshotCount: number;
  durationSec?: number;
  warnings: string[];
  cards: WatchCard[];
}

/** [晴れる屋買取JPY, 晴れる屋販売JPY, CK販売USD, TCGマーケットUSD, Cardmarket EUR, 晴れる屋在庫, CK在庫] */
export type PriceTuple = [
  number | null,
  number | null,
  number | null,
  number | null,
  number | null,
  number,
  number,
];

export interface WatchSnapshot {
  date: string;
  prices: Record<string, PriceTuple>;
}

export interface WatchHistory {
  snapshots: WatchSnapshot[];
}

/** TCGplayer マーケットプライス履歴。バケットは 日付 → [価格USD, 販売数, 取引数] */
export interface TcgCardHistory {
  tid: number;
  condition: string | null;
  buckets: Record<string, [number, number, number]>;
}

export type TcgHistoryMap = Record<string, TcgCardHistory>;

export type SourceKey = 'hyBuy' | 'hy' | 'ck' | 'tp' | 'cm';

export interface SourceDef {
  key: SourceKey;
  label: string;
  currency: 'JPY' | 'USD' | 'EUR';
  /** PriceTuple 内のインデックス */
  tupleIndex: 0 | 1 | 2 | 3 | 4;
  color: string;
  /** チャートで破線にする（買取価格） */
  dashed?: boolean;
}

export const SOURCES: SourceDef[] = [
  { key: 'hyBuy', label: '晴れる屋買取', currency: 'JPY', tupleIndex: 0, color: '#b91c1c', dashed: true },
  { key: 'hy', label: '晴れる屋販売', currency: 'JPY', tupleIndex: 1, color: '#d9542b' },
  { key: 'ck', label: 'Card Kingdom', currency: 'USD', tupleIndex: 2, color: '#1258c9' },
  { key: 'tp', label: 'TCGplayer市場', currency: 'USD', tupleIndex: 3, color: '#7c3aed' },
  { key: 'cm', label: 'Cardmarket', currency: 'EUR', tupleIndex: 4, color: '#0a7d33' },
];

export interface FxRates {
  usdJpy: number;
  eurJpy: number;
  approximate: boolean;
}

export const FALLBACK_RATES: FxRates = { usdJpy: 155, eurJpy: 170, approximate: true };

export type WatchSortKey =
  | 'netProfit'
  | 'tpChange7d'
  | 'tpChange30d'
  | 'tpChange90d'
  | 'spread'
  | 'hyBuyPrice'
  | 'tpPrice'
  | 'name';
