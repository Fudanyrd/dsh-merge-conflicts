import { createElement } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { TabComponentProps } from 'dsh-better-sidebar'
import { MergeConflictsView } from './MergeConflictsView'

/** `import type {}` triggers the `ctx.betterSidebar` augmentation. */
import type {} from 'dsh-better-sidebar'

export const inject = ['betterSidebar']

function MergeIcon(_size: number) {
  // Git "merge" glyph: two branches joining into one.
  return createElement('svg', {
    width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none',
    'aria-hidden': true,
  },
    createElement('circle', { cx: 4, cy: 4, r: 2, fill: 'currentColor' }),
    createElement('circle', { cx: 12, cy: 5, r: 2, fill: 'currentColor' }),
    createElement('circle', { cx: 6, cy: 12, r: 2, fill: 'currentColor' }),
    createElement('path', {
      d: 'M4 6v2.5a3.5 3.5 0 0 0 3.5 3.5H10M12 7v1.5A3.5 3.5 0 0 1 8.5 12',
      stroke: 'currentColor', strokeWidth: 1.5, fill: 'none',
    }),
  )
}

export function apply(ctx: Context): void {
  if (ctx.betterSidebar === undefined) return

  ctx.effect(() =>
    ctx.betterSidebar.registerTab({
      id: 'dsh-merge-conflicts:list',
      title: () => 'Merge conflicts',
      description: () => 'Resolve git merge conflicts: accept current, incoming or both changes',
      icon: MergeIcon,
      order: 55,
      dedupeKey: () => 'dsh-merge-conflicts:list',
      component: (props: TabComponentProps) =>
        createElement(MergeConflictsView, { ctx: props.ctx, scope: props.scope, visible: props.visible }),
    })
  )
}
