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
| `is:judgegift` | ジャッジ褒賞Foil（年度別セット横断・$20以上）。晴れる屋は `[ジャッジ褒賞]`/`[Judge Foil]` 表記のため専用照合（同名の年版違いは「(2020年版)」表記と発売年で対応付け） |
| `e:ltr date>=2023-11-01` | LTR ホリデーリリース（ltr セット内の 2023-11-03 追加分 #452〜・$20以上） |

セット監視のカードは条件（しきい値・クエリ）から外れると次回実行時にカタログからも
外れます（再び条件を満たせば TCGplayer 履歴は過去1年分を取り直せるため実害なし）。
ヒット経験のあるカードは従来どおり「ヒット外」として履歴を継続します。
セットコードのほか `query`（Scryfall 検索クエリ）でセット横断の特殊仕上げも指定できます。
一時的な上書きは環境変数で: `INCLUDED_SETS=exp,sld:30 npm run update:data`

### 手動監視リスト

セット単位ではなく**1枚単位**で監視したいカードは、`npm run dev` 中に画面の
「手動監視リスト」パネルから追加できます（Scryfallのカード名検索 → 版と仕上げを選択）。
UI では緑の「手動」バッジ。手動監視のカードは価格しきい値・`EXCLUDED_SETS` に関係なく
常に追跡され、リストから削除すると次回実行でカタログからも外れます。

- 保存先は `data/manual-watchlist.json`（追加・削除のたびに自動 commit & push され、
  翌朝のCI実行にも反映される。オフライン時は次回の update-all のコミットに相乗り）
- 追加直後は「次回更新で追跡開始」表示。すぐ反映したい場合は「今すぐ更新」ボタン

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

## 1日1回の自動実行

定期実行の本線は **GitHub Actions**（`.github/workflows/update-data.yml`・毎朝 8:30 JST）です。
CIが利益チェッカーの価格データをリポジトリから取得（Secret `PROFIT_REPO_TOKEN` が必要）し、
データ更新 → commit & push → Cloudflare Pages がデプロイまで自動で流れます。
手動実行は GitHub の Actions タブ > update-data > **Run workflow**（スマホからも可）。

ローカルの launchd（**10:30**）は**フォールバック**です。`update-all.mjs` が git pull 後に
「今日のデータが既にあるか」を確認し、CIが成功していれば何もしません（`FORCE=1` で強制実行）。
CIが失敗した日だけローカルで取得して push します。

### 手動更新

- **ローカルの画面から**: `npm run dev` 中は「最終更新」の横に**「今すぐ更新」ボタン**が
  表示されます（Vite開発サーバーの `/api/update` エンドポイント経由で `update-all.mjs` を
  起動。実行中は進捗をポーリング表示し、完了すると画面のデータを自動再読込）。
  本番サイトにはエンドポイントが無いためボタンは表示されません
- **ターミナルから**: `npm run update`（push込み）/ `npm run update:data`（取得のみ）

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

- **スパイク検知**: 実売ベースの上昇率 × 出来高 × 他ソース同調の複合スコアで上位20枚を
  根拠つきで表示（`src/lib/spike.ts`）。しきい値一覧と違い、次のノイズを除外します:
  - 実売0のバケット（在庫切れ中の引き継ぎ価格・発売前プレースホルダー）は使わない。
    基準値は「直近を除く過去30日の実売中央値」
  - 発売90日未満の新セットは「発売による価格形成」なので対象外
  - $10未満・変化額$5未満・上昇率+10%未満は候補にしない
  - スコア = 上昇率(%) + min(出来高比, 8)×5 + 他ソース同調×15。
    出来高比 = 直近7日販売枚数 ÷ 過去90日週平均、同調 = 晴れる屋/CK/CMが+8%以上
    （履歴5日分未満の初期は判定なし）
  - チップに根拠（対30日中央値・販売枚数と平常比・同調ソース）を表示。
    クリックで該当行の履歴チャートへ
- 追跡カードの一覧テーブル: 実質利益（+CK買取価格・注意事項⚠）と5列の価格
  （晴れる屋買取 / 晴れる屋販売 / Card Kingdom / TCGplayer市場 / Cardmarket）
- 各価格には前日比（TCGplayer列は7日変動）と在庫数を表示
- 行クリックで価格履歴チャートを展開。TCGplayer のマーケットプライス履歴（最大1年）と
  他ソースの日次記録を同じ時間軸に円換算で重ね描き
- 並び替え: 実質利益順 / TCG市場の7日・30日変動順 / 販売ソース間の差額順 など
- 「円換算で表示」で全ソースをJPY表示（為替は open.er-api.com から取得）
