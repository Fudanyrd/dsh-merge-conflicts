/**
 * Git conflict detection and resolution for the dsh-merge-conflicts host half.
 *
 * Everything goes through the system `git` binary spawned per request (no
 * library, no persistent state) and reads/writes the working tree directly.
 * Resolution uses `git checkout --ours/--theirs` + `git add` for the
 * "pick one side" cases, falls back to `git rm -f` when that side deleted the
 * file (delete/modify conflicts), and a conflict-marker union for "keep both".
 *
 * Marker-side semantics:
 *   - merge / cherry-pick / revert: `<<<<<<<` side = current (stage 2),
 *     `>>>>>>>` side = incoming (stage 3).
 *   - rebase: `<<<<<<<` side = incoming (the upstream being rebased onto),
 *     `>>>>>>>` side = current (the commit being replayed) — the classic
 *     `git checkout --ours/--theirs` swap.
 */
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import { spawn } from 'node:child_process'

export interface ConflictEntry {
  /** Absolute path to the conflicted file. */
  path: string
  /** Path relative to the repository root (git's forward-slash form). */
  rel: string
  /** Porcelain v2 unmerged code (UU / AA / AU / UA / DD / DU / UD). */
  xy: string
  /** Human-readable reason. */
  label: string
}

export type ResolveMode = 'current' | 'incoming' | 'both'

export interface ConflictDetail {
  path: string
  rel: string
  xy: string
  label: string
  operation: 'merge' | 'rebase' | undefined
  /** Working-tree content (with conflict markers), or null if the file is absent. */
  content: string | null
  /** "current" side full text, or null when that stage has no blob. */
  current: string | null
  /** "incoming" side full text, or null when that stage has no blob. */
  incoming: string | null
  /** Whether content has conflict markers (enables "both"). */
  hasMarkers: boolean
}

export class ConflictError extends Error {
  readonly code: string
  readonly status: number
  constructor(code: string, message: string, status = 400) {
    super(message)
    this.code = code
    this.status = status
  }
}

const UNMERGED_LABELS: Record<string, string> = {
  UU: 'both modified',
  AA: 'both added',
  AU: 'added by us, deleted by them',
  UA: 'deleted by us, added by them',
  DD: 'both deleted',
  DU: 'deleted by us, modified by them',
  UD: 'modified by us, deleted by them',
}

/** Normalize a native path to git's forward-slash form. */
function toGitPath(value: string): string {
  return value.split('\\').join('/')
}

/** Spawn `git` and resolve stdout, rejecting with git's stderr on failure. */
export function runGit(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-c', 'color.ui=false', '-c', 'core.quotePath=false', '-C', cwd, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let out = ''
    let err = ''
    child.stdout?.on('data', (chunk) => { out += Buffer.from(chunk).toString('utf8') })
    child.stderr?.on('data', (chunk) => { err += Buffer.from(chunk).toString('utf8') })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve(out)
      else reject(new ConflictError('git-error', err.trim() || `git ${args[0]} failed (exit ${code})`))
    })
  })
}

/** Resolve a repository root for `cwd` (a bare cwd that is not a repo → git-error). */
export async function repoRootOf(cwd: string): Promise<string> {
  const out = await runGit(cwd, ['rev-parse', '--show-toplevel'])
  const root = out.trim()
  if (root === '') throw new ConflictError('not-repo', `not a git repository: ${cwd}`, 409)
  return root
}

/** Whether the repository is mid-merge or mid-rebase. */
export async function operationOf(root: string): Promise<'merge' | 'rebase' | undefined> {
  let gitDir: string
  try {
    gitDir = (await runGit(root, ['rev-parse', '--absolute-git-dir'])).trim()
  } catch {
    return undefined
  }
  let names: string[] = []
  try {
    names = await readdir(gitDir)
  } catch {
    return undefined
  }
  if (names.includes('rebase-merge') || names.includes('rebase-apply')) return 'rebase'
  if (names.includes('MERGE_HEAD')) return 'merge'
  return undefined
}

/**
 * List conflicted (unmerged) paths from `git status --porcelain=v2 -z`.
 * Only `u` records are conflicts; the path is the field after the 10th space
 * (u xy sub m1 m2 m3 mW h1 h2 h3 <path>).
 */
export async function listConflicts(cwd: string): Promise<{ root: string; operation: ConflictDetail['operation']; conflicts: ConflictEntry[] }> {
  const root = await repoRootOf(cwd)
  const [status, operation] = await Promise.all([
    runGit(root, ['status', '--porcelain=v2', '-z', '--untracked-files=no']),
    operationOf(root),
  ])
  const conflicts: ConflictEntry[] = []
  for (const record of status.split('\0')) {
    if (record === '' || record[0] !== 'u') continue
    let spaces = 0
    let pathStart = -1
    for (let i = 0; i < record.length; i++) {
      if (record[i] === ' ') {
        spaces++
        if (spaces === 10) { pathStart = i + 1; break }
      }
    }
    if (pathStart === -1) continue
    const rel = toGitPath(record.slice(pathStart))
    if (rel === '') continue
    const xy = record.slice(2, 4)
    conflicts.push({
      path: resolve(root, rel),
      rel,
      xy,
      label: UNMERGED_LABELS[xy] ?? 'conflict',
    })
  }
  return { root, operation, conflicts }
}

/** Read one side's blob from the index (`git show :<stage>:<path>`), null when missing. */
export async function sideOf(root: string, stage: 2 | 3, rel: string): Promise<string | null> {
  try {
    return await runGit(root, ['show', `:${stage}:${rel}`])
  } catch {
    return null
  }
}

/** Read the full detail of one conflicted file. */
export async function readConflict(cwd: string, absPath: string): Promise<ConflictDetail> {
  const root = await repoRootOf(cwd)
  const rel = toGitPath(relative(root, absPath))
  const operation = await operationOf(root)
  const currentStage: 2 | 3 = operation === 'rebase' ? 3 : 2
  const incomingStage: 2 | 3 = operation === 'rebase' ? 2 : 3

  const content = await readFile(absPath, 'utf8').catch(() => null)
  const [current, incoming, status] = await Promise.all([
    sideOf(root, currentStage, rel),
    sideOf(root, incomingStage, rel),
    runGit(root, ['status', '--porcelain=v2', '-z', '--untracked-files=no']),
  ])

  let xy = 'UU'
  for (const record of status.split('\0')) {
    if (record === '' || record[0] !== 'u') continue
    let spaces = 0
    let pathStart = -1
    for (let i = 0; i < record.length; i++) {
      if (record[i] === ' ') {
        spaces++
        if (spaces === 10) { pathStart = i + 1; break }
      }
    }
    if (pathStart !== -1 && record.slice(pathStart) === rel) {
      xy = record.slice(2, 4)
      break
    }
  }

  return {
    path: absPath,
    rel,
    xy,
    label: UNMERGED_LABELS[xy] ?? 'conflict',
    operation,
    content,
    current,
    incoming,
    hasMarkers: content !== null && /^<{7}( |$)/m.test(content),
  }
}

/** Whether a line is a `<<<<<<<` marker. */
function isConflictStart(line: string): boolean {
  return /^<{7}( |$)/.test(line)
}

/** Whether a line is the `=======` separator. */
function isConflictSeparator(line: string): boolean {
  return /^={7}\s*$/.test(line)
}

/** Whether a line is a `>>>>>>>` marker. */
function isConflictEnd(line: string): boolean {
  return /^>{7}( |$)/.test(line)
}

/** Whether a line is a diff3 base marker `|||||||`. */
function isDiff3Base(line: string): boolean {
  return /^\|{7}( |$)/.test(line)
}

/**
 * Resolve a file's conflict markers by keeping BOTH sides (current block then
 * incoming block, the diff3 base block is dropped). Returns null when the text
 * has no conflict markers (delete/modify conflicts, or a file with only one
 * side's content).
 */
export function resolveBothMarkers(text: string): string | null {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(/\r?\n/)
  const out: string[] = []
  let found = false
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    if (isConflictStart(line)) {
      let base = -1
      let sep = -1
      for (let j = i + 1; j < lines.length; j++) {
        if (isConflictEnd(lines[j]!)) break
        if (base === -1 && isDiff3Base(lines[j]!)) { base = j; continue }
        if (isConflictSeparator(lines[j]!)) { sep = j; break }
      }
      if (sep === -1) { out.push(line); i++; continue }
      let end = -1
      for (let j = sep + 1; j < lines.length; j++) {
        if (isConflictEnd(lines[j]!)) { end = j; break }
      }
      if (end === -1) { out.push(line); i++; continue }
      const oursEnd = base === -1 ? sep : base
      out.push(...lines.slice(i + 1, oursEnd))
      out.push(...lines.slice(sep + 1, end))
      found = true
      i = end + 1
    } else {
      out.push(line)
      i++
    }
  }
  if (!found) return null
  return out.join(eol)
}

/** Whether an index stage blob exists for a path (`git cat-file -e :<stage>:<path>`). */
async function stageExists(root: string, stage: 2 | 3, rel: string): Promise<boolean> {
  try {
    await runGit(root, ['cat-file', '-e', `:${stage}:${rel}`])
    return true
  } catch {
    return false
  }
}

/**
 * Resolve a conflict by taking ONE index side (stage 2 = ours, stage 3 =
 * theirs). When the side's blob exists, restore it and stage it; when it does
 * not exist (that side deleted the file), take the deletion and stage it.
 *
 * `git checkout --ours/--theirs` alone does NOT stage the result (verified:
 * the path stays `UU`), so each branch ends with an explicit stage.
 */
async function resolveSide(root: string, rel: string, stage: 2 | 3): Promise<void> {
  if (await stageExists(root, stage, rel)) {
    await runGit(root, ['checkout', stage === 2 ? '--ours' : '--theirs', '--', rel])
    await runGit(root, ['add', '--', rel])
    return
  }
  // That side deleted the file: `git rm -f` removes the working-tree copy and
  // stages the deletion, resolving the unmerged entry.
  await runGit(root, ['rm', '-f', '--', rel])
}

/** Resolve one conflict. Returns the resolved absolute path. */
export async function resolveConflict(cwd: string, absPath: string, mode: ResolveMode): Promise<{ path: string }> {
  const root = await repoRootOf(cwd)
  const rel = toGitPath(relative(root, absPath))
  const operation = await operationOf(root)

  if (mode === 'both') {
    const raw = await readFile(absPath, 'utf8').catch(() => null)
    if (raw === null) {
      throw new ConflictError('no-markers', 'the file is absent (delete/modify conflict); use "current" or "incoming"')
    }
    const resolved = resolveBothMarkers(raw)
    if (resolved === null) {
      throw new ConflictError('no-markers', 'no conflict markers found; use "current" or "incoming" for this conflict')
    }
    await writeFile(absPath, resolved, 'utf8')
    await runGit(root, ['add', '--', rel])
    return { path: absPath }
  }

  // During a rebase the meaning of ours/theirs is swapped, so "current" must
  // follow the swap: stage 2 is the upstream, stage 3 is the commit being
  // replayed.
  const currentStage: 2 | 3 = operation === 'rebase' ? 3 : 2
  const incomingStage: 2 | 3 = operation === 'rebase' ? 2 : 3
  await resolveSide(root, rel, mode === 'current' ? currentStage : incomingStage)
  return { path: absPath }
}

/** Resolve a session's authoritative working directory with a client hint. */
export function sessionCwdOf(sessions: SessionsFace | undefined, sessionId: string, clientCwd?: string): string {
  const session = sessions?.get(sessionId)
  const stored = session?.header.cwd
  const cwd = clientCwd && clientCwd !== '' ? clientCwd : stored
  if (cwd === undefined || cwd === '') {
    throw new ConflictError('bad-request', `no working directory for session "${sessionId}"`, 400)
  }
  return cwd
}

/** Minimal structural face of the DSH host session store. */
export interface SessionsFace {
  get(id: string): { header: { cwd?: string } } | undefined
}
