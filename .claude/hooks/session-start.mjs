#!/usr/bin/env node
// SessionStart: readies a worktree that Conductor did not set up, such as a worktree session in the
// Claude desktop app. It runs scripts/conductor/setup.sh when node_modules or .env.workspace is
// missing, and gives the session its own block of ten ports as $CONDUCTOR_PORT, which Conductor
// would otherwise set. In a Conductor workspace both already exist, so it only reports them.
// Whatever it prints becomes context for Claude. It never blocks the session.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

// 700 blocks of ten, from 42000 to 48999: away from Conductor's ports and common dev defaults.
const FIRST_PORT = 42_000;
const BLOCKS = 700;
const SETUP_TIMEOUT_MS = 280_000;

const input = readInput();
const root = repoRoot(input.cwd) || process.env.CLAUDE_PROJECT_DIR || process.cwd();
const lines = [];

try {
  if (!existsSync(join(root, 'node_modules')) || !existsSync(join(root, '.env.workspace'))) {
    const run = spawnSync('bash', ['scripts/conductor/setup.sh'], {
      cwd: root,
      encoding: 'utf8',
      timeout: SETUP_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
    });
    lines.push(
      run.status === 0
        ? 'Workspace setup ran (scripts/conductor/setup.sh).'
        : `Workspace setup did not finish (${run.error?.code ?? `exit ${run.status}`}). Run bash scripts/conductor/setup.sh and read its output.`,
    );
    if (!existsSync(join(root, '.env.workspace'))) {
      lines.push('No workspace database: start OrbStack, then run bash scripts/conductor/setup.sh.');
    }
  }

  let port = Number(process.env.CONDUCTOR_PORT);
  if (!Number.isInteger(port) || port <= 0) {
    port = portFor(basename(root));
    if (process.env.CLAUDE_ENV_FILE) appendFileSync(process.env.CLAUDE_ENV_FILE, `export CONDUCTOR_PORT=${port}\n`);
  }
  lines.push(`Dev servers in this worktree use $CONDUCTOR_PORT=${port} through ${port + 9}.`);

  const database = workspaceDatabase();
  if (database) lines.push(`Workspace database: ${database} (DATABASE_URL in .env.workspace).`);
} catch (err) {
  lines.push(`session-start.mjs failed, so the worktree may not be set up: ${err?.message ?? err}`);
}

process.stdout.write(`${lines.join('\n')}\n`);
process.exit(0);

// The same folder name always gets the same block, so a resumed session keeps its ports.
function portFor(name) {
  const hash = Number.parseInt(createHash('sha256').update(name).digest('hex').slice(0, 8), 16);
  return FIRST_PORT + (hash % BLOCKS) * 10;
}

function workspaceDatabase() {
  try {
    const env = readFileSync(join(root, '.env.workspace'), 'utf8');
    return /^DATABASE_URL=postgres:\/\/[^/]*\/(ct_[a-z0-9_]+)$/m.exec(env)?.[1] ?? '';
  } catch {
    return '';
  }
}

// The checkout this session works in. A session that runs in a worktree can have
// CLAUDE_PROJECT_DIR naming the main checkout, so the git top level of the hook's cwd comes first.
function repoRoot(cwd) {
  if (!cwd) return '';
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

function readInput() {
  try {
    return JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    return {};
  }
}
