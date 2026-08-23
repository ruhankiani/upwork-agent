/**
 * Where things live.
 *
 * Until the app was packaged, every module resolved `data/` and `profile/`
 * relative to its own file — which is fine in a git checkout, where the code
 * and the data sit in one folder you own.
 *
 * Inside a packaged .app that stops being true. The code ends up in
 * /Applications/Upwork Agent.app/Contents/Resources/app, which is code-signed:
 * writing there invalidates the signature, may be refused outright, and is
 * wiped by the next update. Job history and your portfolio must outlive the
 * app bundle, so they belong in Application Support instead.
 *
 * The packaged shell passes these in as environment variables, which the server
 * and every script it spawns inherit. A dev checkout sets none of them and
 * falls back to the repo, so `npm run ui`, `node src/fetch.js` and the tests
 * keep reading and writing exactly where they always have.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The code's own folder. Correct for scripts and the UI file — never for data. */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Job archive, filters, schedule, Chrome's profile — everything we write. */
export const DATA_DIR = process.env.UPWORK_AGENT_DATA_DIR || path.join(ROOT, 'data');

/** Your portfolio, exclusions, keywords, rubric and preferences — yours to edit. */
export const PROFILE_DIR = process.env.UPWORK_AGENT_PROFILE_DIR || path.join(ROOT, 'profile');

/** Holds GEMINI_API_KEY. */
export const ENV_FILE = process.env.UPWORK_AGENT_ENV_FILE || path.join(ROOT, '.env');

export const dataFile = (...parts) => path.join(DATA_DIR, ...parts);
export const profileFile = (...parts) => path.join(PROFILE_DIR, ...parts);
