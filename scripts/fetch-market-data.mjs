/**
 * マーケットウォッチ データ取得スクリプト
 *
 * mtg-profit-checker の価格データ（晴れる屋買取 / Card Kingdom Buylist）から
 * 「利益が出そうなカード（ヒットカード）」を自動選定し、そのカードについて
 *
 *   1. TCGplayer のマーケットプライス履歴（infinite-api、最大1年分）を取得・蓄積
 *   2. 4ソースの販売価格（晴れる屋 / Card Kingdom / TCGplayer / Cardmarket）を
 *      1日1回記録
 *
 * する。一度追跡したカードはヒット条件から外れても履歴を継続する（active フラグ
 * で区別）。照合・利益計算ロジックは mtg-profit-checker の src/lib/matcher.ts /
 * calculator.ts の移植。
 *
 * 入力: ../mtg-profit-checker/public/prices/{hareruya,cardkingdom}.json
 *       （PROFIT_DATA_DIR で変更可。利益チェッカーの毎朝7:00の更新後に実行する想定）
 * 出力: public/data/cards.json        カードカタログ + 最新価格 + ヒット情報
 *       public/data/history.json      4ソース価格の日次スナップショット
 *       public/data/tcg-history.json  TCGplayerマーケットプライス履歴（日付マージ蓄積）
 *       data/resolve-cache.json       Scryfall解決結果のキャッシュ（内部用）
 *
 * 環境変数:
 *   PROFIT_DATA_DIR   利益チェッカーの prices ディレクトリ
 *   MIN_PROFIT_JPY    ヒット判定の最低実質利益 (デフォルト 3000)
 *   MIN_RATE_PCT      ヒット判定の最低利益率% (デフォルト 15)
 *   FX_FEE_PCT        為替手数料率% (デフォルト 2)
 *   COND_DOWN_PCT     状態ダウン想定率% (デフォルト 10)
 *   WATCH_MAX         新規追跡数の上限。実質利益の高い順 (デフォルト 300)
 *   WATCH_DELAY_MS    リクエスト間隔ms (デフォルト 600)
 *   EXCLUDED_SETS     追跡対象外のセットコード（カンマ区切り・デフォルト "30a"）
 *   INCLUDED_SETS     ヒットと無関係に監視するセット（カンマ区切り。"sld:20" で
 *                     Scryfall参考価格 $20以上のみ。デフォルトは DEFAULT_INCLUDED_SETS）
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'public', 'data');
const CACHE_PATH = join(ROOT, 'data', 'resolve-cache.json');
const PROFIT_DIR =
  process.env.PROFIT_DATA_DIR ?? join(ROOT, '..', 'mtg-profit-checker', 'public', 'prices');

const MIN_PROFIT_JPY = Number(process.env.MIN_PROFIT_JPY ?? 3000);
const MIN_RATE = Number(process.env.MIN_RATE_PCT ?? 15) / 100;
const FX_FEE_RATE = Number(process.env.FX_FEE_PCT ?? 2) / 100;
const COND_DOWN_RATE = Number(process.env.COND_DOWN_PCT ?? 10) / 100;
const WATCH_MAX = Number(process.env.WATCH_MAX ?? 300);
const DELAY_MS = Number(process.env.WATCH_DELAY_MS ?? 600);

/**
 * 追跡対象外のセット（Scryfall/晴れる屋どちらのコードでも判定できるよう小文字で保持）。
 * 30A (30th Anniversary Edition) は再録プロキシ的な特別商品で通常の相場と乖離するため除外。
 * 7ED (Seventh Edition) はユーザー指定で除外。
 * 既に追跡済みのカードもここに追加すると次回実行時にカタログから外れる。
 */
const EXCLUDED_SETS = new Set(
  (process.env.EXCLUDED_SETS ?? '30a,7ed')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
);

/**
 * セット単位の監視リストのデフォルト。ヒット判定と無関係に常に追跡する。
 *   code:   Scryfall セットコード（セット全カードが対象）
 *   query:  Scryfall 検索クエリ（セット横断の特殊仕上げ等。label はログ・警告表示用）
 *   minUsd: Scryfall 参考価格(USD)がこの値以上のカードだけを対象にする。
 *           条件から外れたカードは次回実行時にカタログからも外れる
 *           （再び条件を満たせば TCGplayer 履歴は過去1年分を取り直せる）
 * 環境変数 INCLUDED_SETS（"exp,sld:20" 形式・code のみ）を指定するとこちらを上書きする。
 */
const DEFAULT_INCLUDED_SETS = [
  { code: 'exp' }, // Zendikar Expeditions
  { code: 'mps' }, // Kaladesh Inventions
  { code: 'mp2' }, // Amonkhet Invocations
  { query: 'e:sld -t:basic', label: 'sld', minUsd: 30 }, // Secret Lair Drop（基本地形を除く）
  { code: 'ltc', minUsd: 20 }, // Tales of Middle-earth Commander
  { code: 'fic', minUsd: 20 }, // Final Fantasy Commander
  { code: 'soa', minUsd: 20 }, // Secrets of Strixhaven Mystical Archive
  { query: 'is:doublerainbow', label: 'doublerainbow', minUsd: 20 }, // Double Rainbow Foil
  { query: 'is:judgegift', label: 'judge', minUsd: 20 }, // ジャッジ褒賞Foil（日英価格差の監視）
  // LTRホリデーリリース（独立セットではなく ltr の 2023-11-03 追加分 #452〜）
  { query: 'e:ltr date>=2023-11-01', label: 'ltr-holiday', minUsd: 20 },
];

const INCLUDED_SETS = process.env.INCLUDED_SETS
  ? process.env.INCLUDED_SETS.split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
      .map((s) => {
        const [code, min] = s.split(':');
        return { code, minUsd: min ? Number(min) : null };
      })
  : DEFAULT_INCLUDED_SETS;

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const warnings = [];
let requestCount = 0;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class NotFoundError extends Error {}

async function fetchWithRetry(url, { headers = {}, retries = 5, method, body, as = 'json' } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      requestCount++;
      const res = await fetch(url, {
        method,
        ...(body != null && { body }),
        headers: { 'User-Agent': USER_AGENT, ...headers },
      });
      if (res.status === 404) throw new NotFoundError(`HTTP 404: ${url}`);
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status}`);
        err.status = res.status;
        // レート制限は Retry-After 秒（なければ後述の長め待機）を尊重する
        err.retryAfterSec = Number(res.headers.get('retry-after')) || null;
        throw err;
      }
      return as === 'text' ? await res.text() : await res.json();
    } catch (err) {
      if (err instanceof NotFoundError || attempt >= retries) throw err;
      const delayMs =
        err.status === 429
          ? (err.retryAfterSec ? err.retryAfterSec * 1000 : 30000 * attempt)
          : 5000 * attempt;
      console.warn(`  retry ${attempt}/${retries}: ${url} (${err.message}, ${Math.round(delayMs / 1000)}秒待機)`);
      await sleep(delayMs);
    }
  }
}

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) && v != null ? n : null;
}

async function readJson(path, fallback = null) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return fallback;
  }
}

/* ================ 正規化（mtg-profit-checker/src/lib/normalize.ts の移植） ================ */

function normalizeCardName(name) {
  return name
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/(?<=\S)\+(?=\S)/g, ' // ')
    .replace(/\s*\/\/\s*/g, ' // ')
    .replace(/\s+/g, ' ')
    .trim();
}

const normalizeSetCode = (code) => code.normalize('NFKC').toUpperCase().replace(/\s+/g, '').trim();
const normalizeSetName = normalizeCardName;
const normalizeCondition = (c) => c.normalize('NFKC').toUpperCase().replace(/\s+/g, '').trim();

function isEnglish(language) {
  const s = language.normalize('NFKC').toLowerCase().trim();
  return s === 'english' || s === 'en' || s === 'eng' || s === '英語';
}

function foilKey(isFoil) {
  if (isFoil === true) return '1';
  if (isFoil === false) return '0';
  return '?';
}

/* ================ 照合（mtg-profit-checker/src/lib/matcher.ts の移植） ================ */

const SET_CODE_ALIAS = { CE: 'CED', IE: 'CEI' };
const UNMATCHABLE_SET_CODES = new Set(['大判カード', 'エラーカード']);

const VARIANT_TAGS = [
  ['borderless', /ボーダーレス|borderless/i],
  ['showcase', /ショーケース|showcase/i],
  ['extended', /拡張アート|extended/i],
  ['retro', /旧枠|retro/i],
  ['etched', /エッチング|etched/i],
  ['serialized', /シリアル|serial/i],
  ['prerelease', /プレリリース|prerelease/i],
  ['playpromo', /play\s*promo/i],
  ['promopack', /プロモパック|プロモスタンプ|promo\s*pack/i],
];

const variantKey = (note) =>
  VARIANT_TAGS.filter(([, re]) => re.test(note))
    .map(([tag]) => tag)
    .join('+');

function collectorNumber(note) {
  const hash = note.match(/#0*(\d+[a-z]?)\b/i);
  if (hash) return hash[1].toLowerCase();
  const leading = note.match(/^0*(\d+[a-z]?)\b/i);
  if (leading) return leading[1].toLowerCase();
  return null;
}

const push = (map, key, row) => {
  const list = map.get(key);
  if (list) list.push(row);
  else map.set(key, [row]);
};

function buildCkIndex(ckRows) {
  const index = { byExact: new Map(), bySetName: new Map(), byName: new Map() };
  for (const row of ckRows) {
    const name = normalizeCardName(row.cardName);
    const fk = foilKey(row.isFoil);
    const setCode = normalizeSetCode(row.setCode);
    const setName = normalizeSetName(row.setName);
    if (setCode) push(index.byExact, `${name}|${setCode}|${fk}`, row);
    if (setName) push(index.bySetName, `${name}|${setName}|${fk}`, row);
    push(index.byName, `${name}|${fk}`, row);
  }
  return index;
}

function foilKeyCandidates(isFoil) {
  if (isFoil === true) return ['1', '?'];
  if (isFoil === false) return ['0', '?'];
  return ['0', '1', '?'];
}

function matchScore(jpNote, ck) {
  let score = 0;
  const jpNum = collectorNumber(jpNote);
  const ckNum = collectorNumber(ck.note);
  if (jpNum && ckNum) score += jpNum === ckNum ? 4 : -4;
  else if (!jpNum && !ckNum) score += 2;
  else if (jpNum && !ckNum) score += 1;
  else score -= 1;
  score += variantKey(jpNote) === variantKey(ck.note) ? 2 : -2;
  return score;
}

function choose(hits, jpNote, pick) {
  const best = Math.max(...hits.map((r) => matchScore(jpNote, r)));
  const pool = hits.filter((r) => matchScore(jpNote, r) === best);
  return pool.reduce((a, b) => {
    if (pick === 'max') return b.ckBuyPriceUSD > a.ckBuyPriceUSD ? b : a;
    return b.ckBuyPriceUSD < a.ckBuyPriceUSD ? b : a;
  });
}

function lookup(map, keyPrefix, isFoil, jpNote, pick) {
  const hits = [];
  for (const fk of foilKeyCandidates(isFoil)) {
    const list = map.get(`${keyPrefix}|${fk}`);
    if (list) hits.push(...list);
  }
  return hits.length > 0 ? choose(hits, jpNote, pick) : null;
}

function matchOne(jp, index) {
  if (!jp.setCode || UNMATCHABLE_SET_CODES.has(jp.setCode)) return null;

  const fullName = normalizeCardName(jp.cardName);
  const names = [fullName];
  const frontFace = fullName.split(' // ')[0];
  if (frontFace && frontFace !== fullName) names.push(frontFace);

  const rawCode = normalizeSetCode(jp.setCode);
  const setCode = SET_CODE_ALIAS[rawCode] ?? rawCode;
  const setName = normalizeSetName(jp.setName);

  const setCodes = [];
  if (setCode && /プレリリース|プロモパック/.test(jp.note)) setCodes.push(`P${setCode}`);
  if (setCode) setCodes.push(setCode);

  for (const code of setCodes) {
    for (const name of names) {
      const ck = lookup(index.byExact, `${name}|${code}`, jp.isFoil, jp.note, 'max');
      if (ck) return { jp, ck, matchLevel: 'exact' };
    }
  }
  for (const name of names) {
    if (!setName) break;
    const ck = lookup(index.bySetName, `${name}|${setName}`, jp.isFoil, jp.note, 'max');
    if (ck) return { jp, ck, matchLevel: 'setName' };
  }
  for (const name of names) {
    const ck = lookup(index.byName, name, jp.isFoil, jp.note, 'min');
    if (ck) return { jp, ck, matchLevel: 'nameOnly' };
  }
  return null;
}

/* ================ 利益計算（mtg-profit-checker/src/lib/calculator.ts の簡略移植） ================ */

function buildHit(pair, usdJpy) {
  const { jp, ck } = pair;
  const ckCashJpy = ck.ckBuyPriceUSD * usdJpy;
  const netProfitJpy =
    ckCashJpy - jp.hareruyaBuyPriceJPY - ckCashJpy * FX_FEE_RATE - ckCashJpy * COND_DOWN_RATE;
  const profitRate = jp.hareruyaBuyPriceJPY > 0 ? netProfitJpy / jp.hareruyaBuyPriceJPY : 0;

  const cautions = [];
  if (!isEnglish(jp.language)) cautions.push('言語がEnglish以外');
  if (jp.condition && normalizeCondition(jp.condition) !== 'NM') cautions.push('状態がNM以外');
  if (ck.ckMaxQty > 0 && ck.ckMaxQty <= 3) cautions.push('買取上限が3枚以下');
  if (pair.matchLevel === 'nameOnly') cautions.push('セット不一致の可能性あり');
  if (pair.matchLevel === 'setName') cautions.push('セットコード不一致（セット名で一致）');

  return { ...pair, netProfitJpy, profitRate, cautions };
}

/** ヒット判定: 実質利益と利益率がしきい値以上、かつCKが買取受付中 */
const isHit = (h) =>
  h.netProfitJpy >= MIN_PROFIT_JPY && h.profitRate >= MIN_RATE && h.ck.ckMaxQty > 0;

/* ================ 為替 ================ */

async function fetchUsdJpy() {
  try {
    const json = await fetchWithRetry('https://open.er-api.com/v6/latest/USD', { retries: 3 });
    const jpy = json?.rates?.JPY;
    if (json?.result === 'success' && Number.isFinite(jpy)) return jpy;
    throw new Error('為替APIのレスポンスが不正です');
  } catch (err) {
    warnings.push(`為替レートの取得に失敗したため概算値155円を使います (${err.message})`);
    return 155;
  }
}

/* ================ Scryfall（版の解決 + Cardmarket価格） ================ */

/** ヒット行を一意に識別するキー（解決キャッシュ・前回追跡との対応付けに使う） */
const hitKey = (jp) =>
  [
    normalizeCardName(jp.cardName),
    normalizeSetCode(jp.setCode),
    collectorNumber(jp.note) ?? '',
    foilKey(jp.isFoil),
  ].join('|');

/**
 * 晴れる屋の買取行を Scryfall の特定の版（print）に解決する。
 *   1. コレクター番号があれば /cards/{set}/{cn}
 *   2. カード名 + セットコードで検索して先頭の版
 * 見つからない場合は null（セットコードが Scryfall と異なる古いセット等）。
 */
async function resolvePrint(jp) {
  const set = normalizeSetCode(jp.setCode).toLowerCase();
  const cn = collectorNumber(jp.note);
  const wantName = normalizeCardName(jp.cardName);

  if (cn) {
    try {
      const card = await fetchWithRetry(`https://api.scryfall.com/cards/${set}/${cn}`);
      const got = normalizeCardName(card.name);
      if (got === wantName || got.split(' // ')[0] === wantName.split(' // ')[0]) return card;
    } catch (err) {
      if (!(err instanceof NotFoundError)) throw err;
    }
    await sleep(150);
  }

  const q = `!"${jp.cardName}" e:${set}`;
  try {
    const json = await fetchWithRetry(
      `https://api.scryfall.com/cards/search?q=${encodeURIComponent(q)}&unique=prints&order=released`,
    );
    // 追跡したい仕上げ（Foil有無）を持つ版を優先する
    const wantFoil = jp.isFoil === true;
    const prints = json.data ?? [];
    return (
      prints.find((c) => c.finishes?.includes(wantFoil ? 'foil' : 'nonfoil')) ?? prints[0] ?? null
    );
  } catch (err) {
    if (err instanceof NotFoundError) return null;
    throw err;
  }
}

/** Scryfall のカードオブジェクトから追跡に必要な情報を抜き出す */
function cardFromScryfall(c, finish) {
  const foil = finish !== 'nonfoil';
  return {
    sid: c.id,
    name: c.name,
    set: c.set,
    setName: c.set_name,
    cn: c.collector_number,
    img: c.image_uris?.normal ?? c.card_faces?.[0]?.image_uris?.normal ?? '',
    scryfallUri: c.scryfall_uri,
    tid: c.tcgplayer_id ?? null,
    // スパイク検知の「新セット除外」に使う発売日
    released: c.released_at ?? null,
    // Double Rainbow Foil（シリアル入り）。晴れる屋の商品照合で参照先の区別に使う
    ...(c.promo_types?.includes('doublerainbow') && { dr: true }),
    // ジャッジ褒賞プロモ。晴れる屋では [ジャッジ褒賞]/[Judge Foil] 表記のため特別照合する
    ...(c.promo_types?.includes('judgegift') && { judge: true }),
    cmEur: toNum(foil ? (c.prices?.eur_foil ?? c.prices?.eur) : (c.prices?.eur ?? c.prices?.eur_foil)),
    urls: {
      tp: c.purchase_uris?.tcgplayer ?? '',
      cm: c.purchase_uris?.cardmarket ?? '',
    },
  };
}

/**
 * INCLUDED_SETS のセット全カードを監視リストに追加する（ヒット判定と無関係）。
 * 追跡する仕上げは通常版優先（Foilのみのセットは Foil）。minUsd 指定時は
 * Scryfall 参考価格で選別する。既にヒットとして追跡中のカードには
 * watchSet フラグだけ付ける。
 */
async function addWatchedSets(cards, prevCards) {
  for (const { code, query, label, minUsd } of INCLUDED_SETS) {
    const name = label ?? code;
    if (code && EXCLUDED_SETS.has(code)) {
      warnings.push(`セット監視: ${code} は EXCLUDED_SETS に含まれるためスキップします`);
      continue;
    }
    let url = `https://api.scryfall.com/cards/search?q=${encodeURIComponent(query ?? `e:${code}`)}&unique=prints&order=set`;
    let total = 0;
    let added = 0;
    try {
      while (url) {
        const json = await fetchWithRetry(url);
        for (const c of json.data) {
          total++;
          // クエリ指定でヒットしたカードにも除外セットを適用する
          if (EXCLUDED_SETS.has(c.set)) continue;
          const finish = c.finishes?.includes('nonfoil')
            ? 'nonfoil'
            : c.finishes?.includes('foil')
              ? 'foil'
              : (c.finishes?.[0] ?? 'foil');
          const foil = finish !== 'nonfoil';
          const id = `${c.id}:${finish}`;
          const existing = cards.get(id);
          if (existing) {
            existing.watchSet = true;
            continue;
          }
          const refUsd = toNum(
            foil
              ? (c.prices?.usd_foil ?? c.prices?.usd_etched ?? c.prices?.usd)
              : (c.prices?.usd ?? c.prices?.usd_foil),
          );
          if (minUsd != null && (refUsd ?? 0) < minUsd) continue;
          cards.set(id, {
            id,
            ...cardFromScryfall(c, finish),
            finish,
            active: false,
            watchSet: true,
            firstTracked: prevCards.get(id)?.firstTracked ?? todayJst(),
            language: 'English',
            hyBuyJpy: null,
            hyBuyUrl: '',
            ckBuylistUsd: null,
            ckMaxQty: 0,
            netProfitJpy: null,
            profitRate: null,
            cautions: [],
          });
          added++;
        }
        url = json.has_more ? json.next_page : null;
        await sleep(150);
      }
      console.log(
        `セット監視: ${name.toUpperCase()} ${total}枚中 ${added}枚を追加${minUsd != null ? `（参考価格 $${minUsd}以上）` : ''}`,
      );
    } catch (err) {
      warnings.push(`セット監視: ${name} の取得に失敗しました (${err.message})`);
    }
  }
}

/** 追跡カードの Cardmarket 価格・画像などを /cards/collection でまとめて更新する */
async function refreshScryfall(cards) {
  console.log('Scryfall: 追跡カードの最新情報を取得中...');
  const byId = new Map(cards.map((c) => [c.sid, c]));
  const ids = [...byId.keys()];
  for (let i = 0; i < ids.length; i += 75) {
    const batch = ids.slice(i, i + 75).map((id) => ({ id }));
    const json = await fetchWithRetry('https://api.scryfall.com/cards/collection', {
      method: 'POST',
      body: JSON.stringify({ identifiers: batch }),
      headers: { 'Content-Type': 'application/json' },
    });
    for (const c of json.data ?? []) {
      const card = byId.get(c.id);
      if (!card) continue;
      const fresh = cardFromScryfall(c, card.finish);
      Object.assign(card, fresh, { urls: { ...card.urls, ...fresh.urls } });
    }
    for (const nf of json.not_found ?? []) {
      warnings.push(`Scryfall: カードが見つかりませんでした: ${nf.id}`);
    }
    await sleep(150);
  }
  // キャッシュ済みIDがScryfall側で消えた等で名前を埋められなかったカードは
  // 後続の取得ができないため追跡対象から外す
  return cards.filter((c) => {
    if (c.name) return true;
    warnings.push(`Scryfall: カード情報を取得できなかったため追跡をスキップします: ${c.sid}`);
    return false;
  });
}

/* ================ Card Kingdom（販売価格） ================ */

async function fetchCardKingdomRetail(cards) {
  console.log('Card Kingdom: pricelist APIを取得中...');
  const json = await fetchWithRetry('https://api.cardkingdom.com/api/pricelist');
  const bySid = new Map();
  for (const c of cards) {
    if (!bySid.has(c.sid)) bySid.set(c.sid, []);
    bySid.get(c.sid).push(c);
  }
  let matched = 0;
  for (const item of json.data) {
    const targets = bySid.get(item.scryfall_id);
    if (!targets) continue;
    for (const card of targets) {
      if ((item.is_foil === 'true') !== (card.finish !== 'nonfoil')) continue;
      const retail = toNum(item.price_retail);
      if (retail != null && (card.ckUsd == null || retail < card.ckUsd)) {
        card.ckUsd = retail;
        card.ckQty = item.qty_retail ?? 0;
        card.urls.ck = item.url ? `https://www.cardkingdom.com/${item.url}` : '';
        matched++;
      }
    }
  }
  console.log(`Card Kingdom: ${matched}件を照合しました`);
}

/* ================ TCGplayer（マーケットプライス履歴） ================ */

const TCG_HISTORY_API = 'https://infinite-api.tcgplayer.com/price/history';

/** 状態の優先順位。追跡はNM優先で、NMのSKUが無いカードは次善の状態を使う */
const TCG_CONDITION_RANK = {
  'Near Mint': 0,
  'Lightly Played': 1,
  'Moderately Played': 2,
  'Heavily Played': 3,
  Damaged: 4,
};

/**
 * infinite-api のレスポンスから追跡SKU（英語・追跡仕上げ・最良状態）を選び、
 * バケットを { 日付: [マーケットプライス, 販売数, 取引数] } に変換する。
 */
function pickTcgSku(result, foil) {
  const want = foil ? 'foil' : 'normal';
  const candidates = (result ?? []).filter(
    (sku) => sku.language === 'English' && (sku.variant ?? '').toLowerCase() === want,
  );
  if (candidates.length === 0) return null;
  candidates.sort(
    (a, b) => (TCG_CONDITION_RANK[a.condition] ?? 9) - (TCG_CONDITION_RANK[b.condition] ?? 9),
  );
  // 良い状態から順に、マーケットプライスが実際に入っているSKUを採用する
  // （NMのSKUはあるが全期間 price=0 という商品がある）
  for (const sku of candidates) {
    const buckets = {};
    for (const b of sku.buckets ?? []) {
      const price = toNum(b.marketPrice);
      if (price == null || price === 0 || !b.bucketStartDate) continue;
      buckets[b.bucketStartDate] = [price, Number(b.quantitySold) || 0, Number(b.transactionCount) || 0];
    }
    if (Object.keys(buckets).length > 0) {
      return { condition: sku.condition, skuId: sku.skuId, buckets };
    }
  }
  return null;
}

/**
 * 各カードの価格履歴を取得して tcgHistory にマージする。
 * 初めてのカードは annual（週次・1年分）で過去分を埋め、以降は month（日次・30日分）
 * だけ取得して日付単位で上書きマージしていく。
 */
async function fetchTcgHistories(cards, tcgHistory) {
  console.log('TCGplayer: マーケットプライス履歴を取得中...');
  let fetched = 0;
  for (const card of cards) {
    if (!card.tid) {
      warnings.push(`TCGplayer: product IDが不明のため履歴を取得できません: ${card.name} [${card.set}]`);
      continue;
    }
    const key = `${card.sid}:${card.finish}`;
    const existing = tcgHistory[key];
    const ranges = existing ? ['month'] : ['annual', 'month'];
    const foil = card.finish !== 'nonfoil';
    const merged = existing ?? { tid: card.tid, condition: null, buckets: {} };
    let ok = false;
    for (const range of ranges) {
      await sleep(DELAY_MS);
      try {
        const json = await fetchWithRetry(`${TCG_HISTORY_API}/${card.tid}/detailed?range=${range}`);
        const sku = pickTcgSku(json.result, foil);
        if (!sku) continue;
        Object.assign(merged.buckets, sku.buckets);
        merged.condition = sku.condition;
        merged.tid = card.tid;
        ok = true;
      } catch (err) {
        warnings.push(`TCGplayer: 履歴の取得に失敗しました: ${card.name} (${err.message})`);
      }
    }
    if (!ok && !existing) {
      warnings.push(
        `TCGplayer: マーケットプライス履歴がありません（販売実績なし等）: ${card.name} [${card.set}]`,
      );
      continue;
    }
    tcgHistory[key] = merged;
    // 比較テーブル用の現在値 = 履歴の最新日付のマーケットプライス
    const dates = Object.keys(merged.buckets).sort();
    const latest = dates[dates.length - 1];
    if (latest) {
      card.tpMarketUsd = merged.buckets[latest][0];
      card.tpMarketDate = latest;
      card.tpCond = merged.condition;
    }
    if (ok) fetched++;
  }
  console.log(`TCGplayer: ${fetched}/${cards.length}枚の履歴を取得しました`);
  if (cards.length > 0 && fetched === 0) {
    warnings.push('TCGplayer: 履歴を1件も取得できませんでした（APIの仕様変更の可能性）');
  }
}

/* ================ 晴れる屋（販売価格） ================ */

const HY_SEARCH_API = 'https://www.hareruyamtg.com/ja/products/search/unisearch_api';
const HY_CONDITION_RANK = { NM: 0, SP: 1, MP: 2, HP: 3 };

/** 商品詳細ページから状態別の価格・在庫を抜き出す（fetch-tracker-prices.mjs と同じ） */
function parseDetailConditions(html) {
  const rows = [];
  const re =
    /productClassChange[^>]*data-language="([A-Z]+)"[\s\S]{0,400}?<strong>\s*([A-Za-z+-]+)\s*<\/strong>[\s\S]{0,600}?<div class="col-xs-3[^"]*">￥([\d,]+)<\/div>\s*<div class="col-xs-2">([\d,]+)<\/div>/g;
  for (const m of html.matchAll(re)) {
    rows.push({
      language: m[1],
      condition: m[2],
      price: Number(m[3].replace(/,/g, '')),
      stock: Number(m[4].replace(/,/g, '')),
    });
  }
  return rows;
}

/** 商品名から [SET] とコレクター番号 (138) を抜き出す */
/**
 * 晴れる屋の商品名セット表記の別名。Amonkhet Invocations (MP2) は商品名では
 * Kaladesh Inventions と同じ [MPS] と表記される（カード名が重複しないため
 * 名前照合と組み合わせれば誤マッチしない）。
 */
const HY_SET_LABEL_ALIAS = { MP2: 'MPS' };

/** ダブルレインボウ（シリアル入り）商品の商品名マーカー */
const HY_DR_MARKER = /ダブルレインボウ|シリアル|serial|【DR/i;

/**
 * ヒット判定を経ないカード（セット監視等）に晴れる屋の買取価格を対応付ける。
 * 利益チェッカーの買取データ（jpRows）を セット・カード名・Foil・番号 で照合し、
 * hyBuyJpy が未設定のカードにだけ埋める。言語は他ソースに合わせて英語版のみ。
 *
 * ダブルレインボウ版は買取データの note からDRマーカーが失われており
 * 同番のハロー版等と区別できないため対象外。同名DR版が存在するFoilカードも
 * 誤って高額なDR買取価格を拾わないようスキップする。
 */
/**
 * 買取タイトルのセット表記の別名。Amonkhet Invocations は販売商品名では [MPS] だが
 * 買取検索のタイトルでは [MPS2] と表記される。
 */
const HY_BUY_SET_ALIAS = { MP2: ['MPS2'] };

function backfillHyBuy(cards, jpRows) {
  const rowCnOf = (jp) => jp.note.match(/#0*(\d+)/)?.[1] ?? null;
  const index = new Map();
  for (const jp of jpRows) {
    if (!isEnglish(jp.language)) continue;
    const key = `${normalizeSetCode(jp.setCode)}|${normalizeCardName(jp.cardName)}|${jp.isFoil ? 'F' : 'N'}`;
    const list = index.get(key);
    if (list) list.push(jp);
    else index.set(key, [jp]);
  }

  // ジャッジ褒賞の買取行（買取タイトルは [ジャッジ褒賞]。noteから年版表記が
  // 失われるため、同名Foil行が一意な場合だけ採用する）
  const judgeBuyIndex = new Map();
  for (const jp of jpRows) {
    if (!isEnglish(jp.language) || jp.setCode !== 'ジャッジ褒賞') continue;
    const key = `${normalizeCardName(jp.cardName)}|${jp.isFoil ? 'F' : 'N'}`;
    const list = judgeBuyIndex.get(key);
    if (list) list.push(jp);
    else judgeBuyIndex.set(key, [jp]);
  }

  // 同名のダブルレインボウ版が存在する セット|名前 （Foil側の誤照合防止に使う）
  const drSiblings = new Set();
  for (const c of cards) {
    if (c.dr) drSiblings.add(`${normalizeSetCode(c.set ?? '')}|${normalizeCardName(c.name ?? '')}`);
  }

  let filled = 0;
  for (const card of cards) {
    if (card.hyBuyJpy != null || !card.name || card.dr) continue;
    const foil = card.finish !== 'nonfoil';
    if (card.judge) {
      const rows =
        judgeBuyIndex.get(`${normalizeCardName(card.name)}|${foil ? 'F' : 'N'}`) ?? [];
      if (rows.length === 1) {
        card.hyBuyJpy = rows[0].hareruyaBuyPriceJPY;
        card.hyBuyUrl = rows[0].url ?? '';
        filled++;
      }
      continue;
    }
    const setCode = normalizeSetCode(card.hySetCode || card.set || '');
    const nameKey = normalizeCardName(card.name);
    if (foil && drSiblings.has(`${normalizeSetCode(card.set ?? '')}|${nameKey}`)) continue;

    const setCodes = [setCode, ...(HY_BUY_SET_ALIAS[setCode] ?? [])];
    // 変身カード等は表面の名前でも照合する
    const nameKeys = [nameKey];
    const front = nameKey.split(' // ')[0];
    if (front && front !== nameKey) nameKeys.push(front);
    const wantCn = String(card.cn ?? '').replace(/\D+/g, '');

    let best = null;
    let bestScore = -1;
    for (const code of setCodes) {
      for (const nk of nameKeys) {
        for (const jp of index.get(`${code}|${nk}|${foil ? 'F' : 'N'}`) ?? []) {
          const rowCn = rowCnOf(jp);
          // 番号が両方わかっていて食い違う行は別版
          if (rowCn && wantCn && rowCn.replace(/^0+/, '') !== wantCn.replace(/^0+/, '')) continue;
          const score = rowCn && wantCn ? 2 : rowCn ? 0.5 : 1;
          if (
            score > bestScore ||
            (score === bestScore && jp.hareruyaBuyPriceJPY > (best?.hareruyaBuyPriceJPY ?? -1))
          ) {
            best = jp;
            bestScore = score;
          }
        }
      }
    }
    if (best) {
      card.hyBuyJpy = best.hareruyaBuyPriceJPY;
      card.hyBuyUrl = best.url ?? '';
      filled++;
    }
  }
  console.log(`晴れる屋買取: ヒット外の${filled}枚に買取価格を対応付けました`);
}

function parseHyProductName(name) {
  const set = name.match(/\[([0-9A-Za-z-]+)\]/);
  const cn = name.match(/\((\d+[a-z]?)\)/i);
  return {
    set: set ? normalizeSetCode(set[1].split('-')[0]) : null,
    cn: cn ? cn[1].replace(/^0+/, '').toLowerCase() : null,
  };
}

/**
 * 1枚のカードの晴れる屋販売価格を取得する。
 * kw= のカード名検索で在庫あり商品を列挙 → 買取行と同じセット・Foil有無
 * （番号があれば番号も）の商品に絞り、詳細ページの状態別在庫から
 * 「在庫のある最良状態（NM優先）の最安値」を採用する。
 */
async function fetchHareruyaRetail(card) {
  if (!card.name) return;
  const searchName = card.name.split(' // ')[0];
  const url = `${HY_SEARCH_API}?kw=${encodeURIComponent(searchName)}&fq.stock=1%7E%2A&rows=60`;
  let docs;
  try {
    const json = await fetchWithRetry(url, { headers: { 'X-Requested-With': 'XMLHttpRequest' } });
    docs = json.response?.docs ?? [];
  } catch (err) {
    warnings.push(`晴れる屋: 検索に失敗しました: ${card.name} (${err.message})`);
    return;
  }

  const wantFoil = card.finish !== 'nonfoil';
  const wantSet = normalizeSetCode(card.hySetCode || card.set);
  const wantCn = String(card.cn ?? '').replace(/^0+/, '').replace(/\D+$/, '').toLowerCase();
  const wantName = normalizeCardName(card.name);

  const products = new Set();
  for (const doc of docs) {
    if ((doc.foil_flg === '1') !== wantFoil) continue;
    // ダブルレインボウ版は晴れる屋では「【ダブルレインボウ・Foil】(136)《...》(シリアル入り)」
    // のようにマーカー付き・番号は z なしで出品されるため、マーカーの有無で対応付ける
    // （DRカードはマーカー付き商品のみ、通常カードはマーカー付き商品を除外）
    if (HY_DR_MARKER.test(`${doc.product_name ?? ''} ${doc.product_name_en ?? ''}`) !== !!card.dr) {
      continue;
    }
    const docName = normalizeCardName(doc.card_name ?? '');
    if (docName && !wantName.split(' // ').some((f) => f === docName) && docName !== wantName) {
      continue;
    }
    if (card.judge) {
      // ジャッジ褒賞はセット表記が [ジャッジ褒賞]/[Judge Foil]/[DCIマーク] で
      // Scryfallの年度別セットコード (j20等) と対応しないため、マーカーと
      // 「(2020年版)」の年表記（あれば）で照合する
      const names = `${doc.product_name ?? ''} ${doc.product_name_en ?? ''}`;
      if (!/ジャッジ褒賞|Judge\s*Foil/i.test(names)) continue;
      const year = names.match(/\((\d{4})年版/)?.[1];
      const relYear = (card.released ?? '').slice(0, 4);
      if (year && relYear && year !== relYear) continue;
    } else {
      const parsed = parseHyProductName(doc.product_name_en || doc.product_name || '');
      if (parsed.set !== wantSet && parsed.set !== HY_SET_LABEL_ALIAS[wantSet]) continue;
      // 同一セットに同名の別版がある場合に備え、番号が両方わかるときだけ番号でも絞る
      // （DR版のScryfall番号は「136z」だが商品名は「(136)」なので末尾の英字を無視して比較）
      if (parsed.cn && wantCn && parsed.cn.replace(/\D+$/, '') !== wantCn) continue;
    }
    products.add(doc.product);
    if (products.size >= 3) break; // 詳細ページの取得は3商品まで
  }

  const candidates = [];
  for (const product of products) {
    await sleep(DELAY_MS);
    const detailUrl = `https://www.hareruyamtg.com/ja/products/detail/${product}`;
    try {
      const rows = parseDetailConditions(await fetchWithRetry(detailUrl, { as: 'text' }));
      for (const row of rows) {
        // 他ソース（TCGplayer/CK/Cardmarket）が英語版の価格なので、
        // 晴れる屋も英語版の在庫だけを参照して言語を統一する
        if (row.stock > 0 && row.language === 'EN') candidates.push({ ...row, product });
      }
    } catch (err) {
      warnings.push(`晴れる屋: 商品ページの取得に失敗しました: ${detailUrl} (${err.message})`);
    }
  }
  if (candidates.length === 0) return;

  const rank = (c) => HY_CONDITION_RANK[c.condition] ?? 9;
  const best = candidates.reduce((a, b) =>
    rank(b) < rank(a) || (rank(b) === rank(a) && b.price < a.price) ? b : a,
  );
  card.hyJpy = best.price;
  card.hyStock = best.stock;
  card.hyCond = best.condition;
  card.urls.hy = `https://www.hareruyamtg.com/ja/products/detail/${best.product}`;
}

/* ================ 履歴スナップショット ================ */

function todayJst() {
  return new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
}

async function updateHistory(cards) {
  const path = join(OUT_DIR, 'history.json');
  const history = (await readJson(path)) ?? { snapshots: [] };
  const date = todayJst();
  const prices = {};
  for (const c of cards) {
    // [晴れる屋買取JPY, 晴れる屋販売JPY, CK販売USD, TCGマーケットUSD, Cardmarket EUR, 晴れる屋在庫, CK在庫]
    prices[c.id] = [
      c.hyBuyJpy ?? null,
      c.hyJpy ?? null,
      c.ckUsd ?? null,
      c.tpMarketUsd ?? null,
      c.cmEur ?? null,
      c.hyStock ?? 0,
      c.ckQty ?? 0,
    ];
  }
  history.snapshots = history.snapshots.filter((s) => s.date !== date);
  history.snapshots.push({ date, prices });
  history.snapshots.sort((a, b) => a.date.localeCompare(b.date));
  await writeFile(path, JSON.stringify(history));
  return history.snapshots.length;
}

/* ================ main ================ */

async function main() {
  const startedAt = Date.now();

  // 1. 利益チェッカーの価格データを読み込む
  const jpRows = await readJson(join(PROFIT_DIR, 'hareruya.json'));
  const ckRows = await readJson(join(PROFIT_DIR, 'cardkingdom.json'));
  const profitMeta = await readJson(join(PROFIT_DIR, 'meta.json'), {});
  if (!jpRows || !ckRows) {
    throw new Error(
      `利益チェッカーの価格データが見つかりません (${PROFIT_DIR})。` +
        'mtg-profit-checker 側で npm run update:profit を先に実行してください',
    );
  }
  console.log(
    `利益チェッカーのデータ: 晴れる屋 ${jpRows.length}件 / Card Kingdom ${ckRows.length}件 (更新 ${profitMeta.updatedAt ?? '不明'})`,
  );

  // 2. 照合してヒットカードを選定する
  const usdJpy = await fetchUsdJpy();
  console.log(`照合・利益計算中... (USD/JPY=${usdJpy.toFixed(2)}, 最低利益 ¥${MIN_PROFIT_JPY}, 最低利益率 ${MIN_RATE * 100}%)`);
  const index = buildCkIndex(ckRows);
  const hitsByKey = new Map();
  for (const jp of jpRows) {
    const pair = matchOne(jp, index);
    if (!pair) continue;
    const hit = buildHit(pair, usdJpy);
    const key = hitKey(jp);
    const prev = hitsByKey.get(key);
    // 同じ版・仕上げに複数の買取行（言語違い等）がある場合は利益が大きい方を代表にする
    if (!prev || hit.netProfitJpy > prev.netProfitJpy) hitsByKey.set(key, hit);
  }
  const allHits = [...hitsByKey.values()];
  const hits = allHits
    .filter(isHit)
    .filter((h) => !EXCLUDED_SETS.has(normalizeSetCode(h.jp.setCode).toLowerCase()))
    .sort((a, b) => b.netProfitJpy - a.netProfitJpy);
  console.log(
    `照合 ${allHits.length}件中、ヒット ${hits.length}件（除外セット: ${[...EXCLUDED_SETS].join(',') || 'なし'}・上位 ${Math.min(hits.length, WATCH_MAX)}件を追跡対象に）`,
  );

  // 3. 前回の追跡カードを読み込む（一度追跡したカードは履歴を継続する）
  const prevCatalog = await readJson(join(OUT_DIR, 'cards.json'), { cards: [] });
  const prevCards = new Map(prevCatalog.cards.map((c) => [c.id, c]));

  // 4. ヒットカードを Scryfall の版に解決する（結果はキャッシュして再利用）
  const cache = (await readJson(CACHE_PATH)) ?? {};
  const cards = new Map(); // id (sid:finish) → card
  let resolveFail = 0;

  for (const hit of hits.slice(0, WATCH_MAX)) {
    const key = hitKey(hit.jp);
    let entry = cache[key];
    if (entry === undefined) {
      await sleep(150);
      let print = null;
      try {
        print = await resolvePrint(hit.jp);
      } catch (err) {
        warnings.push(`Scryfall: 解決中にエラー: ${hit.jp.cardName} [${hit.jp.setCode}] (${err.message})`);
        continue; // 一時的なエラーはキャッシュせず次回再試行する
      }
      entry = print ? { sid: print.id, snapshot: print } : null;
      cache[key] = print ? { sid: print.id } : null;
      if (print) cache[key].name = print.name; // キャッシュの可読性のため
    }
    if (entry === null) {
      resolveFail++;
      continue;
    }

    const finish = hit.jp.isFoil ? 'foil' : 'nonfoil';
    const id = `${entry.sid}:${finish}`;
    const existing = cards.get(id);
    if (existing) {
      // 別の買取行が同じ版・仕上げに解決された場合は利益が大きい方を代表にする
      if (hit.netProfitJpy <= existing.netProfitJpy) continue;
    }
    const base = entry.snapshot
      ? cardFromScryfall(entry.snapshot, finish)
      : { sid: entry.sid, urls: {} };
    cards.set(id, {
      id,
      ...base,
      finish,
      active: true,
      firstTracked: prevCards.get(id)?.firstTracked ?? todayJst(),
      hySetCode: normalizeSetCode(hit.jp.setCode),
      language: hit.jp.language,
      // ヒット情報
      hyBuyJpy: hit.jp.hareruyaBuyPriceJPY,
      hyBuyUrl: hit.jp.url ?? '',
      ckBuylistUsd: hit.ck.ckBuyPriceUSD,
      ckMaxQty: hit.ck.ckMaxQty,
      netProfitJpy: Math.round(hit.netProfitJpy),
      profitRate: Math.round(hit.profitRate * 1000) / 1000,
      cautions: hit.cautions,
    });
  }
  if (resolveFail > 0) {
    console.log(`Scryfall: ${resolveFail}件はScryfallの版に解決できず追跡対象外です`);
  }

  // 4.5 セット指定の監視リストを追加する
  await addWatchedSets(cards, prevCards);

  // 4.6 手動監視リスト（data/manual-watchlist.json）を追加する。
  //     カード情報は後続の refreshScryfall が Scryfall ID から埋める
  const manualList = (await readJson(join(ROOT, 'data', 'manual-watchlist.json'))) ?? {
    cards: [],
  };
  for (const m of manualList.cards) {
    const id = `${m.sid}:${m.finish}`;
    const existing = cards.get(id);
    if (existing) {
      existing.manual = true;
      continue;
    }
    cards.set(id, {
      id,
      sid: m.sid,
      finish: m.finish,
      urls: {},
      manual: true,
      active: false,
      firstTracked: prevCards.get(id)?.firstTracked ?? todayJst(),
      language: 'English',
      hyBuyJpy: null,
      hyBuyUrl: '',
      ckBuylistUsd: null,
      ckMaxQty: 0,
      netProfitJpy: null,
      profitRate: null,
      cautions: [],
    });
  }
  if (manualList.cards.length > 0) {
    console.log(`手動監視: ${manualList.cards.length}枚を追跡対象に含めました`);
  }
  // 本番サイトの読み取り専用表示用に public 側へも複製する
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(join(OUT_DIR, 'manual-watchlist.json'), JSON.stringify(manualList));

  // 5. 前回追跡していて今回ヒットしなかったカードを active:false で引き継ぐ。
  //    解決済みキャッシュを使って「今回の照合結果のうち同じ版・仕上げの行」を対応付け、
  //    ヒット外でも買取価格・利益は最新化する
  const hitById = new Map();
  for (const h of allHits) {
    const cached = cache[hitKey(h.jp)];
    if (!cached?.sid) continue;
    const id = `${cached.sid}:${h.jp.isFoil ? 'foil' : 'nonfoil'}`;
    const prev = hitById.get(id);
    if (!prev || h.netProfitJpy > prev.netProfitJpy) hitById.set(id, h);
  }
  for (const [id, prev] of prevCards) {
    if (cards.has(id)) continue;
    // 除外セットに指定されたカードは過去に追跡していてもカタログから外す
    if (EXCLUDED_SETS.has((prev.set ?? '').toLowerCase())) continue;
    // セット監視・手動監視のみで追跡していたカードは、条件（しきい値・クエリ・
    // リストからの削除）から外れたらカタログからも外す。
    // ヒット経験のあるカードは「ヒット外」として残す
    if ((prev.watchSet || prev.manual) && !prev.active) continue;
    const stale = hitById.get(id);
    cards.set(id, {
      ...prev,
      active: false,
      // セット監視・手動監視から外れた場合はフラグを落とす（監視中ならこのループに来ない）
      watchSet: false,
      manual: false,
      // 買取価格・利益はヒット外でも照合できた場合のみ更新する
      ...(stale && {
        hyBuyJpy: stale.jp.hareruyaBuyPriceJPY,
        hyBuyUrl: stale.jp.url ?? '',
        ckBuylistUsd: stale.ck.ckBuyPriceUSD,
        ckMaxQty: stale.ck.ckMaxQty,
        netProfitJpy: Math.round(stale.netProfitJpy),
        profitRate: Math.round(stale.profitRate * 1000) / 1000,
        cautions: stale.cautions,
      }),
      // 当日の販売価格はこの後の取得で上書きする（取れなければ null のまま）
      hyJpy: null,
      hyStock: 0,
      hyCond: undefined,
      ckUsd: null,
      ckQty: 0,
      cmEur: null,
    });
  }

  const allCards = [...cards.values()];
  if (allCards.length === 0) {
    throw new Error('追跡対象カードが0枚です。ヒット条件（MIN_PROFIT_JPY等）を確認してください');
  }
  console.log(`追跡対象: ${allCards.length}枚 (アクティブ ${allCards.filter((c) => c.active).length}枚)`);

  await mkdir(dirname(CACHE_PATH), { recursive: true });
  await writeFile(CACHE_PATH, JSON.stringify(cache));

  // 6. 各ソースの価格・履歴を取得する
  // 晴れる屋とScryfallでセットコードが異なる場合に備え、解決後のセットでも除外を適用する
  // 手動監視のカードはユーザーが明示的に選んだものなので除外セットより優先する
  const trackedCards = (await refreshScryfall(allCards)).filter(
    (c) => c.manual || !EXCLUDED_SETS.has((c.set ?? '').toLowerCase()),
  );
  backfillHyBuy(trackedCards, jpRows);
  await fetchCardKingdomRetail(trackedCards);

  const tcgHistory = (await readJson(join(OUT_DIR, 'tcg-history.json'))) ?? {};
  await fetchTcgHistories(trackedCards, tcgHistory);
  // 追跡から外れたカード（除外セット等）の履歴エントリを掃除する
  const trackedIds = new Set(trackedCards.map((c) => c.id));
  for (const id of Object.keys(tcgHistory)) {
    if (!trackedIds.has(id)) delete tcgHistory[id];
  }
  // 後続フェーズで失敗しても取得済みの履歴が失われないよう、この時点で保存する
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(join(OUT_DIR, 'tcg-history.json'), JSON.stringify(tcgHistory));

  console.log('晴れる屋: 販売価格を取得中...');
  let hyMatched = 0;
  for (const card of trackedCards) {
    await sleep(DELAY_MS);
    await fetchHareruyaRetail(card);
    if (card.hyJpy != null) hyMatched++;
  }
  console.log(`晴れる屋: ${hyMatched}/${trackedCards.length}枚の在庫あり販売価格を取得しました`);

  // 7. 出力
  const counts = {
    cards: trackedCards.length,
    active: trackedCards.filter((c) => c.active).length,
    watchSet: trackedCards.filter((c) => c.watchSet).length,
    manual: trackedCards.filter((c) => c.manual).length,
    hareruya: trackedCards.filter((c) => c.hyJpy != null).length,
    cardKingdom: trackedCards.filter((c) => c.ckUsd != null).length,
    tcgplayer: trackedCards.filter((c) => c.tpMarketUsd != null).length,
    cardmarket: trackedCards.filter((c) => c.cmEur != null).length,
  };

  const snapshotCount = await updateHistory(trackedCards);
  await writeFile(
    join(OUT_DIR, 'cards.json'),
    JSON.stringify({
      updatedAt: new Date().toISOString(),
      profitDataUpdatedAt: profitMeta.updatedAt ?? null,
      usdJpy,
      settings: {
        minProfitJpy: MIN_PROFIT_JPY,
        minRatePct: MIN_RATE * 100,
        fxFeePct: FX_FEE_RATE * 100,
        condDownPct: COND_DOWN_RATE * 100,
        watchMax: WATCH_MAX,
      },
      counts,
      snapshotCount,
      durationSec: Math.round((Date.now() - startedAt) / 1000),
      warnings,
      cards: trackedCards,
    }),
  );

  console.log(
    `完了: ${counts.cards}枚 (晴れる屋 ${counts.hareruya} / CK ${counts.cardKingdom} / TCG ${counts.tcgplayer} / CM ${counts.cardmarket}) ` +
      `履歴 ${snapshotCount}日分 (${Math.round((Date.now() - startedAt) / 1000)}秒, ${requestCount}リクエスト)`,
  );
  if (warnings.length > 0) console.warn('警告:\n- ' + warnings.slice(0, 50).join('\n- '));
}

main().catch((err) => {
  console.error('取得失敗:', err);
  process.exit(1);
});
