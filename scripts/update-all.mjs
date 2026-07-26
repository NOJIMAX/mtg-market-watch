/**
 * データ更新 + デプロイのエントリポイント（launchd から毎朝呼ばれる）
 *
 * 0. git pull して、今日のデータが既にあれば何もしない
 *    （定期実行の本線は GitHub Actions の update-data ワークフロー（8:30 JST）で、
 *      こちらはCIが落ちた日のフォールバック。FORCE=1 で強制実行）
 * 1. fetch-market-data.mjs を実行して価格データを更新する
 * 2. public/data に変更があれば git commit & push する
 *    （push を Cloudflare Pages の Git 連携が検知して本番デプロイされる）
 *
 * git push の失敗（オフライン等）は警告に留める。ローカルのデータは更新済みなので
 * 次回実行時の push でまとめて反映される。
 */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoDir = join(dirname(fileURLToPath(import.meta.url)), '..');

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { cwd: repoDir, stdio: 'inherit', ...opts });
  return result.status === 0;
}

/** 日本時間の YYYY-MM-DD */
const todayJst = () => new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);

if (process.env.FORCE !== '1') {
  // CI (update-data ワークフロー) が今日の分を取得済みなら何もしない
  if (!run('git', ['pull', '--rebase', 'origin', 'main'])) {
    // 途中で止まったrebaseが残っていると以後の全git操作が壊れるため必ず片付ける
    run('git', ['rebase', '--abort']);
    console.warn('git pull に失敗しました（オフライン?）。ローカルのデータで判定します');
  }
  try {
    const cards = JSON.parse(readFileSync(join(repoDir, 'public', 'data', 'cards.json'), 'utf8'));
    const updatedJstDate = new Date(Date.parse(cards.updatedAt) + 9 * 3600000)
      .toISOString()
      .slice(0, 10);
    if (updatedJstDate === todayJst()) {
      console.log(`今日 (${todayJst()}) のデータは取得済みのためスキップします (FORCE=1 で強制実行)`);
      process.exit(0);
    }
  } catch {
    // cards.json が無い・読めない場合は普通に実行する
  }
}

console.log(`===== fetch-market-data.mjs (${new Date().toLocaleString('ja-JP')}) =====`);
const fetched = run(process.execPath, [join(repoDir, 'scripts', 'fetch-market-data.mjs')]);
if (!fetched) console.error('fetch-market-data.mjs が失敗しました');

console.log('\n===== git push =====');
const hasChanges =
  spawnSync('git', ['status', '--porcelain', 'public/data', 'data'], {
    cwd: repoDir,
  })
    .stdout.toString()
    .trim() !== '';
if (!hasChanges) {
  console.log('価格データに変更がないため push しません');
} else {
  /**
   * pull --rebase がデータファイルで競合した場合の自動復旧。
   * 遅延したCIとローカルの両方が同日データをコミットすると必ず競合するが、
   * 中身は同日の等価なデータなのでリモート（CI取得分）を優先して
   * ローカルのデータコミットを取り下げる。放置すると止まったrebaseが
   * 残って以後のgit操作が全滅する（2026-07-25に発生）ためここで必ず解消する。
   */
  const pullOrPreferRemote = () => {
    if (run('git', ['pull', '--rebase', 'origin', 'main'])) return true;
    console.warn('pull --rebase が競合しました。データはリモート（CI取得分）を優先します');
    run('git', ['rebase', '--abort']);
    // 直前のローカルデータコミットを取り消し、データファイルをリモート版で
    // コミットし直す。rebase 時に差分が空になったコミットは自動で破棄されるため、
    // これで再 pull が競合せずに完了する
    run('git', ['reset', '--mixed', 'HEAD~1']);
    run('git', ['checkout', 'origin/main', '--', 'public/data', 'data']);
    run('git', ['commit', '-m', 'chore: 競合したデータはリモート(CI)版を採用']);
    return run('git', ['pull', '--rebase', 'origin', 'main']);
  };

  const pushed =
    // data/ 配下（resolve-cache・手動監視リスト）も追跡対象のため一緒にコミットする
    // （未ステージのまま残すと pull --rebase が失敗する）
    run('git', ['add', 'public/data', 'data']) &&
    run('git', ['commit', '-m', `chore: 価格データ更新 (${new Date().toISOString().slice(0, 10)})`]) &&
    pullOrPreferRemote() &&
    run('git', ['push', 'origin', 'main']);
  if (pushed) {
    console.log('push 完了。GitHub Actions がデプロイします');
  } else {
    // 失敗してもエラー終了にしない（ローカル更新は完了しており、翌日の push で回復する）
    console.error('git push に失敗しました。次回実行時に再試行されます');
  }
}

process.exit(fetched ? 0 : 1);
