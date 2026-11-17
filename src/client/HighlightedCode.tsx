/**
 * Read-only syntax highlighting for the merge-conflicts viewer.
 *
 * The sidebar's editor highlights through a CodeMirror `EditorView`; this
 * viewer is read-only, so it reuses only the parse-and-style half: build an
 * `EditorState` from the file's language, read its syntax tree, then walk the
 * tree with a `@lezer/highlight` tag highlighter to produce `tok-*` spans.
 * The tag → class table and the token colors in `merge-conflicts.module.css`
 * are laundered from `dsh-better-sidebar`'s `cm-themes.ts` /
 * `one-dark-palette.ts`.
 */
import { Fragment, useMemo, type ReactNode } from 'react'
import { EditorState } from '@codemirror/state'
import { ensureSyntaxTree } from '@codemirror/language'
import { highlightTree, tagHighlighter, tags, type Tag } from '@lezer/highlight'
import { languageForPath } from './lang.ts'

/** Above this many characters, plain text is cheaper than a freeze. */
const MAX_HIGHLIGHT_LENGTH = 250_000

interface Segment {
  text: string
  className: string | null
}

interface HighlightLine {
  index: number
  text: string
  segments: Segment[]
}

const TOKEN_STYLES: ReadonlyArray<{ tag: Tag | readonly Tag[]; class: string }> = [
  { tag: tags.comment, class: 'tok-comment' },
  { tag: tags.keyword, class: 'tok-keyword' },
  { tag: tags.string, class: 'tok-string' },
  { tag: [tags.regexp, tags.escape, tags.special(tags.string)], class: 'tok-string2' },
  { tag: tags.number, class: 'tok-number' },
  { tag: tags.bool, class: 'tok-bool' },
  { tag: tags.atom, class: 'tok-atom' },
  { tag: [tags.typeName, tags.className], class: 'tok-typeName' },
  { tag: tags.propertyName, class: 'tok-propertyName' },
  { tag: tags.function(tags.variableName), class: 'tok-function' },
  { tag: tags.variableName, class: 'tok-variableName' },
  { tag: tags.operator, class: 'tok-operator' },
  { tag: tags.tagName, class: 'tok-tagName' },
  { tag: tags.attributeName, class: 'tok-attributeName' },
  { tag: tags.heading, class: 'tok-heading' },
  { tag: tags.emphasis, class: 'tok-emphasis' },
  { tag: tags.strong, class: 'tok-strong' },
  { tag: tags.link, class: 'tok-link' },
  { tag: tags.meta, class: 'tok-meta' },
  { tag: tags.invalid, class: 'tok-invalid' },
]

const highlighter = tagHighlighter(TOKEN_STYLES)

function highlightSegments(path: string, text: string): Segment[] {
  if (text.length === 0 || text.length > MAX_HIGHLIGHT_LENGTH) {
    return [{ text, className: null }]
  }
  const support = languageForPath(path)
  if (support === null) return [{ text, className: null }]
  try {
    // Passing the `LanguageSupport`/`Language` directly works because both
    // expose an `extension` property (the same shape the editor state accepts).
    const state = EditorState.create({ doc: text, extensions: [support] })
    const tree = ensureSyntaxTree(state, text.length, 250)
    if (tree === null) return [{ text, className: null }]
    const segments: Segment[] = []
    let pos = 0
    highlightTree(tree, highlighter, (from, to, classes) => {
      if (from > pos) segments.push({ text: text.slice(pos, from), className: null })
      if (to > from) segments.push({ text: text.slice(from, to), className: classes })
      pos = to
    })
    if (pos < text.length) segments.push({ text: text.slice(pos), className: null })
    return segments
  } catch (error) {
    console.warn('[dsh-merge-conflicts] syntax highlighting failed, falling back to plain text:', error)
    return [{ text, className: null }]
  }
}

function buildLines(path: string, text: string): HighlightLine[] {
  if (text.length === 0) return []
  const lines: HighlightLine[] = []
  let current: Segment[] = []
  const flush = (): void => {
    lines.push({ index: lines.length, text: current.map(segment => segment.text).join(''), segments: current })
    current = []
  }
  for (const segment of highlightSegments(path, text)) {
    let rest = segment.text
    for (;;) {
      const breakAt = rest.indexOf('\n')
      if (breakAt === -1) {
        if (rest.length > 0) current.push({ text: rest, className: segment.className })
        break
      }
      if (breakAt > 0) current.push({ text: rest.slice(0, breakAt), className: segment.className })
      flush()
      rest = rest.slice(breakAt + 1)
    }
  }
  flush()
  return lines
}

function renderLineTokens(line: HighlightLine): ReactNode {
  if (line.segments.length === 0) return null
  return line.segments.map((segment, index) =>
    segment.className === null
      ? <Fragment key={index}>{segment.text}</Fragment>
      : <span key={index} className={segment.className}>{segment.text}</span>,
  )
}

interface Props {
  path: string
  text: string
  /** Optional whole-line style. When it returns a class for a line, that
   *  line is rendered as plain text under the class (used by the raw
   *  conflict-marker view so the marker tint is not broken by token colors). */
  lineClass?: (line: HighlightLine) => string | undefined
}

export function HighlightedCode({ path, text, lineClass }: Props) {
  const lines = useMemo(() => buildLines(path, text), [path, text])

  return (
    <>
      {lines.map((line, index) => {
        const wholeLineClass = lineClass?.(line)
        const content = wholeLineClass !== undefined && wholeLineClass !== ''
          ? <span className={wholeLineClass}>{line.text}</span>
          : renderLineTokens(line)
        return (
          <Fragment key={line.index}>
            {content}
            {index < lines.length - 1 ? '\n' : ''}
          </Fragment>
        )
      })}
    </>
  )
}
