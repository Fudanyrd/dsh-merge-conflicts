/**
 * Build for dsh-merge-conflicts:
 *   - lib/index.js  — host half (ESM, Node): the /merge-conflicts/api routes.
 *   - lib/client.js — browser client (CJS closure factory) registered with
 *     `window.__ModuleLoader__.load({ id: <package name>, factory })`.
 *
 * The client bundle follows the official DSH client-bundle preset:
 *   - `react`, `react/jsx-runtime`, `react-dom`, `cordis` resolve through the
 *     shell's frozen module table (external),
 *   - everything else is inlined,
 *   - CSS Modules compile to hashed class maps and inject a <style data-plugin>
 *     tag at factory execution.
 *
 * `PLUGIN_ID` must be the package name (`dsh-merge-conflicts`): for a plugin
 * mounted through the profile channel (cordis.patch.yml insert), the DSH
 * client-modules host half keys the boot graph row on `package.json` `name`,
 * and the browser `arrive()` check requires the factory id to equal that row
 * id. The `dsh-external/…` id is only for the separate plugin-registry channel
 * (`dsh.plugin.json`), which this package does not currently ship.
 */
import { readFile } from 'node:fs/promises'
import { basename, dirname, resolve as resolvePath } from 'node:path'
import { builtinModules, createRequire } from 'node:module'
import { transform } from 'lightningcss'
import type { UserConfig } from 'tsdown'

const require = createRequire(import.meta.url)

const NODE_BUILTINS = new Set([...builtinModules, ...builtinModules.map(id => `node:${id}`)])

const CLIENT_EXTERNALS = ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', 'cordis']

const PLUGIN_ID = 'dsh-merge-conflicts'

const CSS_VIRTUAL_PREFIX = '\0dsh-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'

function injectTag(pluginId: string, fileId: string, cssText: string): string {
  const tagId = `${pluginId}/${basename(fileId)}`
  return [
    `const css = ${JSON.stringify(cssText)};`,
    `const tagId = ${JSON.stringify(tagId)};`,
    `if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {`,
    `  const tag = document.createElement('style');`,
    `  tag.dataset.plugin = ${JSON.stringify(pluginId)};`,
    `  tag.dataset.pluginCss = tagId;`,
    `  tag.textContent = css;`,
    `  document.head.appendChild(tag);`,
    `}`,
  ].join('\n')
}

type BuildPlugin = NonNullable<UserConfig['plugins']>

/** Reject Node builtins and non-external @deepseek-ai/* value imports from the client bundle.
 *  `@deepseek-ai/cordis` is type-only for this plugin, so a real value import
 *  of it is a bug and must not sneak into the browser bundle. */
function purityGatePlugin(): BuildPlugin {
  return {
    name: 'dsh-client-bundle-purity',
    resolveId(source: string) {
      if (NODE_BUILTINS.has(source)) {
        throw new Error(`client bundle purity: Node builtin "${source}" cannot run in the browser`)
      }
      if (!source.startsWith('@deepseek-ai/')) return null
      if (CLIENT_EXTERNALS.includes(source)) return null
      throw new Error(
        `client bundle purity: "${source}" is not a platform module — cross-plugin value imports are forbidden`,
      )
    },
  }
}

function cssPlugin(pluginId: string): BuildPlugin {
  return {
    name: 'dsh-css-inline',
    resolveId(source: string, importer: string | undefined) {
      if (!source.endsWith('.css')) return null
      let abs: string
      if (source.startsWith('.') || source.startsWith('/') || /^[A-Za-z]:[\\/]/.test(source)) {
        abs = importer === undefined ? source : resolvePath(dirname(importer), source)
      } else {
        abs = require.resolve(source)
      }
      return CSS_VIRTUAL_PREFIX + abs + CSS_VIRTUAL_SUFFIX
    },
    async load(virtualId: string) {
      if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null
      const fileId = virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
      this.addWatchFile(fileId)
      const source = await readFile(fileId)
      if (fileId.endsWith('.module.css')) {
        const { code, exports: cssExports } = transform({
          filename: fileId,
          code: source,
          cssModules: { pattern: `[hash]_[local]` },
          minify: true,
        })
        const classMap: Record<string, string> = {}
        for (const [local, exp] of Object.entries(cssExports ?? {})) classMap[local] = exp.name
        return [
          injectTag(pluginId, fileId, code.toString()),
          `export default ${JSON.stringify(classMap)};`,
        ].join('\n')
      }
      return [injectTag(pluginId, fileId, source.toString('utf8')), 'export default "";'].join('\n')
    },
  }
}

export default [
  {
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2022',
    fixedExtension: false,
    dts: false,
    clean: false,
  },
  {
    entry: { client: 'src/client/index.tsx' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    dts: false,
    sourcemap: true,
    clean: false,
    external: [...CLIENT_EXTERNALS],
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
      'import.meta.resolve': 'undefined',
    },
    inputOptions: {
      resolve: {
        conditionNames: ['browser', 'import', 'require', 'default'],
      },
    },
    noExternal: (id: string) => (CLIENT_EXTERNALS.includes(id) ? undefined : true),
    plugins: [purityGatePlugin(), cssPlugin(PLUGIN_ID)],
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
      codeSplitting: false,
    },
  },
] satisfies UserConfig[]
