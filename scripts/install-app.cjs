/**
 * Copy the built app into /Applications.
 *
 * Not cosmetic: macOS only treats a bundle as a real installed app when it is
 * in a normal Applications location, and notification permission is granted per
 * bundle id to apps it recognises. Running the same .app out of dist/ or a temp
 * folder is what left notifications silently undelivered.
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'dist', 'Upwork Agent.app');
const DEST = '/Applications/Upwork Agent.app';

if (!fs.existsSync(SRC)) {
  console.error(`Nothing built yet — run \`npm run pack\` first.\n  looked in: ${SRC}`);
  process.exit(1);
}

// A running copy cannot be replaced cleanly.
try {
  execFileSync('pkill', ['-f', 'Upwork Agent.app/Contents/MacOS'], { stdio: 'ignore' });
} catch {
  /* wasn't running */
}

fs.rmSync(DEST, { recursive: true, force: true });
fs.cpSync(SRC, DEST, { recursive: true, verbatimSymlinks: true });

// Tell LaunchServices about it, so it shows up correctly straight away.
try {
  execFileSync(
    '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister',
    ['-f', DEST],
    { stdio: 'ignore' },
  );
} catch {
  /* non-fatal — macOS notices eventually */
}

console.log(`Installed to ${DEST}`);
console.log('\nOpen it, then press "Send a test notification" on the Schedule tab.');
console.log('macOS should ask whether to allow notifications — say yes.\n');
