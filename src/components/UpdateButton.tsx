import { useCallback, useEffect, useRef, useState } from 'react';

interface UpdateStatus {
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  tail: string[];
}

/**
 * 手動更新ボタン。ローカル開発サーバーの /api/update エンドポイントが
 * 応答する場合のみ表示される（本番の静的サイトでは何も描画しない）。
 * 実行中は5秒ごとに状態をポーリングし、完了したら onCompleted で
 * 価格データの再読み込みを促す。
 */
export function UpdateButton({ onCompleted }: { onCompleted: () => void }) {
  const [available, setAvailable] = useState(false);
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const wasRunning = useRef(false);

  const poll = useCallback(async () => {
    try {
      const res = await fetch('/api/update');
      if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) return;
      const s = (await res.json()) as UpdateStatus;
      setAvailable(true);
      setStatus(s);
      if (wasRunning.current && !s.running) onCompleted();
      wasRunning.current = s.running;
    } catch {
      // エンドポイントが無い（本番の静的サイト）場合は非表示のまま
    }
  }, [onCompleted]);

  useEffect(() => {
    poll();
  }, [poll]);

  useEffect(() => {
    if (!status?.running) return;
    const timer = setInterval(() => {
      poll();
      setNow(Date.now());
    }, 5000);
    return () => clearInterval(timer);
  }, [status?.running, poll]);

  if (!available) return null;

  const start = async () => {
    if (
      !confirm(
        'データ更新を開始しますか？\n全カードの取得に40〜60分かかり、完了すると自動で commit & push（本番デプロイ）されます。',
      )
    ) {
      return;
    }
    await fetch('/api/update', { method: 'POST' });
    await poll();
  };

  if (status?.running) {
    const min = status.startedAt
      ? Math.max(0, Math.floor((now - Date.parse(status.startedAt)) / 60000))
      : 0;
    const lastLine = status.tail[status.tail.length - 1] ?? '';
    return (
      <div className="update-button">
        <button type="button" disabled>
          更新中… {min}分経過
        </button>
        {lastLine && <span className="update-button__log">{lastLine}</span>}
      </div>
    );
  }

  return (
    <div className="update-button">
      <button type="button" onClick={start}>
        今すぐ更新
      </button>
      {status?.finishedAt && (
        <span
          className={`update-button__log${status.exitCode === 0 ? '' : ' update-button__log--error'}`}
        >
          {status.exitCode === 0
            ? `✓ 更新完了 (${new Date(status.finishedAt).toLocaleTimeString('ja-JP')})`
            : '✗ 更新失敗（logs/update.log を確認してください）'}
        </span>
      )}
    </div>
  );
}
