#!/usr/bin/env node
// PreToolUse guard. Hooks run before permission checks and in every permission mode,
// so these rules hold even when an agent runs with prompts turned off.
// Exit 2 blocks the tool call and shows the reason to Claude. Internal errors allow the call.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';

const input = readInput();
const root = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
const tool = input.tool_name;
const args = input.tool_input ?? {};

const HARNESS = [/^\.claude\/settings\.json$/, /^\.claude\/hooks\//, /^\.conductor\//, /^scripts\/conductor\//];
const PROTECTED_DATA = [/(^|\/)__golden__\//, /^eval\/holdout\//];

const COMMAND_RULES = [
  [/\bcdk\s+(deploy|destroy|bootstrap)\b/, 'cdk deploy, destroy and bootstrap are human-only. Run `pnpm synth` to prove infra compiles.'],
  [/\b(pnpm|npm|yarn)\s+(run\s+)?deploy\b/, 'Deploy scripts are human-only.'],
  [
    /\baws\s+[\w-]+\s+(create|delete|put|update|terminate|run|start|stop|modify|remove|attach|detach|deregister|register|tag|untag|invoke|publish|send|set|reboot|restore|revoke|authorize|enable|disable|import|execute|cancel|deploy)/,
    'Mutating AWS CLI calls are human-only. Read-only describe, get and list calls are fine.',
  ],
  [/\baws\s+s3\s+(cp|mv|rm|sync|mb|rb)\b/, 'Writing to S3 is human-only.'],
  [/\bgh\s+pr\s+merge\b/, "Merging is the human's call."],
  [/\bgh\s+(repo\s+(delete|edit|rename|archive)|secret\s+(set|delete|remove))\b/, 'Repository settings and secrets are human-only.'],
  [/\.context\/allow-/, 'Only the human creates .context/allow-* override files.'],
];

// `git push`, also with global options before it (`git -C dir push`, `git -c key=value push`).
// Group 1 is everything after `push` within that one command.
const GIT_PUSH = /\bgit(?:\s+(?:-[cC]\s+\S+|--[\w-]+(?:=\S+)?))*\s+push\b(.*)/;

// Checked against the arguments of one `git push`. `--force-with-lease` (with `--force-if-includes`)
// stays allowed on purpose: after a rebase it is how a lane updates its own branch, and it refuses
// to overwrite commits this clone has not seen. The main-branch rules below still apply to it.
const PUSH_RULES = [
  [
    /\s--force(?![\w-])|\s-[a-zA-Z]*f[a-zA-Z]*(?![\w-])|\s\+\S/,
    'Plain force pushes are not allowed. After a rebase, push with `git push --force-with-lease --force-if-includes origin HEAD`.',
  ],
  [
    /\s--(mirror|all|delete|prune)(?![\w-])|\s-[a-zA-Z]*d[a-zA-Z]*(?![\w-])|\s:\S/,
    'Push only your own branch. Deleting or mirroring remote branches is human-only.',
  ],
  [/[\s:](refs\/heads\/)?(main|master)(?![\w./-])/, 'Never push to main. Push your branch and open a PR.'],
];

try {
  if (tool === 'Bash') checkCommand(String(args.command ?? ''));
  else if (tool === 'Read') checkRead(String(args.file_path ?? ''));
  else if (tool === 'Edit' || tool === 'Write' || tool === 'NotebookEdit') {
    checkWrite(String(args.file_path ?? args.notebook_path ?? ''));
  }
} catch (err) {
  process.stderr.write(`guard.mjs failed open: ${err?.message ?? err}\n`);
}
process.exit(0);

function checkCommand(raw) {
  const cmd = normalize(raw);
  for (const [pattern, why] of COMMAND_RULES) {
    if (pattern.test(cmd)) block(why);
  }
  // One command at a time, so a flag of a later command (`&& gh pr create -f`) is never read as a push flag.
  for (const part of raw.split(/\n|&&|\|\||[;&|]/)) {
    const push = GIT_PUSH.exec(normalize(part));
    if (!push) continue;
    for (const [pattern, why] of PUSH_RULES) {
      if (pattern.test(push[1])) block(why);
    }
    if (['main', 'master'].includes(currentBranch())) {
      block('You are on main. Create a branch for your work; never push main.');
    }
  }
  for (const token of cmd.split(/[\s'"`=<>|;&()]+/)) {
    if (token && !token.startsWith('-') && isSecretPath(token)) block(`The command touches a secret file (${token}).`);
  }
}

function normalize(command) {
  return command.replace(/\s+/g, ' ').replace(/\s--(profile|region|output|endpoint-url)(=|\s)\S+/g, '');
}

function checkRead(path) {
  if (isSecretPath(path)) block(`${path} holds secrets. Ask the human for the value you need.`);
}

function checkWrite(path) {
  const rel = toRepoPath(path);
  if (isSecretPath(path)) block(`${rel} holds secrets. Ask the human to change it.`);
  if (/^\.context\/allow-/.test(rel)) block('Only the human creates .context/allow-* override files.');
  if (/(^|\/)pnpm-lock\.yaml$/.test(rel)) block('Never hand-edit pnpm-lock.yaml. Change package.json and run pnpm install.');
  if (HARNESS.some((re) => re.test(rel)) && !overrideExists('harness')) {
    block(`${rel} is part of the agent harness. Propose the change in your reply instead.`);
  }
  if (PROTECTED_DATA.some((re) => re.test(rel)) && !overrideExists('golden')) {
    block(`${rel} is protected test data (goldens or eval holdout). Fix the code, not the expected output.`);
  }
}

function isSecretPath(path) {
  const normalized = path.replace(/\\/g, '/');
  const name = normalized.split('/').pop() ?? '';
  if (name === '.env.example' || name === '.env.workspace') return false;
  if (name === '.env' || name.startsWith('.env.')) return true;
  if (name.endsWith('.pem')) return true;
  return /(^|\/)\.(aws|ssh)(\/|$)/.test(normalized);
}

function toRepoPath(path) {
  if (!isAbsolute(path)) return path.replace(/^\.\//, '');
  const rel = relative(root, path);
  return rel.startsWith('..') ? path : rel;
}

function overrideExists(name) {
  return existsSync(join(root, '.context', `allow-${name}`));
}

function currentBranch() {
  try {
    return execFileSync('git', ['branch', '--show-current'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

function block(why) {
  process.stderr.write(`Blocked by .claude/hooks/guard.mjs: ${why}\n`);
  process.exit(2);
}

function readInput() {
  try {
    return JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    return {};
  }
}
