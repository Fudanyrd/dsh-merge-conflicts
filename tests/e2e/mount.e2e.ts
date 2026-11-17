/**
 * Headless-render mount lane: prove the npm-packed plugin mounts into a real
 * `dsh web` instance (with dsh-better-sidebar 0.32.0 installed alongside it)
 * and renders its registered tab without crashing the shell.
 *
 * The server is NOT started here — `scripts/e2e-mount.sh` boots `dsh web`
 * through the official `dsh plugin add` channel and injects the base URL via
 * `DSH_E2E_URL`. This spec:
 *
 *  1. seeds one git workspace + one session through the host's own RPC surface
 *     (the same `workspace.create` / `session.create` calls the UI makes), so
 *     the plugin's tab has a real session to render and a real (conflict-free)
 *     repository to list;
 *  2. loads the page in headless Chromium and asserts the shell and the
 *     dsh-better-sidebar host mount;
 *  3. opens DSH's native right Sidebar and the plugin's registered
 *     `dsh-merge-conflicts:list` guide entry;
 *  4. asserts the plugin's own view renders its empty state and that no
 *     pageerror / crash strip / plugin-prefixed console error appears.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect, type APIRequestContext } from '@playwright/test';
import { PAGE_URL, createHostApi, dismissOnboarding, hostRpc, sendFirstMessage } from './host';

/** Workspace the plugin's tab renders against (created by this spec). */
const WORKSPACE_PATH = process.env.DSH_E2E_WORKSPACE ?? join(tmpdir(), 'dsh-merge-conflicts-e2e-workspace');

/** The tab id registered by src/client/index.tsx. */
const TAB_ID = 'dsh-merge-conflicts:list';

let api: APIRequestContext;

/** Seed one conflict-free git workspace + one session through the host's unary
 *  RPC surface. The plugin's `list` route runs `git rev-parse` and `git
 *  status` against the session cwd, so the workspace must be a real git repo. */
async function seedSession(): Promise<void> {
  mkdirSync(WORKSPACE_PATH, { recursive: true });
  writeFileSync(join(WORKSPACE_PATH, 'hello.txt'), 'hello from the mount lane\n');
  execFileSync('git', ['init', '-q', WORKSPACE_PATH]);
  execFileSync('git', ['-C', WORKSPACE_PATH, 'config', 'user.name', 'dsh-merge-conflicts-ci']);
  execFileSync('git', ['-C', WORKSPACE_PATH, 'config', 'user.email', 'ci@dsh.invalid']);
  execFileSync('git', ['-C', WORKSPACE_PATH, 'add', 'hello.txt']);
  execFileSync('git', ['-C', WORKSPACE_PATH, 'commit', '-qm', 'seed']);

  const workspace = await hostRpc<{ workspace: { workspaceId: string } }>(api, 'workspace.create', { path: WORKSPACE_PATH });
  await hostRpc<{ sessionId: string }>(api, 'session.create', { workspaceId: workspace.value.workspace.workspaceId });
}

test.beforeAll(async () => {
  api = await createHostApi();
  await seedSession();
});

test.afterAll(async () => {
  await api?.dispose();
});

test('plugin mounts into the DSH shell and renders its sidebar tab', async ({ page }) => {
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') {consoleErrors.push(message.text());}
  });

  // Load the shell. The app renders into #root; dsh-better-sidebar appends its
  // own [data-dsh-better-sidebar] host once its client half activates.
  await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#root > *')).not.toHaveCount(0, { timeout: 90_000 });
  await expect(page.locator('[data-dsh-better-sidebar]')).toBeAttached({ timeout: 90_000 });

  // A keyless boot stacks onboarding takeovers that mask the whole shell.
  await dismissOnboarding(page);

  // The native right Sidebar's corner control is rendered only for a session
  // with content; the seeded session starts blank, so give it one message.
  await sendFirstMessage(page);

  // Open the native right Sidebar and wait for its start-page guide.
  await page.locator('[data-sidebar-right-expand]').first().click();
  await expect(page.locator('[data-sidebar-right-panel]')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[data-sidebar-right-guide]')).toBeVisible({ timeout: 30_000 });

  // The plugin's tab type must be offered by the guide. The kind/entry id is
  // the descriptor id passed to ctx.betterSidebar.registerTab.
  const entry = page.locator(`[data-sidebar-right-guide-entry="${TAB_ID}"]`);
  await expect(entry, `the guide must offer the "${TAB_ID}" tab`).toHaveCount(1);

  // Open the tab; the plugin's own view renders under the native tab host.
  await entry.getByRole('button').first().click();
  await expect(page.locator('[data-dsh-native-tab-host]:visible')).toBeAttached({ timeout: 30_000 });
  const view = page.locator('[data-dsh-merge-conflicts]');
  await expect(view).toBeAttached({ timeout: 30_000 });
  await expect(view.getByText('No merge conflicts')).toBeVisible({ timeout: 30_000 });

  // No pageerror and no crash strip. The client does not have a dedicated
  // error strip prefix, but any rendered text starting with the plugin prefix
  // would indicate a caught client failure surfaced to the user.
  expect(pageErrors).toEqual([]);
  const stripTexts = await view.locator('div').evaluateAll(
    (nodes) => nodes.map((node) => (node.textContent ?? '').trim()).filter((text) => /^dsh-merge-conflicts:/.test(text)),
  );
  expect(stripTexts, 'a dsh-merge-conflicts error strip is present in the tab').toEqual([]);

  const pluginConsoleErrors = consoleErrors.filter((text) => text.includes('dsh-merge-conflicts') || text.includes('merge-conflicts'));
  expect(pluginConsoleErrors, 'plugin-prefixed console errors must not appear').toEqual([]);
});
