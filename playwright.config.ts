/**
 * Playwright config for the headless-render mount lane (tests/e2e).
 *
 * The lane does NOT spawn the server itself: `scripts/e2e-mount.sh` boots a
 * real `dsh web` instance (with the npm-packed plugin mounted through the
 * official `dsh plugin add` channel, alongside dsh-better-sidebar) and injects
 * the base URL through `DSH_E2E_URL`. The spec's job is to render that URL in
 * headless Chromium and prove the plugin's tab mounts without crashing the
 * shell.
 *
 * Specs are named `*.e2e.ts` and live in `tests/e2e` (plural), so the unit
 * runner (`node --test test/`) never collects them.
 */
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.e2e.ts',
  // A deterministic gate: no retries, one worker, one browser. The whole lane
  // is a crash probe against one server instance, so serial execution keeps
  // the assertions meaningful.
  retries: 0,
  workers: 1,
  fullyParallel: false,
  timeout: 120_000,
  reporter: [
    ['list'],
    // Local debugging artifact; CI uploads the report dir on failure.
    ['html', { open: 'never' }],
  ],
  use: {
    browserName: 'chromium',
    headless: true,
    viewport: { width: 1440, height: 900 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
})
