/**
 * Ad-hoc sign the development Electron binary, so notifications work.
 *
 * Electron 42 moved macOS notifications to Apple's UNNotification API, which
 * refuses to display anything from an unsigned bundle — the Notification object
 * just emits `failed` and nothing appears. The Electron that npm installs is
 * unsigned, so without this a scheduled run completes and tells you nothing.
 *
 * Ad-hoc signing ("-") needs no Apple Developer account and no network. It is
 * wiped every time npm reinstalls the package, which is why this runs from
 * postinstall rather than being a one-off command in the README.
 *
 * Not needed on Windows or Linux, and never fatal: a failure here should leave
 * you with a working app that happens to be quiet, not a failed install.
 */
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

if (process.platform !== 'darwin') process.exit(0);

const APP = path.join(__dirname, '..', 'node_modules', 'electron', 'dist', 'Electron.app');

if (!fs.existsSync(APP)) {
  console.log('[sign-dev] Electron not installed yet — skipping.');
  process.exit(0);
}

try {
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', APP], { stdio: 'pipe' });
  console.log('[sign-dev] Ad-hoc signed Electron.app — desktop notifications will work.');
} catch (err) {
  console.warn('[sign-dev] Could not sign Electron.app; notifications will not appear.');
  console.warn(`[sign-dev] Run it yourself:  codesign --force --deep --sign - "${APP}"`);
  console.warn(`[sign-dev] (${String(err.stderr ?? err.message).trim()})`);
}
