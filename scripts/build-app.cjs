/**
 * Build "Upwork Agent.app".
 *
 * This assembles the bundle by hand rather than using electron-builder, which
 * is a deliberate choice and not laziness: electron-builder's output died at
 * launch on this machine inside Electron's own startup, before any JavaScript
 * ran, with
 *
 *   ERROR:electron/shell/common/mac/codesign_util.cc] task_name_for_pid: (os/kern) failure (5)
 *
 * That was reproducible across asar on/off, with and without entitlements, and
 * with the signature replaced by hand — so it was not something the config
 * could reach. Copying Electron.app and re-pointing it works, and is what the
 * `electron .` you already run does anyway. Fewer moving parts, and every step
 * here is one you could do from a terminal.
 *
 * What the bundle needs to differ from a stock Electron:
 *   - its own CFBundleIdentifier, because macOS grants notification permission
 *     per bundle id. Sharing com.github.Electron with every other Electron dev
 *     app is exactly why notifications were accepted and never displayed.
 *   - its own name and icon, so banners and the Dock say "Upwork Agent".
 *   - our code in Contents/Resources/app, replacing Electron's default app.
 *   - an ad-hoc signature, because Electron 42+ uses Apple's UNNotification API
 *     and macOS will not display notifications from an unsigned bundle.
 *
 *   npm run pack          build into dist/
 *   npm run install-app   copy it to /Applications
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const APP_NAME = 'Upwork Agent';
const BUNDLE_ID = 'com.enlightenedinsights.upwork-agent';

const ELECTRON_APP = path.join(ROOT, 'node_modules', 'electron', 'dist', 'Electron.app');
const OUT_DIR = path.join(ROOT, 'dist');
const OUT = path.join(OUT_DIR, `${APP_NAME}.app`);
const CONTENTS = path.join(OUT, 'Contents');
const RES = path.join(CONTENTS, 'Resources');
const APP_DIR = path.join(RES, 'app');

/**
 * Everything the app needs at runtime.
 *
 * Deliberately not `data/` (runtime state, lives in Application Support) and
 * deliberately not `.env` — API keys are per-machine and are set in the app's
 * Judge tab, so baking one into a bundle you might hand to someone else would
 * hand them your key too.
 */
const SOURCES = ['electron', 'src', 'profile', 'package.json'];
const RUNTIME_MODULES = ['playwright', 'playwright-core'];

const plist = (...args) => execFileSync('/usr/libexec/PlistBuddy', args).toString().trim();

function step(msg) {
  process.stdout.write(`  ${msg}\n`);
}

if (!fs.existsSync(ELECTRON_APP)) {
  console.error('Electron is not installed — run `npm install` first.');
  process.exit(1);
}

step('copying Electron.app…');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT_DIR, { recursive: true });
// ditto rather than cp: it preserves the framework symlinks and resource forks
// a .app depends on, which a naive recursive copy quietly flattens.
execFileSync('ditto', [ELECTRON_APP, OUT]);

step('re-pointing the bundle identity…');
const INFO = path.join(CONTENTS, 'Info.plist');
const set = (key, value) => {
  try {
    plist('-c', `Set :${key} ${value}`, INFO);
  } catch {
    plist('-c', `Add :${key} string ${value}`, INFO);
  }
};
set('CFBundleIdentifier', BUNDLE_ID);
set('CFBundleName', APP_NAME);
set('CFBundleDisplayName', APP_NAME);
set('CFBundleIconFile', 'icon.icns');
/**
 * Persistent alerts rather than transient banners.
 *
 * A banner draws for about five seconds and then disappears for good. For an
 * app whose whole point is telling you about something that happened while you
 * were not looking, that is the wrong default — miss the five seconds and the
 * notification may as well not have fired. "alert" keeps it on screen until you
 * dismiss or click it.
 */
set('NSUserNotificationAlertStyle', 'alert');
// Stock Electron advertises itself as a file/URL handler for things we are not.
try {
  plist('-c', 'Delete :CFBundleDocumentTypes', INFO);
} catch {
  /* already absent */
}
try {
  plist('-c', 'Delete :CFBundleURLTypes', INFO);
} catch {
  /* already absent */
}

/**
 * Rename the executable to the product name.
 *
 * Not cosmetic: Electron decides `app.isPackaged` by checking whether the
 * running executable is still called "electron". Leave it and a real installed
 * app believes it is a dev checkout, and writes your job history *inside* the
 * signed bundle instead of Application Support.
 */
step('renaming the executable…');
const MACOS = path.join(CONTENTS, 'MacOS');
fs.renameSync(path.join(MACOS, 'Electron'), path.join(MACOS, APP_NAME));
set('CFBundleExecutable', APP_NAME);

step('installing the icon…');
fs.rmSync(path.join(RES, 'electron.icns'), { force: true });
fs.copyFileSync(path.join(ROOT, 'build', 'icon.icns'), path.join(RES, 'icon.icns'));

step('replacing the default app…');
fs.rmSync(path.join(RES, 'default_app.asar'), { force: true });
fs.mkdirSync(APP_DIR, { recursive: true });
for (const entry of SOURCES) {
  const from = path.join(ROOT, entry);
  if (!fs.existsSync(from)) {
    step(`  (skipping ${entry} — not present)`);
    continue;
  }
  fs.cpSync(from, path.join(APP_DIR, entry), {
    recursive: true,
    // Editor backups of your portfolio have no business shipping.
    filter: (src) => !src.endsWith('.bak'),
  });
}

step('adding runtime dependencies…');
for (const mod of RUNTIME_MODULES) {
  const from = path.join(ROOT, 'node_modules', mod);
  if (!fs.existsSync(from)) throw new Error(`missing dependency: ${mod} (run npm install)`);
  fs.cpSync(from, path.join(APP_DIR, 'node_modules', mod), { recursive: true });
}

/**
 * Bundle the browser.
 *
 * Playwright keeps Chrome for Testing in ~/Library/Caches/ms-playwright, which
 * exists only after `npx playwright install chromium` — i.e. only on a machine
 * that already has Node and this repo. Copying it in is what makes the .app
 * something you can hand to someone: they double-click it and it works, with no
 * toolchain at all. Costs ~365MB, which is the whole point of paying it once
 * here instead of asking every user to.
 */
step('bundling the browser…');
const browsersSrc = path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright');
const chromiumDir = fs.existsSync(browsersSrc)
  ? fs.readdirSync(browsersSrc).find((d) => d.startsWith('chromium-'))
  : null;

if (chromiumDir) {
  const dest = path.join(RES, 'browsers');
  fs.mkdirSync(dest, { recursive: true });
  execFileSync('ditto', [path.join(browsersSrc, chromiumDir), path.join(dest, chromiumDir)]);
  step(`  included ${chromiumDir}`);
} else {
  step('  ⚠️  no Chrome for Testing found — run `npx playwright install chromium` first.');
  step('     The app will build, but will not be able to fetch on a machine without it.');
}

step('signing (ad-hoc)…');
// --deep is deprecated for distribution but is exactly right here: it signs the
// nested helpers and frameworks with the same ad-hoc identity in one pass, which
// is what a local, un-notarised build needs.
execFileSync('codesign', ['--force', '--deep', '--sign', '-', OUT], { stdio: 'pipe' });
execFileSync('codesign', ['--verify', '--strict', OUT], { stdio: 'pipe' });

const size = execFileSync('du', ['-sh', OUT]).toString().split('\t')[0];
console.log(`\nBuilt ${OUT} (${size})`);
console.log(`  bundle id: ${plist('-c', 'Print :CFBundleIdentifier', INFO)}`);
console.log('\nInstall it with:  npm run install-app\n');
