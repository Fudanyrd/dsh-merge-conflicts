# dsh-merge-conflicts

[![dsh-plugin](https://img.shields.io/badge/GitHub-dsh--plugin-blue)](https://github.com/topics/dsh-plugin)
[![better-sidebar](https://img.shields.io/badge/better--sidebar-%5E0.12.0-6e56cf)](https://github.com/omdsh-dev/DSH-better-sidebar)  

A [dsh-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) consumer
plugin that adds a **Merge conflicts** tab to the DSH right sidebar. It lists
every unmerged (conflicted) file from `git status`, shows both sides of each
conflict, and resolves it — **accept current**, **accept incoming**, or
**accept both** — then stages the result.

## What it does

- **Lists** conflicted files (porcelain v2 `u` records: `UU`, `AA`, `AU`, `UA`,
  `DD`, `DU`, `UD`) and detects the active operation (`merge` / `rebase`).
- **Shows** the current side and the incoming side side-by-side, plus the raw
  file with conflict markers highlighted.
- **Resolves** a conflict:
  - **Accept current** — take the current side and stage it (`git checkout --ours/--theirs`).
  - **Accept incoming** — take the incoming side and stage it.
  - **Accept both** — strip the conflict markers and keep both blocks (union),
    then stage the result. Disabled for delete/modify conflicts that carry no
    markers.
- The rebase `ours`/`theirs` swap is handled automatically: during a rebase,
  "current" is the commit being replayed and "incoming" is the upstream.

Resolution only stages the file (`git add`); it never commits, pushes or sets
git identity.

## Architecture

- **Host half** (`src/index.ts`, `src/git-conflicts.ts`) — a Node cordis plugin
  that spawns `git` and serves three JSON POST routes under
  `/merge-conflicts/api`:
  - `list` → `{ root, operation, conflicts: [{ path, rel, xy, label }] }`
  - `read` → `{ path, rel, xy, label, operation, content, current, incoming, hasMarkers }`
  - `resolve` → `{ path }` for `mode: "current" | "incoming" | "both"`
- **Client half** (`src/client/index.tsx`) — registers the
  `dsh-merge-conflicts:list` tab through `ctx.betterSidebar.registerTab` and
  renders the React UI.

Every route is admitted through the same public `Connection` service as the
`/api` gateway (Host/Origin + browser authentication).

## Install

### Marketplace / plugin registry

`dsh.plugin.json` declares the manifest (`id: dsh-external/dsh-merge-conflicts`)
and the client entry. Install through the DSH plugin market, or add it to your
profile manually.

### Manual profile mount

```sh
cd ~/.dsh/profiles/web
pnpm add dsh-merge-conflicts   # or link:../dsh-merge-conflicts
```

Then append a row to `~/.dsh/profiles/web/cordis.patch.yml`:

```yaml
- insert:
    - id: dsh-merge-conflicts
      name: dsh-merge-conflicts
```

Hard-refresh the browser (Ctrl/Cmd+Shift+R) for the client half; restart the
`dsh web` host only if you change the host half.

## Build

```sh
pnpm install
pnpm build     # tsc declarations + tsdown (lib/index.js + lib/client.js)
```

`pnpm typecheck` runs the standalone type gate. The client bundle registers
with `window.__ModuleLoader__.load({ id: 'dsh-merge-conflicts', … })` (the
package name — the profile channel keys client-modules rows on it) and
externals `react` / `cordis` resolve through the shell module table.

## License

MIT
