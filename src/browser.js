/**
 * Shared browser helper.
 *
 * Runs Chrome fully headless so nothing ever appears on screen.
 *
 * Two things make that possible. Chrome is spawned as an ordinary process and
 * attached to over the debugging port — a Playwright-*launched* browser gets
 * fingerprinted as automated and loops forever on Cloudflare's challenge. And
 * the user-agent is forced to the normal (non-headless) string, because the
 * saved cf_clearance cookie is bound to the UA: headless Chrome otherwise
 * announces "HeadlessChrome/..." and gets challenged every time.
 *
 * `visible: true` is used only when a challenge needs a human click.
 *
 * Note for macOS: `--window-position=-3000,-3000` does NOT hide a window here.
 * macOS clamps it back on-screen (verified: requested -3000,-3000, landed at
 * 0,25). Headless is the only way to actually stay out of the way.
 */
import { chromium } from 'playwright';
import { spawn, execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataFile } from './paths.js';

// Chrome's own profile dir (cookies, cf_clearance) — not your portfolio.
const PROFILE_DIR = dataFile('chrome-profile');
const UA_FILE = dataFile('user-agent.txt');

/**
 * Your installed Chrome — used ONLY to read a version number for the
 * user-agent string. It is never launched.
 */
const INSTALLED_CHROME =
  process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : process.platform === 'win32'
      ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
      : 'google-chrome';

/**
 * The browser we actually drive: Playwright's bundled Chrome for Testing.
 *
 * We used to launch the installed Chrome. On macOS that quietly starts a second,
 * app-level Chrome using your normal profile — a window appears out of nowhere —
 * and shutting ours down could quit the whole Chrome *application*, closing the
 * tabs you had open. Chrome for Testing is a separate app bundle, so it cannot
 * collide with or quit your browser. Verified: your Chrome process count is
 * unchanged before, during and after a run.
 */
export const CHROME_PATH = chromium.executablePath();

/**
 * Fail with an instruction, not a stack trace.
 *
 * The browser is downloaded separately from the npm install, so "it worked on
 * my machine" is the default experience for anyone cloning this. A packaged app
 * carries its own copy; a checkout has to be told.
 */
function assertBrowserInstalled() {
  if (existsSync(CHROME_PATH)) return;
  throw new Error(
    'Chrome for Testing is not installed, so there is no browser to drive.\n' +
      '  Fix it with:  npx playwright install chromium\n' +
      `  (looked in: ${CHROME_PATH})`,
  );
}

const PLATFORM_UA = {
  darwin: 'Macintosh; Intel Mac OS X 10_15_7',
  win32: 'Windows NT 10.0; Win64; x64',
  linux: 'X11; Linux x86_64',
};

/**
 * The user-agent a normal windowed Chrome would send.
 *
 * Chrome reports only its major version in the UA (151.0.7922.169 -> 151.0.0.0),
 * so this can be derived from `--version` without ever opening a window.
 * Cached after the first call.
 */
export async function resolveUserAgent() {
  try {
    const cached = (await readFile(UA_FILE, 'utf8')).trim();
    if (cached) return cached;
  } catch {
    /* not cached yet */
  }

  let major = '131';
  try {
    const out = execFileSync(INSTALLED_CHROME, ['--version'], { encoding: 'utf8' });
    major = out.match(/(\d+)\./)?.[1] ?? major;
  } catch {
    /* fall back to a plausible recent version */
  }

  const platform = PLATFORM_UA[process.platform] ?? PLATFORM_UA.linux;
  const ua =
    `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) ` +
    `Chrome/${major}.0.0.0 Safari/537.36`;

  await mkdir(path.dirname(UA_FILE), { recursive: true }).catch(() => {});
  await writeFile(UA_FILE, ua).catch(() => {});
  return ua;
}

/**
 * Open a browser. Headless unless `visible` is set.
 * @returns {Promise<{context: import('playwright').BrowserContext, close: () => Promise<void>, userAgent: string}>}
 */
/**
 * PIDs listening on a TCP port. Returns [] if lsof isn't available.
 *
 * Needed because "did our spawn actually produce the browser we're talking to?"
 * cannot be answered from the child handle alone — see openBrowser below.
 */
function pidsOnPort(port) {
  try {
    return execFileSync('lsof', ['-ti', `tcp:${port}`], { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .split('\n')
      .map((line) => Number(line.trim()))
      .filter((pid) => Number.isInteger(pid) && pid > 0);
  } catch {
    return []; // nothing listening, or no lsof
  }
}

function killPids(pids) {
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone, or not ours to kill */
    }
  }
}

export async function openBrowser({ port = 9280, visible = false } = {}) {
  /**
   * Clear out any Chrome left over from an earlier run before spawning.
   *
   * This is not tidiness, it's correctness. Chrome refuses to run two instances
   * against one --user-data-dir: a second launch detects the first, hands its
   * command line to it and exits immediately. Our `chrome` handle would then
   * point at a dead launcher, so close() would kill nothing, the real browser
   * would survive, and the CDP socket to it would keep this process alive
   * forever — a scheduled run that fetches perfectly and then never finishes.
   */
  assertBrowserInstalled();

  const stale = pidsOnPort(port);
  if (stale.length) {
    console.log(`  (clearing ${stale.length} leftover Chrome process${stale.length === 1 ? '' : 'es'} on port ${port})`);
    killPids(stale);
    await new Promise((r) => setTimeout(r, 600));
  }

  const userAgent = await resolveUserAgent();

  const chrome = spawn(
    CHROME_PATH,
    [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${PROFILE_DIR}`,
      '--no-first-run',
      '--no-default-browser-check',
      `--user-agent=${userAgent}`,
      '--window-size=1400,900',
      ...(visible ? [] : ['--headless=new']),
    ],
    { stdio: 'ignore' },
  );

  let browser = null;
  for (let i = 0; i < 40 && !browser; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    } catch {
      /* still starting */
    }
  }
  if (!browser) {
    chrome.kill();
    throw new Error('Chrome did not expose its debugging port in time');
  }

  return {
    context: browser.contexts()[0],
    userAgent,
    close: async () => {
      // Drop the CDP websocket first. While it is open it counts as an active
      // handle, and Node will not exit even with all the work done and the
      // browser dead — which is exactly how a finished fetch used to hang.
      try {
        await browser.close();
      } catch {
        /* already disconnected */
      }

      // SIGKILL rather than SIGTERM, since SIGTERM triggers Chrome's graceful
      // app-quit path.
      try {
        chrome.kill('SIGKILL');
      } catch {
        /* already gone */
      }

      // And whatever still owns the port, which may not be our child at all if
      // Chrome handed off to an existing instance. Safe because this port and
      // profile belong to Chrome for Testing, a separate app bundle from the
      // Chrome you browse with.
      killPids(pidsOnPort(port));
    },
  };
}

/** True if the page is showing a Cloudflare interstitial. */
export async function isChallenged(page) {
  try {
    return /just a moment|challenge|attention required|verifying/i.test(await page.title());
  } catch {
    return true; // mid-navigation counts as unresolved
  }
}

/** Load a page and return its visible text. Used for importing a portfolio. */
export async function readPageText(context, url, { settle = 4000, timeout = 45_000 } = {}) {
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
    await page.waitForTimeout(settle);
    const title = await page.title().catch(() => '');
    const text = await page.evaluate(() => document.body.innerText);
    return { title, text, url: page.url() };
  } finally {
    await page.close().catch(() => {});
  }
}
