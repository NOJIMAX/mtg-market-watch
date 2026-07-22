import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createWriteStream, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import type { IncomingMessage } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

const root = dirname(fileURLToPath(import.meta.url))

/**
 * 手動監視リストのエンドポイント（ローカル開発サーバー専用）
 *   GET  /api/watchlist         現在のリスト
 *   POST /api/watchlist         追加 { sid, finish, name, set, cn }
 *   POST /api/watchlist/remove  削除 { id }  (id = "sid:finish")
 * 変更のたびに data/manual-watchlist.json へ書き込み、ベストエフォートで
 * git commit & push する（CIが翌朝のリストを読むため。オフライン時は
 * 次回の update-all.mjs のコミットに相乗りする）。
 */
function watchlistEndpoint(): Plugin {
  const path = join(root, 'data', 'manual-watchlist.json')
  const read = () => {
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as { cards: Record<string, string>[] }
    } catch {
      return { cards: [] }
    }
  }
  const readBody = (req: IncomingMessage) =>
    new Promise<Record<string, string>>((resolve, reject) => {
      let body = ''
      req.on('data', (c) => {
        body += c
      })
      req.on('end', () => {
        try {
          resolve(JSON.parse(body))
        } catch (e) {
          reject(e)
        }
      })
    })
  const save = (list: { cards: Record<string, string>[] }, message: string) => {
    writeFileSync(path, `${JSON.stringify(list, null, 2)}\n`)
    // ベストエフォートの commit & push（失敗しても翌日の update-all が拾う）
    const git = (...args: string[]) => spawnSync('git', args, { cwd: root })
    git('add', 'data/manual-watchlist.json')
    if (git('diff', '--cached', '--quiet').status !== 0) {
      git('commit', '-m', message)
      git('pull', '--rebase', 'origin', 'main')
      git('push', 'origin', 'main')
    }
  }
  return {
    name: 'watchlist-endpoint',
    configureServer(server) {
      server.middlewares.use('/api/watchlist', (req, res) => {
        res.setHeader('Content-Type', 'application/json')
        void (async () => {
          if (req.method === 'GET') {
            res.end(JSON.stringify(read()))
            return
          }
          if (req.method !== 'POST') {
            res.statusCode = 405
            res.end(JSON.stringify({ error: 'method not allowed' }))
            return
          }
          const body = await readBody(req)
          const list = read()
          if (req.url?.startsWith('/remove')) {
            const before = list.cards.length
            list.cards = list.cards.filter((c) => `${c.sid}:${c.finish}` !== body.id)
            if (list.cards.length !== before) {
              save(list, `watchlist: ${body.name ?? body.id} を削除`)
            }
            res.end(JSON.stringify(list))
            return
          }
          if (!body.sid || !body.finish) {
            res.statusCode = 400
            res.end(JSON.stringify({ error: 'sid と finish は必須です' }))
            return
          }
          if (!list.cards.some((c) => c.sid === body.sid && c.finish === body.finish)) {
            list.cards.push({
              sid: body.sid,
              finish: body.finish,
              name: body.name ?? '',
              set: body.set ?? '',
              cn: body.cn ?? '',
              addedAt: new Date().toISOString().slice(0, 10),
            })
            save(
              list,
              `watchlist: ${body.name ?? body.sid} [${body.set ?? ''}#${body.cn ?? ''} ${body.finish}] を追加`,
            )
          }
          res.end(JSON.stringify(list))
        })().catch((err: unknown) => {
          res.statusCode = 500
          res.end(JSON.stringify({ error: String(err) }))
        })
      })
    },
  }
}

/**
 * 手動更新エンドポイント（ローカル開発サーバー専用）
 *   GET  /api/update  実行状態 { running, startedAt, finishedAt, exitCode, tail }
 *   POST /api/update  scripts/update-all.mjs を起動（実行中は 409）
 * 本番（Cloudflare Pages の静的配信）には存在しないため、UI側は
 * このエンドポイントの有無で手動更新ボタンの表示を切り替える。
 */
function manualUpdateEndpoint(): Plugin {
  let child: ChildProcess | null = null
  let startedAt: string | null = null
  let finishedAt: string | null = null
  let exitCode: number | null = null
  const tail: string[] = []
  const pushTail = (chunk: Buffer) => {
    for (const line of chunk.toString().split('\n')) {
      const s = line.trimEnd()
      if (s) tail.push(s)
    }
    while (tail.length > 30) tail.shift()
  }
  return {
    name: 'manual-update-endpoint',
    configureServer(server) {
      server.middlewares.use('/api/update', (req, res) => {
        res.setHeader('Content-Type', 'application/json')
        if (req.method === 'GET') {
          res.end(
            JSON.stringify({
              running: child != null,
              startedAt,
              finishedAt,
              exitCode,
              tail: tail.slice(-8),
            }),
          )
          return
        }
        if (req.method === 'POST') {
          if (child != null) {
            res.statusCode = 409
            res.end(JSON.stringify({ error: 'already running' }))
            return
          }
          mkdirSync(join(root, 'logs'), { recursive: true })
          // launchd と同じログファイルに追記する（同時実行は上の 409 ガードで防止）
          const log = createWriteStream(join(root, 'logs', 'update.log'), { flags: 'a' })
          tail.length = 0
          startedAt = new Date().toISOString()
          finishedAt = null
          exitCode = null
          child = spawn(process.execPath, [join(root, 'scripts', 'update-all.mjs')], { cwd: root })
          child.stdout?.on('data', (d: Buffer) => {
            log.write(d)
            pushTail(d)
          })
          child.stderr?.on('data', (d: Buffer) => {
            log.write(d)
            pushTail(d)
          })
          child.on('exit', (code) => {
            exitCode = code ?? -1
            finishedAt = new Date().toISOString()
            child = null
            log.end()
          })
          res.statusCode = 202
          res.end(JSON.stringify({ started: true }))
          return
        }
        res.statusCode = 405
        res.end(JSON.stringify({ error: 'method not allowed' }))
      })
    },
  }
}

// mtg-profit-checker (5173) と同時に起動できるようポートをずらす
export default defineConfig({
  plugins: [react(), manualUpdateEndpoint(), watchlistEndpoint()],
  server: { port: 5174 },
})
