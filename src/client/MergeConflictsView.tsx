import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import {
  listConflicts,
  readConflict,
  resolveConflict,
  type ConflictDetail,
  type ConflictEntry,
  type ConflictList,
  type ResolveMode,
  type SessionScope,
} from './api'
import css from './merge-conflicts.module.css'
import { HighlightedCode } from './HighlightedCode'

interface Props {
  ctx: Context
  scope: SessionScope
  visible: boolean
}

const POLL_MS = 3000

export function MergeConflictsView({ ctx, scope, visible }: Props) {
  const [list, setList] = useState<ConflictList | null>(null)
  const [detail, setDetail] = useState<ConflictDetail | null>(null)
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<ResolveMode | null>(null)
  const [showRaw, setShowRaw] = useState(false)
  const mounted = useRef(true)

  // Stabilize the scope identity so the polling effect below does not churn.
  const stableScope = useMemo<SessionScope>(
    () => ({ sessionId: scope.sessionId, cwd: scope.cwd }),
    [scope.sessionId, scope.cwd],
  )

  const refresh = useCallback(async () => {
    try {
      setError(null)
      const next = await listConflicts(ctx, stableScope)
      if (!mounted.current) return
      setList(next)
    } catch (err) {
      if (mounted.current) setError(err instanceof Error ? err.message : String(err))
    }
  }, [ctx, stableScope])

  const open = useCallback(async (path: string) => {
    setSelectedPath(path)
    setLoading(true)
    setError(null)
    try {
      const next = await readConflict(ctx, stableScope, path)
      if (!mounted.current) return
      setDetail(next)
    } catch (err) {
      if (mounted.current) setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (mounted.current) setLoading(false)
    }
  }, [ctx, stableScope])

  const resolve = useCallback(async (mode: ResolveMode) => {
    if (selectedPath === null) return
    setBusy(mode)
    setError(null)
    try {
      await resolveConflict(ctx, stableScope, selectedPath, mode)
      if (!mounted.current) return
      setDetail(null)
      setSelectedPath(null)
      await refresh()
    } catch (err) {
      if (mounted.current) setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (mounted.current) setBusy(null)
    }
  }, [ctx, stableScope, selectedPath, refresh])

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  useEffect(() => {
    if (!visible) return
    void refresh()
    const timer = setInterval(() => { void refresh() }, POLL_MS)
    return () => clearInterval(timer)
  }, [visible, refresh])

  const operationLabel = useMemo(() => {
    if (list?.operation === 'rebase') return 'rebase'
    if (list?.operation === 'merge') return 'merge'
    return undefined
  }, [list?.operation])

  const back = () => { setDetail(null); setSelectedPath(null); setShowRaw(false) }

  return (
    <div className={css.root}>
      <header className={css.header}>
        <span className={css.title}>Merge conflicts</span>
        {operationLabel !== undefined && <span className={css.opBadge}>{operationLabel}</span>}
        <button className={css.iconBtn} type="button" onClick={() => { void refresh() }} title="Refresh">
          ↻
        </button>
      </header>

      {error !== null && <div className={css.error}>{error}</div>}

      {selectedPath !== null
        ? (
            <DetailView
              detail={detail}
              loading={loading}
              busy={busy}
              showRaw={showRaw}
              onToggleRaw={() => setShowRaw(v => !v)}
              onBack={back}
              onResolve={(mode) => { void resolve(mode) }}
            />
          )
        : (
            <ListView
              list={list}
              onOpen={(path) => { void open(path) }}
            />
          )}
    </div>
  )
}

function ListView({ list, onOpen }: { list: ConflictList | null; onOpen: (path: string) => void }) {
  if (list === null) return <div className={css.hint}>Loading…</div>
  if (!list.conflicts.length) {
    return (
      <div className={css.empty}>
        <div className={css.emptyTitle}>No merge conflicts</div>
        <div className={css.emptyHint}>Conflicted files will appear here while a merge, rebase or cherry-pick is in progress.</div>
      </div>
    )
  }
  return (
    <ul className={css.list}>
      {list.conflicts.map((entry) => (
        <ConflictRow key={entry.path} entry={entry} onOpen={() => onOpen(entry.path)} />
      ))}
    </ul>
  )
}

function ConflictRow({ entry, onOpen }: { entry: ConflictEntry; onOpen: () => void }) {
  return (
    <li>
      <button type="button" className={css.row} onClick={onOpen}>
        <span className={css.rowCode}>{entry.xy}</span>
        <span className={css.rowPath}>{entry.rel}</span>
        <span className={css.rowLabel}>{entry.label}</span>
      </button>
    </li>
  )
}

function DetailView(props: {
  detail: ConflictDetail | null
  loading: boolean
  busy: ResolveMode | null
  showRaw: boolean
  onToggleRaw: () => void
  onBack: () => void
  onResolve: (mode: ResolveMode) => void
}) {
  const { detail, loading, busy, showRaw, onToggleRaw, onBack, onResolve } = props
  if (loading && detail === null) return <div className={css.hint}>Loading…</div>
  if (detail === null) return <div className={css.hint}>Select a file</div>

  return (
    <div className={css.detail}>
      <div className={css.detailHead}>
        <button type="button" className={css.iconBtn} onClick={onBack} title="Back">←</button>
        <span className={css.detailCode}>{detail.xy}</span>
        <span className={css.detailPath} title={detail.path}>{detail.rel}</span>
        <button
          type="button"
          className={css.toggle}
          onClick={onToggleRaw}
        >
          {showRaw ? 'sides' : 'raw'}
        </button>
      </div>
      <div className={css.detailMeta}>{detail.label}</div>

      <div className={css.actions}>
        <ActionButton mode="current" label="Accept current" busy={busy} onResolve={onResolve} />
        <ActionButton mode="incoming" label="Accept incoming" busy={busy} onResolve={onResolve} />
        <ActionButton mode="both" label="Accept both" busy={busy} onResolve={onResolve} disabled={!detail.hasMarkers} />
      </div>

      {showRaw
        ? <RawConflict path={detail.path} content={detail.content} />
        : (
            <div className={css.sides}>
              <SidePanel path={detail.path} title="Current" text={detail.current} tone="current" />
              <SidePanel path={detail.path} title="Incoming" text={detail.incoming} tone="incoming" />
            </div>
          )}
    </div>
  )
}

function ActionButton(props: { mode: ResolveMode; label: string; busy: ResolveMode | null; disabled?: boolean; onResolve: (mode: ResolveMode) => void }) {
  const { mode, label, busy, disabled, onResolve } = props
  return (
    <button
      type="button"
      className={css.actionBtn}
      disabled={busy !== null || disabled === true}
      onClick={() => onResolve(mode)}
    >
      {busy === mode ? '…' : label}
    </button>
  )
}

function SidePanel({ path, title, text, tone }: { path: string; title: string; text: string | null; tone: 'current' | 'incoming' }) {
  return (
    <div className={css.side}>
      <div className={css.sideTitle}>{title}</div>
      <pre className={`${css.code} ${tone === 'current' ? css.codeCurrent : css.codeIncoming}`}>
        {text === null ? '(no content on this side)' : <HighlightedCode path={path} text={text} />}
      </pre>
    </div>
  )
}

function RawConflict({ path, content }: { path: string; content: string | null }) {
  if (content === null) return <div className={css.hint}>The file does not exist in the working tree.</div>
  return (
    <pre className={css.raw}>
      <HighlightedCode
        path={path}
        text={content}
        lineClass={(line) => {
          if (/^<{7}( |$)/.test(line.text) || /^\|{7}( |$)/.test(line.text)) return css.markerCurrent
          if (/^={7}\s*$/.test(line.text)) return css.markerSep
          if (/^>{7}( |$)/.test(line.text)) return css.markerIncoming
          return undefined
        }}
      />
    </pre>
  )
}
