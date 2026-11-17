/**
 * Host glue for the mount lane: the authenticated request context and host
 * RPC seeding. The transport contracts (one-time-token launch URL, slash
 * `/api` endpoints) match deepseek-harness 0.2.2-rc.1 and are exercised by
 * the same lane in dsh-better-sidebar's CI.
 */
import { expect, request, type APIRequestContext, type Page } from '@playwright/test';

const envUrl = process.env.DSH_E2E_URL;
if (!envUrl) {
  throw new Error('DSH_E2E_URL is not set — boot a DSH web instance with the plugin mounted and point this lane at it (see scripts/e2e-mount.sh)');
}
// Re-bind with an explicit string type: closure bodies below do not inherit
// the guard's narrowing of envUrl.
const RAW_URL: string = envUrl;

function parseLaunchUrl(raw: string): { origin: string; pageUrl: string } {
  const url = new URL(raw);
  if (url.searchParams.get('token') === null) {
    throw new Error(`launch URL carries no ?token= — not a deepseek-harness authenticated launch URL: ${raw}`);
  }
  return { origin: url.origin, pageUrl: raw };
}

const LAUNCH = parseLaunchUrl(RAW_URL);

/** Origin for URL construction (a token URL would corrupt path joins). */
export const ORIGIN = LAUNCH.origin;

/** page.goto target: the launch URL as printed (token included — navigating it
 *  exchanges the token for the browser cookie). */
export const PAGE_URL = LAUNCH.pageUrl;

/**
 * Exchange the one-time launch token through Playwright's own request stack.
 * The token URL answers 303 with Set-Cookie; `maxRedirects: 0` keeps the 303
 * from being followed (following it drops the cookie this exists to capture).
 */
async function exchangeLaunchCookieViaPlaywright(launchUrl: string): Promise<string> {
  const context = await request.newContext();
  try {
    await context.get(launchUrl, { maxRedirects: 0 });
    const [cookie] = (await context.storageState()).cookies;
    if (cookie === undefined) {
      throw new Error('token exchange produced no cookie — cannot authenticate /api seeding');
    }
    return `${cookie.name}=${cookie.value}`;
  } finally {
    await context.dispose();
  }
}

/** The exchanged cookie pair, memoised for the process. */
let cookieHeader: string | undefined;
async function authCookie(): Promise<string> {
  cookieHeader ??= await exchangeLaunchCookieViaPlaywright(RAW_URL);
  return cookieHeader;
}

/** Authenticated request context for host RPC seeding (cookie attached). */
export async function createHostApi(): Promise<APIRequestContext> {
  return request.newContext({
    baseURL: ORIGIN,
    extraHTTPHeaders: { cookie: await authCookie() },
  });
}

/** The unwrapped `result` of a successful host RPC. */
export interface HostRpcOk<T> {
  ok: true
  value: T
}

let rpcCounter = 0;

/** The args key per host method. deepseek-harness 0.2.2-rc.1 controllers key
 *  the args object by the TypeScript parameter name; these two are the only
 *  methods the mount lane seeds. */
const RPC_ARGS_KEY: Record<string, string> = {
  'workspace.create': 'request',
  'session.create': 'request',
};

/** Call a host unary RPC (`'workspace.create'`, `'session.create'`). */
export async function hostRpc<T = unknown>(
  api: APIRequestContext,
  method: string,
  args: Record<string, unknown> = {},
): Promise<HostRpcOk<T>> {
  const key = RPC_ARGS_KEY[method];
  if (key === undefined) {
    throw new Error(`host: no args key for ${JSON.stringify(method)}`);
  }
  const endpoint = method.split('.').join('/');
  rpcCounter += 1;
  const rpcId = `e2e-${method}-${rpcCounter}`;
  const res = await api.post(`/api/${endpoint}`, {
    data: { type: 'client-request', rpcId, method: endpoint, payload: { args: { [key]: args } } },
  });
  const bodyText = await res.text();
  if (!res.ok()) {
    throw new Error(`hostRpc ${method} HTTP ${res.status()}: ${bodyText.slice(0, 400)}`);
  }
  let envelope: { type?: string; result?: { ok: true; value: T } | { ok: false; error: unknown } };
  try {
    envelope = JSON.parse(bodyText) as typeof envelope;
  } catch {
    throw new Error(`hostRpc ${method}: non-JSON response: ${bodyText.slice(0, 400)}`);
  }
  const result = envelope.result;
  if (result === undefined || result.ok !== true) {
    throw new Error(`hostRpc ${method} envelope error: ${bodyText.slice(0, 400)}`);
  }
  return result;
}

/** Dismiss keyless onboarding before interacting with the shell. */
export async function dismissOnboarding(page: Page): Promise<void> {
  const getStarted = page.getByRole('dialog', { name: 'Get started', exact: true });
  const buttons = [
    getStarted.getByRole('button', { name: 'Close', exact: true }),
    page.getByRole('button', { name: 'Continue', exact: true }),
    page.getByRole('button', { name: 'Configure later', exact: true }),
  ];
  try {
    await expect.poll(async () => {
      const counts = await Promise.all(buttons.map(button => button.count()));
      return counts.reduce((total, count) => total + count, 0);
    }, { timeout: 60_000 }).toBeGreaterThan(0);
  } catch {
    // A previously acknowledged onboarding may not appear again.
    return;
  }
  for (let round = 0; round < 8; round++) {
    let dismissed = false;
    for (const button of buttons) {
      if (await button.count() === 0) {continue;}
      try {
        await button.click({ timeout: 4_000 });
        dismissed = true;
        await page.waitForTimeout(1_000);
      } catch {
        // A stacked welcome notice can mask another onboarding step.
      }
    }
    if (!dismissed) {break;}
  }
  await expect(getStarted).not.toBeVisible();
}

/** The host composer's editable for the first-message path. */
export function composerLocator(page: Page) {
  return page.getByRole('textbox', { name: /^(Describe what you want to build|描述你想要构建)/ });
}

/**
 * Send one message in the session the shell opened, so the conversation header
 * (and the native right Sidebar's corner control) exists. DSH renders the
 * header only for a session with content, while a freshly seeded blank session
 * shows the empty hero.
 */
export async function sendFirstMessage(page: Page): Promise<void> {
  const composer = composerLocator(page);
  await expect(composer).toBeVisible({ timeout: 60_000 });
  await composer.click();
  await page.keyboard.type('merge-conflicts mount lane smoke');
  const send = page.getByRole('button', { name: /^(Send message|发送消息)$/ });
  await expect(send).toBeEnabled({ timeout: 30_000 });
  await send.click();
}
