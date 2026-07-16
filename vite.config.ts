import { spawn, type ChildProcess } from 'node:child_process'
import { createWriteStream, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

const root = dirname(fileURLToPath(import.meta.url))

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
  plugins: [react(), manualUpdateEndpoint()],
  server: { port: 5174 },
})
