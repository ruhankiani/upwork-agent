/**
 * Desktop shell.
 *
 * Runs the existing local server as a child process and points a native window
 * at it. Nothing in src/ changes — the same code powers the app window and the
 * plain `npm run ui` browser mode.
 *
 * With a schedule enabled and background runs on, the shell also becomes a
 * background agent: closing the window hides it into the menu bar instead of
 * quitting, so the scheduler in the server keeps its slots. Quitting really
 * does stop everything — the server is this app's child, so nothing survives
 * it. The shell itself never decides *when* to run —
 * it only subscribes to the server's event stream and turns what arrives into
 * native notifications. Scheduling logic lives in src/scheduler.js so it works
 * the same in `npm run ui` browser mode.
 *
 * CommonJS (.cjs) on purpose: the rest of the project is ESM, and Electron's
 * main process is simplest to keep in CJS.
 */
const { app, BrowserWindow, Menu, Notification, Tray, nativeImage, powerMonitor, powerSaveBlocker, shell, dialog } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const http = require('node:http');

const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const SERVER = path.join(ROOT, 'src', 'server.js');

/**
 * Where the app keeps things you own.
 *
 * Unpackaged, that's the repo itself — a checkout is yours, and `npm run ui`
 * and the CLI must keep using the same files. Packaged, the code lives inside a
 * signed .app that gets replaced wholesale on update, so job history and your
 * portfolio move to Application Support and outlive it.
 */
const PACKAGED = app.isPackaged;
const USER_DIR = PACKAGED ? app.getPath('userData') : ROOT;
const DATA_DIR = path.join(USER_DIR, 'data');
const PROFILE_DIR = path.join(USER_DIR, 'profile');
const ENV_FILE = path.join(USER_DIR, '.env');

/**
 * First launch of a packaged build has no portfolio, rubric or API key, and a
 * judge with no rubric scores nothing. Copy the shipped defaults out of the
 * bundle once, then never touch them again — they are yours to edit from then
 * on, and an update must not overwrite them.
 */
function seedUserFiles() {
  if (!PACKAGED) return;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(PROFILE_DIR)) {
      fs.cpSync(path.join(ROOT, 'profile'), PROFILE_DIR, { recursive: true });
      console.log(`[shell] Seeded your profile into ${PROFILE_DIR}`);
    }
    const bundledEnv = path.join(ROOT, '.env');
    if (!fs.existsSync(ENV_FILE) && fs.existsSync(bundledEnv)) {
      fs.copyFileSync(bundledEnv, ENV_FILE);
    }
  } catch (e) {
    dialog.showErrorBox('Could not set up your files', `${e.message}\n\nTried: ${USER_DIR}`);
  }
}

/**
 * The browser shipped inside the bundle, if there is one.
 *
 * Playwright looks in ~/Library/Caches/ms-playwright unless told otherwise, and
 * that directory only exists on a machine where someone ran
 * `npx playwright install chromium`. Pointing it at our own copy is what lets
 * the app work on a Mac with no Node and no toolchain.
 */
function bundledBrowsers() {
  if (!PACKAGED) return null;
  const dir = path.join(ROOT, '..', 'browsers');
  return fs.existsSync(dir) ? dir : null;
}

/** Passed to the server, and inherited by every script it spawns. */
function childEnv() {
  const browsers = bundledBrowsers();
  return {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    UPWORK_AGENT_DATA_DIR: DATA_DIR,
    UPWORK_AGENT_PROFILE_DIR: PROFILE_DIR,
    UPWORK_AGENT_ENV_FILE: ENV_FILE,
    ...(browsers ? { PLAYWRIGHT_BROWSERS_PATH: browsers } : {}),
  };
}
const TRAY_ICON = path.join(__dirname, 'assets', 'trayTemplate.png');
const PORT = 5173;
const URL = `http://localhost:${PORT}/`;

let server = null;
let win = null;
let tray = null;
// The window is hidden rather than destroyed on close, so we need to know a
// real quit from a close. Without this the server child would be killed the
// first time you closed the window and every later slot would silently no-op.
let quitting = false;
// Latest state pushed from the server, used to label the tray menu.
let schedule = { config: { enabled: false }, nextRunAt: null };
// Notifications are garbage collected along with their click handlers if
// nothing holds a reference, which silently breaks click-to-open.
const liveNotifications = new Set();

/**
 * Prefer a single instance, but never insist on it.
 *
 * Two copies fighting over port 5173 and one tray icon each helps nobody — but
 * this must not be load-bearing. Electron arbitrates the lock on macOS by
 * comparing code signatures, and an ad-hoc signed build (which is what a
 * release with no Apple Developer account is) cannot satisfy that check:
 * task_name_for_pid is refused, and the request comes back false on a machine
 * where nothing else is running. Quitting on that turned every launch of the
 * packaged app into an immediate, silent exit with no error to read.
 *
 * portInUse() below already handles a real second copy properly by reusing the
 * running server, so the worst case here is a duplicate tray icon.
 */
if (!app.requestSingleInstanceLock()) {
  console.warn('[shell] Single-instance lock unavailable (expected on an ad-hoc signed build) — continuing.');
}
app.on('second-instance', () => showWindow());

/**
 * Is the app allowed to outlive its window?
 *
 * Both halves have to be true: there is no point hiding into the menu bar with
 * no schedule to keep, and someone who turned background off wants closing the
 * window to mean closing the app.
 */
const backgroundOn = () => Boolean(schedule.config?.enabled && schedule.config?.background);

/**
 * Keep macOS from napping us while a schedule is live.
 *
 * App Nap doesn't just idle a backgrounded app — it explicitly "reduces the
 * frequency with which its timers are fired". A hidden app whose whole job is
 * to fire a timer every 30 seconds is precisely the case it punishes, and the
 * symptom is a schedule that simply never runs while the window is closed.
 *
 * `prevent-app-suspension` allows the display to sleep and the machine to be
 * idle; it only stops *this app* being suspended. It's released the moment
 * background running is turned off, so nothing is held when nothing is due.
 */
let blockerId = null;

function syncPowerBlocker() {
  const wanted = backgroundOn();
  if (wanted && blockerId === null) {
    blockerId = powerSaveBlocker.start('prevent-app-suspension');
    report('App Nap suppressed while the schedule runs in the background.');
  } else if (!wanted && blockerId !== null) {
    powerSaveBlocker.stop(blockerId);
    blockerId = null;
    report('Background runs off — App Nap suppression released.');
  }
}

/** Resolve once the server answers, so we never load a blank window. */
function waitForServer(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = http.get(URL, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', () => {
        if (Date.now() > deadline) reject(new Error('server did not start'));
        else setTimeout(attempt, 300);
      });
    };
    attempt();
  });
}

function startServer() {
  // process.execPath is Electron itself; ELECTRON_RUN_AS_NODE makes it behave
  // as a plain Node binary, so there's no dependency on a `node` on PATH.
  server = spawn(process.execPath, [SERVER], {
    cwd: ROOT,
    env: childEnv(),
    stdio: 'inherit',
  });
  server.on('error', (e) => {
    dialog.showErrorBox('Could not start', e.message);
    app.quit();
  });
}

/** POST to the local server, fire and forget. Used by the tray and on wake. */
function post(pathname, payload = null) {
  const body = payload === null ? '' : JSON.stringify(payload);
  const req = http.request(
    {
      host: 'localhost',
      port: PORT,
      path: pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    },
    (res) => res.resume(),
  );
  req.on('error', () => {});
  req.end(body);
}

/** Mirror a line into the app's Activity panel as well as the console. */
function report(message, level = 'info') {
  console.log(`[shell] ${message}`);
  post('/api/log', { message, level });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1340,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'Upwork Agent',
    backgroundColor: '#17171a',
    // Paint before showing, so there's no white flash on launch.
    show: false,
    // Keep the traffic lights but drop the title bar text on macOS.
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });

  win.loadURL(URL);

  // Tell the page it's running in the app shell so it can leave room for the
  // macOS traffic lights and make the header draggable. In browser mode this
  // never fires and the page stays a normal web page.
  win.webContents.on('dom-ready', () => {
    win.webContents.executeJavaScript(
      `document.body.classList.add('electron'${process.platform === 'darwin' ? ", 'mac'" : ''});`,
    );
  });

  // Job links must open in the real browser — not swallowed by the app window,
  // which has no back button or address bar.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(URL)) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });

  /**
   * Closing the window with a schedule on means "get out of my way", not
   * "stop watching Upwork". Hide instead, and let the tray icon be the way
   * back. With no schedule this stays the single-window tool it was.
   */
  win.on('close', (e) => {
    if (quitting || !backgroundOn()) return;
    e.preventDefault();
    win.hide();
    if (process.platform === 'darwin') app.dock?.hide();
  });

  win.once('ready-to-show', () => {
    win.show();
    win.focus();
    if (process.platform === 'darwin') app.focus({ steal: true });
  });

  win.on('closed', () => (win = null));
}

/** Bring the app forward, recreating or un-hiding the window as needed. */
function showWindow(view = null) {
  clearUnseen();
  if (process.platform === 'darwin') app.dock?.show();
  if (!win) {
    createWindow();
  } else {
    win.show();
    win.focus();
  }
  if (process.platform === 'darwin') app.focus({ steal: true });
  // Land on the page the notification was about rather than wherever the user
  // happened to leave it.
  if (view && win) {
    win.webContents.executeJavaScript(`typeof show === 'function' && show(${JSON.stringify(view)});`)
      .catch(() => {});
  }
}

/* ================= unread count ================= */

/**
 * A count in the menu bar and on the dock icon.
 *
 * Native banners depend on macOS deciding to draw them — permission, Focus,
 * whether it feels like it. This does not: setTitle draws text next to the tray
 * icon and nothing can suppress it. It answers "did anything happen while I was
 * away?" even when notifications are broken, and it persists, which a banner
 * you missed by ten seconds does not.
 */
let unseen = 0;
let needsAttention = false;

function paintUnseen() {
  if (tray) {
    tray.setTitle(needsAttention ? ' ⚠' : unseen ? ` ${unseen}` : '');
    tray.setToolTip(
      needsAttention
        ? 'Upwork Agent — needs a Cloudflare check'
        : unseen
          ? `Upwork Agent — ${unseen} new since you last looked`
          : 'Upwork Agent',
    );
  }
  if (process.platform === 'darwin') {
    app.dock?.setBadge(needsAttention ? '!' : unseen ? String(unseen) : '');
  }
}

function addUnseen(n) {
  unseen += n;
  paintUnseen();
}

/** Opening the window is the acknowledgement — you have now looked. */
function clearUnseen() {
  unseen = 0;
  needsAttention = false;
  paintUnseen();
}

/* ================= notifications ================= */

/**
 * Raise a native notification.
 *
 * macOS requires the app to be code-signed for these to appear at all —
 * Electron 42 moved to Apple's UNNotification API, and an unsigned binary just
 * emits `failed`. Ad-hoc signing is enough and costs nothing:
 *
 *   codesign --force --deep --sign - node_modules/electron/dist/Electron.app
 *
 * The `failed` handler below logs rather than throwing, so a run on an unsigned
 * build still completes — you just don't get told about it.
 */
function notify({ title, body, view = 'jobs' }) {
  if (!Notification.isSupported()) {
    report('Notifications are not supported on this system.', 'warn');
    return;
  }

  const n = new Notification({ title, body });
  liveNotifications.add(n);

  n.on('show', () => report(`Notification shown: "${title}"`));
  n.on('click', () => {
    report('Notification clicked — opening the app.');
    showWindow(view);
  });
  n.on('failed', (_e, err) => {
    report(`Notification FAILED: ${err}`, 'error');
    report(
      'macOS refuses notifications from an unsigned app. Quit, run `npm run sign`, then start again. ' +
        'If it is signed, check System Settings > Notifications > Electron is set to Allow, and that Do Not Disturb is off.',
      'error',
    );
  });
  n.on('close', () => liveNotifications.delete(n));

  n.show();
}

/** Turn a finished run into something worth reading on a lock screen. */
function describeRun(summary) {
  // "Nothing new" is a real, common and successful outcome — Upwork simply had
  // no postings you hadn't already seen. Say so, rather than leaving silence
  // that reads as a failure.
  if (!summary || !summary.added) return 'Ran fine — no postings you had not already seen.';
  const added = `${summary.added} new job${summary.added === 1 ? '' : 's'}`;
  if (!summary.top) return `${added}, none scoring 60+. See All recent.`;
  return `${added} · ${summary.top} top pick${summary.top === 1 ? '' : 's'}`;
}

/* ================= server event stream ================= */

/**
 * Subscribe to the server's SSE stream.
 *
 * Reconnects on drop because the server can outlive or predate this process:
 * `npm run ui` may already be serving on 5173, and the shell attaches to
 * whatever is there rather than spawning a second one.
 */
function subscribeToEvents() {
  const req = http.get({ host: 'localhost', port: PORT, path: '/api/events' }, (res) => {
    let buffer = '';
    res.setEncoding('utf8');
    res.on('data', (chunk) => {
      buffer += chunk;
      // SSE frames are separated by a blank line; keep any partial tail.
      const frames = buffer.split('\n\n');
      buffer = frames.pop();
      for (const frame of frames) {
        const line = frame.split('\n').find((l) => l.startsWith('data: '));
        if (!line) continue; // keep-alive comment
        try {
          handleEvent(JSON.parse(line.slice(6)));
        } catch {
          /* a malformed frame must never kill the stream */
        }
      }
    });
    res.on('end', () => setTimeout(subscribeToEvents, 2000));
  });
  req.on('error', () => setTimeout(subscribeToEvents, 2000));
}

function handleEvent(event) {
  if (event.type === 'schedule') {
    schedule = event.state ?? schedule;
    buildTray();
    syncPowerBlocker();
    return;
  }

  // A test is explicitly asked for, so it ignores the notify preference —
  // otherwise the button would appear broken to someone who turned it off.
  if (event.type === 'test') {
    addUnseen(1); // proves the menu-bar path even if the banner never draws

    notify({ title: 'Upwork Agent', body: 'Notifications are working. Click to open the app.', view: 'schedule' });
    return;
  }

  if (!schedule.config?.notify) return;

  if (event.type === 'run-finished' && event.ok && event.summary?.added) {
    // Count top picks when there are any, otherwise the raw arrivals — the
    // number should mean "things worth opening the app for".
    addUnseen(event.summary.top || event.summary.added);
  }
  if (event.type === 'attention') {
    needsAttention = true;
    paintUnseen();
  }

  if (event.type === 'run-finished') {
    if (event.timedOut) {
      notify({
        title: 'Upwork Agent — run timed out',
        body: 'It was stopped so it could not block later runs. The next slot will try again.',
        view: 'schedule',
      });
    } else {
      notify(
        event.ok
          ? { title: 'Upwork Agent', body: describeRun(event.summary), view: 'jobs' }
          : { title: 'Upwork Agent — run failed', body: 'Open the app to see what went wrong.', view: 'errors' },
      );
    }
  }

  if (event.type === 'attention') {
    // fetch.js stopped rather than opening a browser window nobody asked for.
    notify({
      title: 'Upwork Agent needs a moment',
      body: 'Cloudflare clearance expired. Click here, then press Fetch & score once.',
      view: 'jobs',
    });
  }
}

/* ================= tray ================= */

function nextRunLabel() {
  if (!schedule.config?.enabled) return 'Schedule off';
  if (!schedule.nextRunAt) return 'No run scheduled';
  const when = new Date(schedule.nextRunAt);
  const sameDay = when.toDateString() === new Date().toDateString();
  const time = when.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return `Next run: ${sameDay ? time : `${when.toLocaleDateString([], { weekday: 'short' })} ${time}`}`;
}

function buildTray() {
  if (!tray) {
    const icon = nativeImage.createFromPath(TRAY_ICON);
    // A template image is black-and-alpha only; macOS inverts it to match a
    // light or dark menu bar instead of us shipping two icons.
    icon.setTemplateImage(true);
    tray = new Tray(icon);
    tray.setToolTip('Upwork Agent');
    // Clicking the icon itself opens the app; the menu is the right-click.
    tray.on('click', () => showWindow());
    paintUnseen();
  }

  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Upwork Agent', click: () => showWindow() },
      { type: 'separator' },
      { label: nextRunLabel(), enabled: false },
      { label: 'Run now', click: () => post('/api/schedule/run-now') },
      {
        label: 'Schedule enabled',
        type: 'checkbox',
        checked: Boolean(schedule.config?.enabled),
        click: (item) => setSchedule({ enabled: item.checked }),
      },
      {
        label: 'Keep running after the window closes',
        type: 'checkbox',
        checked: Boolean(schedule.config?.background),
        click: (item) => setSchedule({ background: item.checked }),
      },
      {
        // The unambiguous off switch. Turning the schedule off is not the same
        // as quitting, so this says exactly what it does and nothing more.
        label: 'Stop background runs',
        enabled: Boolean(schedule.config?.enabled),
        click: () => setSchedule({ enabled: false }),
      },
      {
        label: 'Open at login',
        type: 'checkbox',
        checked: app.getLoginItemSettings().openAtLogin,
        click: (item) =>
          // openAsHidden starts it straight into the menu bar, which is the
          // only sane way for something that runs on a schedule to launch.
          app.setLoginItemSettings({ openAtLogin: item.checked, openAsHidden: true }),
      },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
}

/** Patch the schedule config on the server (the tray's checkbox path). */
function setSchedule(patch) {
  const body = JSON.stringify({ ...schedule.config, ...patch });
  const req = http.request(
    {
      host: 'localhost',
      port: PORT,
      path: '/api/schedule',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    },
    (res) => res.resume(), // the server broadcasts the new state back over SSE
  );
  req.on('error', () => {});
  req.end(body);
}

/** True if something is already serving on our port. */
function portInUse() {
  return new Promise((resolve) => {
    const req = http.get(URL, (res) => {
      res.resume();
      resolve(true);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(1500, () => {
      req.destroy();
      resolve(false);
    });
  });
}

app.whenReady().then(async () => {
  seedUserFiles();

  // Reuse an already-running server rather than spawning a second one that
  // would die on EADDRINUSE while we unknowingly talk to the stale copy.
  if (await portInUse()) {
    console.log(`Reusing the server already running on ${URL}`);
  } else {
    startServer();
  }
  try {
    await waitForServer();
  } catch (e) {
    dialog.showErrorBox('Could not start', `${e.message}\nCheck that port ${PORT} is free.`);
    app.quit();
    return;
  }

  buildTray();
  subscribeToEvents();
  report(`Data: ${DATA_DIR}`);

  // Launched by a login item with openAsHidden: stay in the menu bar rather
  // than throwing a window at someone who just turned their machine on.
  if (!app.getLoginItemSettings().wasOpenedAsHidden) {
    createWindow();
  } else if (process.platform === 'darwin') {
    app.dock?.hide();
  }

  /**
   * Timers do not fire while the machine is asleep, and on wake they arrive in
   * an unpredictable clump. Rather than trust that, tell the server to
   * re-evaluate the schedule against the current wall clock the moment we're
   * conscious again.
   */
  powerMonitor.on('resume', () => post('/api/schedule/refresh'));

  // macOS: clicking the dock icon with no windows open should reopen one.
  app.on('activate', () => showWindow());
});

app.on('window-all-closed', () => {
  // Running in the background means the app lives in the menu bar and the tray
  // is the way back, so closing the last window is not a reason to quit.
  if (!backgroundOn()) app.quit();
});

// Make sure the server child never outlives the app.
const stopServer = () => {
  if (server && !server.killed) server.kill();
  server = null;
};
app.on('before-quit', () => {
  quitting = true;
  if (blockerId !== null) {
    powerSaveBlocker.stop(blockerId);
    blockerId = null;
  }
  stopServer();
});
process.on('exit', stopServer);
