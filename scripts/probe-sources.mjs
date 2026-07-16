/**
 * データソース到達性プローブ
 *
 * GitHub Actions などの外部環境から各データソースにアクセスできるか確認する。
 * ブロックされやすいデータセンターIPからの実行可否を判断するためのもので、
 * 各ソースに数リクエストだけ投げて結果を表で出力する。
 * ひとつでも失敗（BLOCKED/ERROR）があれば終了コード 1。
 */
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const results = [];

async function probe(name, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true, ms: Date.now() - started, detail });
  } catch (err) {
    results.push({ name, ok: false, ms: Date.now() - started, detail: err.message });
  }
}

const get = async (url, { headers = {}, as = 'json' } = {}) => {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, ...headers } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return as === 'text' ? res.text() : res.json();
};

// 1. Scryfall（カタログ・Cardmarket価格）
await probe('Scryfall API', async () => {
  const json = await get('https://api.scryfall.com/cards/named?exact=Lightning+Bolt');
  return `card: ${json.name}`;
});

// 2. Card Kingdom pricelist（販売・買取価格）
await probe('Card Kingdom pricelist', async () => {
  const res = await fetch('https://api.cardkingdom.com/api/pricelist', {
    headers: { 'User-Agent': USER_AGENT },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const reader = res.body.getReader();
  const { value } = await reader.read();
  await reader.cancel();
  return `first chunk: ${value?.length ?? 0} bytes`;
});

// 3. TCGplayer 価格履歴（infinite-api・Cloudflare配下）
await probe('TCGplayer infinite-api (price history)', async () => {
  const json = await get('https://infinite-api.tcgplayer.com/price/history/121/detailed?range=month');
  return `skus: ${json.count}`;
});

// 4. TCGplayer 出品検索（mp-search-api）
await probe('TCGplayer mp-search-api (listings)', async () => {
  const res = await fetch('https://mp-search-api.tcgplayer.com/v1/product/121/listings', {
    method: 'POST',
    headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      filters: {
        term: { sellerStatus: 'Live', channelId: 0, language: ['English'], listingType: 'standard' },
        range: { quantity: { gte: 1 } },
        exclude: { channelExclusion: 0 },
      },
      from: 0,
      size: 1,
      sort: { field: 'price+shipping', order: 'asc' },
      context: { shippingCountry: 'US', cart: {} },
      aggregations: ['listingType'],
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  return `results: ${json.results?.[0]?.totalResults ?? 0}`;
});

// 5. 晴れる屋 unisearch_api（販売価格の検索）
await probe('Hareruya unisearch_api', async () => {
  const json = await get(
    'https://www.hareruyamtg.com/ja/products/search/unisearch_api?kw=Lightning%20Bolt&fq.stock=1%7E%2A&rows=5',
    { headers: { 'X-Requested-With': 'XMLHttpRequest' } },
  );
  return `numFound: ${json.response?.numFound ?? 0}`;
});

// 6. 晴れる屋 商品詳細ページ（状態別在庫のスクレイピング）
await probe('Hareruya product detail page', async () => {
  const html = await get('https://www.hareruyamtg.com/ja/products/detail/69724', { as: 'text' });
  const hasConditions = /productClassChange/.test(html);
  if (!hasConditions) throw new Error('ページ構造が想定と異なります（ブロックページの可能性）');
  return `html: ${html.length} bytes, 状態別在庫あり`;
});

// 7. 晴れる屋 買取検索ページ（profit-checker が使うスクレイピング先）
await probe('Hareruya purchase search (profit-checker)', async () => {
  const html = await get(
    'https://www.hareruyamtg.com/ja/purchase/search?product=&stock=1&sort=price&order=DESC&page=1&rarity%5B%5D=1',
    { as: 'text' },
  );
  const items = html.split('<div class="itemDataWrapper">').length - 1;
  if (items === 0) throw new Error(`商品が0件（ブロックページの可能性・${html.length} bytes）`);
  return `items on page1: ${items}`;
});

// 8. 為替レートAPI
await probe('open.er-api.com (為替)', async () => {
  const json = await get('https://open.er-api.com/v6/latest/USD');
  return `USD/JPY: ${json.rates?.JPY}`;
});

console.log('\n===== プローブ結果 =====');
let failed = 0;
for (const r of results) {
  const mark = r.ok ? 'OK ' : 'NG ';
  if (!r.ok) failed++;
  console.log(`${mark} ${r.name.padEnd(45)} ${String(r.ms).padStart(6)}ms  ${r.detail}`);
}
console.log(`\n${results.length - failed}/${results.length} ソース到達可能`);
process.exit(failed > 0 ? 1 : 0);
