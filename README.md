# MTG マーケットウォッチ

[mtg-profit-checker](../mtg-profit-checker) の**ヒットカード**（晴れる屋買取 vs Card Kingdom
Buylist で利益が出そうなカード）を自動で追跡対象にし、

1. **TCGplayer のマーケットプライス履歴**（内部API `infinite-api.tcgplayer.com`、最大1年分）
2. **4ソースの販売価格**（晴れる屋 / Card Kingdom / TCGplayer / Cardmarket）

を**1日1回自動取得**して推移をチャート表示するローカル Web アプリです。

- React + TypeScript + Vite（mtg-profit-checker と同じ構成・ポートは 5174）
- 価格データはローカルの JSON ファイル（`public/data/`）から読み込み。サーバー送信なし

## 起動方法

```bash
export PATH="$HOME/.local/node/bin:$PATH"
npm install
npm run update   # 価格データを取得（初回必須。300枚で30〜40分程度）
npm run dev      # http://localhost:5174
```

> **前提**: mtg-profit-checker 側の価格データ
> （`../mtg-profit-checker/public/prices/{hareruya,cardkingdom}.json`）が必要です。
> 無い場合は先に mtg-profit-checker で `npm run update:profit` を実行してください。

## 仕組み

### ヒットカードの自動選定

`scripts/fetch-market-data.mjs` が利益チェッカーの照合・利益計算ロジック
（matcher.ts / calculator.ts の移植）で全買取行を照合し、

> 実質利益 ≥ `MIN_PROFIT_JPY`（既定 ¥3,000）かつ 利益率 ≥ `MIN_RATE_PCT`（既定 15%）
> かつ CK が買取受付中

のカードを実質利益の高い順に `WATCH_MAX` 枚（既定 300）まで追跡対象にします。
**一度追跡したカードはヒットから外れても履歴を継続**します（UI では「ヒット外」表示）。

`EXCLUDED_SETS`（既定 `30a,7ed` = 30th Anniversary Edition と Seventh Edition）に指定した
セットは追跡対象外です。過去に追跡していたカードも次回実行時にカタログ・履歴から取り除かれます。

### セット単位の監視リスト

**ヒット判定と無関係に**指定セットの全カードを監視リストに含めます
（UI では青い「セット監視」バッジ）。恒久設定はスクリプトの `DEFAULT_INCLUDED_SETS`：

| 指定 | 対象 |
| --- | --- |
| EXP / MPS / MP2 | 全カード（Foilのみのセットなので Foil を追跡） |
| SLD | Scryfall 参考価格 **$30以上**・**基本地形を除く**（`e:sld -t:basic`） |
| LTC / FIC / SOA | Scryfall 参考価格 **$20以上** |
| `is:doublerainbow` | Double Rainbow Foil（セット横断・$20以上） |

セット監視のカードは条件（しきい値・クエリ）から外れると次回実行時にカタログからも
外れます（再び条件を満たせば TCGplayer 履歴は過去1年分を取り直せるため実害なし）。
ヒット経験のあるカードは従来どおり「ヒット外」として履歴を継続します。
セットコードのほか `query`（Scryfall 検索クエリ）でセット横断の特殊仕上げも指定できます。
一時的な上書きは環境変数で: `INCLUDED_SETS=exp,sld:30 npm run update:data`

### 各カードの取得内容

| データ | 取得元 |
| --- | --- |
| 版の特定 | Scryfall（セットコード + コレクター番号 → `tcgplayer_id` 等。結果は `data/resolve-cache.json` にキャッシュ） |
| TCGplayer 市場価格履歴 | `infinite-api.tcgplayer.com/price/history/{productId}/detailed`。英語・追跡仕上げ・最良状態（NM優先）のSKUのマーケットプライス。初回は annual（週次・1年分）、以降は month（日次・30日分）を取得して日付単位でマージ蓄積 |
| 晴れる屋 販売 (JPY) | `unisearch_api` のカード名検索（`kw=`）→ セット・Foil・番号で商品を特定 → 商品ページの状態別在庫から「在庫のある最良状態（NM優先）の最安値」。他ソースと言語を揃えるため**英語版の在庫のみ**参照（日本語版しか在庫がない場合は「在庫なし」扱い） |
| Card Kingdom 販売 (USD) | 公開API `api.cardkingdom.com/api/pricelist` の `price_retail`（scryfall_id + Foil有無で照合） |
| Cardmarket (EUR) | Scryfall `/cards/collection` の `prices.eur / eur_foil` |
| 晴れる屋 買取 (JPY) / CK Buylist (USD) | 利益チェッカーの出力をそのまま利用（追加リクエストなし） |

出力は `public/data/` に:

- `cards.json` … カードカタログ + 最新価格 + ヒット情報（毎回上書き）
- `history.json` … 4ソース価格の日次スナップショット蓄積（同日再実行はその日の分だけ上書き）
- `tcg-history.json` … TCGplayer マーケットプライス履歴（日付マージで蓄積）

環境変数で調整できます:

```bash
MIN_PROFIT_JPY=5000 MIN_RATE_PCT=20 WATCH_MAX=150 EXCLUDED_SETS=30a,sld npm run update
```

### 既知の制限

- TCGplayer の infinite-api は**非公開の内部API**のため、予告なく仕様変更される可能性があります
- 30th Anniversary（30A）や一部の古いカードなど、TCGplayer に販売実績がない商品は履歴が
  取得できません（取得時の警告に表示されます）
- 同一コレクター番号に複数バリアント（NEOのネオンインク等）があるカードは、
  利益チェッカー同様に別バリアントを照合してしまうことがあります（⚠マークの注意事項を確認してください）

## 1日1回の自動実行（launchd）

毎朝 **8:30**（利益チェッカーの7:00の更新後）に `scripts/update-all.mjs` が自動実行され、
データ取得後に `public/data` へ変更があれば **git commit & push** します
（push が本番デプロイをトリガー）。push なしで取得だけしたい場合は `npm run update:data`。

- 定義ファイル: `launchd/com.nojimay.mtg-market-watch.plist`
- ログ: `logs/update.log`
- スリープしていた場合は復帰後に実行されます（ログアウト中は実行されません）

登録・解除:

```bash
# 登録
cp launchd/com.nojimay.mtg-market-watch.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.nojimay.mtg-market-watch.plist

# 解除
launchctl bootout gui/$(id -u)/com.nojimay.mtg-market-watch

# すぐに1回実行
launchctl kickstart gui/$(id -u)/com.nojimay.mtg-market-watch
```

## デプロイ（Cloudflare Pages）

本番: <https://mtg-market-watch.pages.dev>

- **Cloudflare Pages の Git連携**を使用（mtg-profit-checker の GitHub Actions 方式とは異なり、
  APIトークンや Secrets の登録が不要）。`main` への push を Cloudflare が直接検知して
  ビルド（`npm run build` → `dist`、環境変数 `NODE_VERSION=24`）・デプロイします
- 価格データはローカルの launchd（毎朝8:30）が取得し、`scripts/update-all.mjs` が
  自動で commit & push → そのままデプロイまで流れます
- 手動デプロイは Cloudflare ダッシュボード > Workers & Pages > mtg-market-watch から
  「Retry deployment」、またはコードを push するだけです

## 画面

- **急上昇ピックアップ**: TCGplayer市場価格が90日で **+15%以上** 上昇しているカードを
  上昇率順にパネル表示（最大12枚）。チップをクリックすると該当行までスクロールして
  履歴チャートを展開します。しきい値・枚数は `src/App.tsx` の `SURGE_MIN_PCT` / `SURGE_MAX`
- 追跡カードの一覧テーブル: 実質利益（+CK買取価格・注意事項⚠）と5列の価格
  （晴れる屋買取 / 晴れる屋販売 / Card Kingdom / TCGplayer市場 / Cardmarket）
- 各価格には前日比（TCGplayer列は7日変動）と在庫数を表示
- 行クリックで価格履歴チャートを展開。TCGplayer のマーケットプライス履歴（最大1年）と
  他ソースの日次記録を同じ時間軸に円換算で重ね描き
- 並び替え: 実質利益順 / TCG市場の7日・30日変動順 / 販売ソース間の差額順 など
- 「円換算で表示」で全ソースをJPY表示（為替は open.er-api.com から取得）
