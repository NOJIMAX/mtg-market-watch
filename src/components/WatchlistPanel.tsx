import { useCallback, useEffect, useState } from 'react';

interface WatchlistEntry {
  sid: string;
  finish: string;
  name: string;
  set: string;
  cn: string;
  addedAt?: string;
}

interface ScryfallPrint {
  id: string;
  name: string;
  set: string;
  set_name: string;
  collector_number: string;
  finishes: string[];
  released_at: string;
  image_uris?: { small?: string };
  card_faces?: { image_uris?: { small?: string } }[];
  prices?: { usd?: string | null; usd_foil?: string | null };
}

const FINISH_LABEL: Record<string, string> = { nonfoil: '通常', foil: 'Foil', etched: 'エッチング' };

/**
 * 手動監視リストの管理パネル。ローカル開発サーバーの /api/watchlist が
 * 応答する場合のみ表示される（本番の静的サイトでは非表示）。
 * Scryfall のカード名検索で版を選び、仕上げを指定して追加する。
 * 追加・削除は即座に data/manual-watchlist.json へ保存され、
 * 次回のデータ更新（今すぐ更新 or 翌朝の自動実行）から追跡が始まる。
 */
export function WatchlistPanel({ trackedIds }: { trackedIds: Set<string> }) {
  const [available, setAvailable] = useState(false);
  const [entries, setEntries] = useState<WatchlistEntry[]>([]);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ScryfallPrint[]>([]);
  const [searching, setSearching] = useState(false);
  const [message, setMessage] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/watchlist');
      if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) return;
      const list = (await res.json()) as { cards: WatchlistEntry[] };
      setAvailable(true);
      setEntries(list.cards);
    } catch {
      // 本番（静的サイト）ではエンドポイントが無い
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (!available) return null;

  const search = async () => {
    const q = query.trim();
    if (q.length < 2) return;
    setSearching(true);
    setMessage('');
    setResults([]);
    try {
      const res = await fetch(
        `https://api.scryfall.com/cards/search?q=${encodeURIComponent(q)}&unique=prints&order=released`,
      );
      if (!res.ok) {
        setMessage(res.status === 404 ? '該当するカードがありません' : `検索エラー (HTTP ${res.status})`);
        return;
      }
      const json = (await res.json()) as { data: ScryfallPrint[]; total_cards: number };
      setResults(json.data.slice(0, 40));
      setMessage(
        json.total_cards > 40 ? `${json.total_cards}件中40件を表示（名前やセットで絞ってください）` : '',
      );
    } catch {
      setMessage('Scryfall検索に失敗しました');
    } finally {
      setSearching(false);
    }
  };

  const add = async (print: ScryfallPrint, finish: string) => {
    const res = await fetch('/api/watchlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sid: print.id,
        finish,
        name: print.name,
        set: print.set,
        cn: print.collector_number,
      }),
    });
    if (res.ok) {
      const list = (await res.json()) as { cards: WatchlistEntry[] };
      setEntries(list.cards);
    }
  };

  const remove = async (entry: WatchlistEntry) => {
    const res = await fetch('/api/watchlist/remove', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: `${entry.sid}:${entry.finish}`, name: entry.name }),
    });
    if (res.ok) {
      const list = (await res.json()) as { cards: WatchlistEntry[] };
      setEntries(list.cards);
    }
  };

  return (
    <details className="panel panel--collapsible">
      <summary className="panel__summary">
        手動監視リスト（{entries.length}枚）
        <span className="panel__summary-hint">
          Scryfall検索でカードを追加。次回更新から追跡されます
        </span>
      </summary>
      <div className="panel__body">
        {entries.length > 0 && (
          <ul className="watchlist-entries">
            {entries.map((e) => {
              const tracked = trackedIds.has(`${e.sid}:${e.finish}`);
              return (
                <li key={`${e.sid}:${e.finish}`}>
                  <span>
                    {e.name} <span className="watchlist-sub">
                      {e.set.toUpperCase()} #{e.cn} {FINISH_LABEL[e.finish] ?? e.finish}
                    </span>
                    {!tracked && <span className="watchlist-pending">次回更新で追跡開始</span>}
                  </span>
                  <button type="button" onClick={() => remove(e)}>
                    削除
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <div className="watchlist-search">
          <input
            type="search"
            value={query}
            placeholder="カード名で検索（例: Gaea's Cradle / e:usg で絞り込みも可）"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') search();
            }}
          />
          <button type="button" onClick={search} disabled={searching}>
            {searching ? '検索中…' : 'Scryfallで検索'}
          </button>
          {message && <span className="watchlist-sub">{message}</span>}
        </div>
        {results.length > 0 && (
          <ul className="watchlist-results">
            {results.map((p) => {
              const img = p.image_uris?.small ?? p.card_faces?.[0]?.image_uris?.small;
              return (
                <li key={p.id}>
                  {img && <img src={img} alt="" loading="lazy" />}
                  <span className="watchlist-result__body">
                    <span>{p.name}</span>
                    <span className="watchlist-sub">
                      {p.set.toUpperCase()} #{p.collector_number} / {p.set_name} ({p.released_at?.slice(0, 4)})
                      {p.prices?.usd && ` / $${p.prices.usd}`}
                      {p.prices?.usd_foil && ` / Foil $${p.prices.usd_foil}`}
                    </span>
                  </span>
                  <span className="watchlist-result__actions">
                    {p.finishes.map((f) => {
                      const already = entries.some((e) => e.sid === p.id && e.finish === f);
                      return (
                        <button key={f} type="button" disabled={already} onClick={() => add(p, f)}>
                          {already ? `${FINISH_LABEL[f] ?? f}✓` : `${FINISH_LABEL[f] ?? f}を追加`}
                        </button>
                      );
                    })}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </details>
  );
}
