/**
 * dsh-merge-conflicts host half.
 *
 * Exposes `/merge-conflicts/api` (JSON POST) with three methods:
 *   - `list`    — conflicted (unmerged) files + the active git operation,
 *   - `read`    — one file's conflicted content and both sides,
 *   - `resolve` — accept current / incoming / both, then stage the result.
 *
 * Every request is admitted through the same public Connection service as the
 * `/api` gateway (Host/Origin + browser authentication).
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  ConflictError,
  listConflicts,
  readConflict,
  resolveConflict,
  sessionCwdOf,
  type ResolveMode,
  type SessionsFace,
} from './git-conflicts'

export const name = 'dsh-merge-conflicts'

/** Services required before mounting: the HTTP server, the session store, and request admission. */
export const inject = ['webServer', 'sessions', 'connection']

/** Minimal structural face of the DSH host web server. */
interface WebServerFace {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

/** Minimal structural face of the DSH connection service (request admission). */
interface ConnectionFace {
  requestRejection(req: { headers: Record<string, string | string[] | undefined> }): 401 | 403 | undefined
}

/** The cordis host context face this plugin touches. */
interface HostContext {
  get<T = unknown>(name: string): T
  effect(fn: () => void | (() => void), label?: string): void
  logger?: { warn(...args: unknown[]): void; error(...args: unknown[]): void; info(...args: unknown[]): void }
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) { res.destroy(); return }
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk)
    total += buffer.length
    if (total > 1 << 20) throw new ConflictError('too-large', 'request body too large', 413)
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new ConflictError('bad-request', 'request body is not valid JSON')
  }
}

function requireString(payload: unknown, key: string): string {
  const record = payload as Record<string, unknown> | null
  const value = record?.[key]
  if (typeof value !== 'string' || value === '') throw new ConflictError('bad-request', `missing or invalid "${key}"`)
  return value
}

export function apply(ctx: HostContext): void {
  const webServer = ctx.get<WebServerFace>('webServer')
  const sessions = ctx.get<SessionsFace>('sessions')
  const connection = ctx.get<ConnectionFace>('connection')

  const fence = (req: IncomingMessage): boolean => connection?.requestRejection(req) === undefined

  ctx.effect(() => webServer.register({
    kind: 'prefix',
    path: '/merge-conflicts/api',
    handler: async (req, res) => {
      if (!fence(req)) { writeJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } }); return }
      if (req.method !== 'POST') { writeJson(res, 405, { ok: false, error: { code: 'method-error', message: 'method not allowed' } }); return }
      const method = new URL(req.url ?? '/', 'http://dsh.internal').pathname.slice('/merge-conflicts/api/'.length)
      try {
        const payload = await readBody(req)
        const sessionId = requireString(payload, 'sessionId')
        const clientCwd = typeof (payload as { cwd?: unknown }).cwd === 'string' ? (payload as { cwd: string }).cwd : undefined
        const cwd = sessionCwdOf(sessions, sessionId, clientCwd)

        let value: unknown
        if (method === 'list') {
          value = await listConflicts(cwd)
        } else if (method === 'read') {
          value = await readConflict(cwd, requireString(payload, 'path'))
        } else if (method === 'resolve') {
          const mode = (payload as { mode?: unknown }).mode
          if (mode !== 'current' && mode !== 'incoming' && mode !== 'both') {
            throw new ConflictError('bad-request', 'mode must be "current", "incoming" or "both"')
          }
          value = await resolveConflict(cwd, requireString(payload, 'path'), mode as ResolveMode)
        } else {
          throw new ConflictError('not-found', `unknown method "${method}"`, 404)
        }
        writeJson(res, 200, { ok: true, value })
      } catch (error) {
        if (error instanceof ConflictError) {
          writeJson(res, error.status, { ok: false, error: { code: error.code, message: error.message } })
        } else {
          const message = error instanceof Error ? error.message : String(error)
          ctx.logger?.error('dsh-merge-conflicts:', error)
          writeJson(res, 500, { ok: false, error: { code: 'internal', message } })
        }
      }
    },
  }), 'dsh-merge-conflicts: /merge-conflicts/api routes')
}
