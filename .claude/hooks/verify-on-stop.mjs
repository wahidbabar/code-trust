#!/usr/bin/env node
// Stop hook: Claude can't finish while the packages it changed fail `pnpm verify:changed`,
// or while protected test data is modified.
// Bounded on purpose: checks never re-run on an unchanged tree, and after MAX_RETRIES forced
// continuations in a row the hook lets Claude stop and flags it for the human.
// Exit 0 = stop allowed. Exit 2 = keep working (reason goes to Claude). Exit 1 = stop, with a visible note.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const MAX_RETRIES = 3;
const TIMEOUT_MS = 280_000;
const CODE_FILE = /\.(ts|tsx|mts|cts|js|mjs|cjs|jsx|json|ya?ml|sql)$/;
const PROTECTED_DATA = [/(^|\/)__golden__\//, /^eval\/holdout\//];

const input = readInput();
const root = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
const stateFile = join(root, '.claude', '.cache', 'verify-state.json');
const state = loadState();
const retriesSoFar = state.session === input.session_id ? (state.blocks ?? 0) : 0;

try {
  main();
} catch (err) {
  note(`verify-on-stop.mjs crashed, so nothing was verified: ${err?.message ?? err}`);
}
allowStop();

function main() {
  if (input.permission_mode === 'plan') return;

  const base = git(['merge-base', 'HEAD', 'origin/main']) || git(['rev-parse', '--verify', '-q', 'HEAD']);
  if (!base) return;

  const untracked = lines(git(['ls-files', '--others', '--exclude-standard']));
  const changed = [...new Set([...lines(git(['diff', '--name-only', base])), ...untracked])];

  const touchedProtected = changed.filter((file) => PROTECTED_DATA.some((re) => re.test(file)));
  if (touchedProtected.length > 0 && !existsSync(join(root, '.context', 'allow-golden'))) {
    retryOrHandBack(
      `Protected test data changed: ${touchedProtected.join(', ')}. Restore these files with git restore; fix the code, not the expected output. Only the human can allow this (.context/allow-golden).`,
    );
  }

  const codeFiles = changed.filter((file) => CODE_FILE.test(file));
  if (codeFiles.length === 0) return;

  const script = pickScript();
  if (!script) return;
  if (!existsSync(join(root, 'node_modules'))) {
    note('Skipped verification: dependencies are not installed in this workspace. Run pnpm install.');
  }

  const fingerprint = fingerprintOf(base, codeFiles);
  if (state.passed === fingerprint) return;
  if (state.failed === fingerprint) {
    retryOrHandBack(
      `pnpm ${script} failed on this exact tree and nothing has changed since. Fix it, or say what blocks you.`,
      { failed: fingerprint },
    );
  }

  const run = spawnSync('pnpm', ['-s', script], {
    cwd: root,
    encoding: 'utf8',
    timeout: TIMEOUT_MS,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (run.status === 0) {
    saveState({ session: input.session_id, blocks: 0, passed: fingerprint, failed: null });
    return;
  }

  const outcome = run.error?.code === 'ETIMEDOUT' ? `timed out after ${TIMEOUT_MS / 1000}s` : `exited with ${run.status}`;
  retryOrHandBack(
    [
      `pnpm ${script} ${outcome}. Fix the root cause; don't skip, delete or weaken tests.`,
      '',
      tail(`${run.stdout ?? ''}\n${run.stderr ?? ''}`, 60),
    ].join('\n'),
    { failed: fingerprint },
  );
}

function retryOrHandBack(reason, extra = {}) {
  const blocks = retriesSoFar + 1;
  if (blocks > MAX_RETRIES) {
    saveState({ ...state, ...extra, session: input.session_id, blocks: 0 });
    note(`${reason}\n\nStopping after ${MAX_RETRIES} automatic retries so the human can take a look.`);
  }
  saveState({ ...state, ...extra, session: input.session_id, blocks });
  process.stderr.write(`${reason}\n\nAutomatic retry ${blocks} of ${MAX_RETRIES}.\n`);
  process.exit(2);
}

function allowStop() {
  if (retriesSoFar > 0) saveState({ ...state, session: input.session_id, blocks: 0 });
  process.exit(0);
}

function note(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function pickScript() {
  try {
    const scripts = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts ?? {};
    if (scripts['verify:changed']) return 'verify:changed';
    if (scripts.verify) return 'verify';
  } catch {}
  return null;
}

// Content of the changed code files, so committing a verified tree doesn't trigger a re-run.
function fingerprintOf(base, codeFiles) {
  const hash = createHash('sha1');
  hash.update(base);
  for (const file of [...codeFiles].sort()) {
    hash.update(`\0${file}\0`);
    try {
      hash.update(readFileSync(join(root, file)));
    } catch {
      hash.update('<deleted>');
    }
  }
  return hash.digest('hex');
}

function loadState() {
  try {
    return JSON.parse(readFileSync(stateFile, 'utf8'));
  } catch {
    return {};
  }
}

function saveState(next) {
  try {
    mkdirSync(join(root, '.claude', '.cache'), { recursive: true });
    writeFileSync(stateFile, JSON.stringify(next));
  } catch {}
}

function git(args) {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024,
    }).trim();
  } catch {
    return '';
  }
}

function lines(text) {
  return text ? text.split('\n').filter(Boolean) : [];
}

function tail(text, count) {
  return text.trim().split('\n').slice(-count).join('\n');
}

function readInput() {
  try {
    return JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    return {};
  }
}
