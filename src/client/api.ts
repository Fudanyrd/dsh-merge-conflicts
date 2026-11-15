/**
 * Client fetch helpers for the plugin's own host routes. Mirrors the
 * better-sidebar /sidebar API envelope: `{ ok: true, value }` on success,
 * `{ ok: false, error: { code, message } }` on failure.
 */
import type { Context } from '@deepseek-ai/cordis';

export interface SessionScope {
  sessionId: string
  cwd?: string
}

export interface ConflictEntry {
  path: string
  rel: string
  xy: string
  label: string
}

export interface ConflictList {
  root: string
  operation: 'merge' | 'rebase' | undefined
  conflicts: ConflictEntry[]
}

export interface ConflictDetail {
  path: string
  rel: string
  xy: string
  label: string
  operation: 'merge' | 'rebase' | undefined
  content: string | null
  current: string | null
  incoming: string | null
  hasMarkers: boolean
}

export type ResolveMode = 'current' | 'incoming' | 'both'

interface Envelope<T> {
  ok: boolean
  value?: T
  error?: { code: string; message: string }
}

/** Resolve a plugin host route, preserving the reverse-proxy path prefix.
 *  Falls back to document.baseURI on better-sidebar < 0.25.0. */
function routeOf(ctx: Context, path: string): string {
  if (typeof ctx.betterSidebar.hostRouteUrl === 'function') {return ctx.betterSidebar.hostRouteUrl(path);}
  const base = typeof document !== 'undefined' ? document.baseURI : '/';
  return new URL(path.replace(/^\//, ''), base).toString();
}

async function call<T>(ctx: Context, method: string, scope: SessionScope, extra: Record<string, unknown>): Promise<T> {
  const res = await fetch(routeOf(ctx, `merge-conflicts/api/${method}`), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: scope.sessionId, ...(scope.cwd ? { cwd: scope.cwd } : {}), ...extra }),
  });
  const envelope = (await res.json()) as Envelope<T>;
  if (!envelope.ok || envelope.value === undefined) {
    throw new Error(envelope.error?.message ?? `merge-conflicts ${method} failed`);
  }
  return envelope.value;
}

export const listConflicts = (ctx: Context, scope: SessionScope): Promise<ConflictList> =>
  call<ConflictList>(ctx, 'list', scope, {});

export const readConflict = (ctx: Context, scope: SessionScope, path: string): Promise<ConflictDetail> =>
  call<ConflictDetail>(ctx, 'read', scope, { path });

export const resolveConflict = (ctx: Context, scope: SessionScope, path: string, mode: ResolveMode): Promise<{ path: string }> =>
  call<{ path: string }>(ctx, 'resolve', scope, { path, mode });
