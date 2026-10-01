#!/usr/bin/env node
// verify:changed: typecheck, lint and test only the packages changed since $VERIFY_BASE
// (default origin/main), plus the packages that depend on them.
//
// The changed list is built here from git, not with pnpm's `...[ref]` filter: that filter reads
// `git diff`, which never reports untracked files, so a brand new file could skip verification.
//
// Falls back to the full `pnpm verify` whenever scoping can't be trusted: the base ref is missing,
// or a root config file changed (it affects every package).
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const base = process.env.VERIFY_BASE || 'origin/main';
const STEPS = ['typecheck', 'lint', 'test'];
const ROOT_CONFIG = [
  /^package\.json$/,
  /^pnpm-lock\.yaml$/,
  /^pnpm-workspace\.yaml$/,
  /^tsconfig(\.base)?\.json$/,
  /^biome\.jsonc?$/,
  /^vitest\.config\.[cm]?[jt]s$/,
  // This script decides what gets checked, so a change to it can't be trusted to scope itself.
  /^scripts\/verify-changed\.mjs$/,
];

if (git(['rev-parse', '--verify', '--quiet', `${base}^{commit}`]) === null) {
  fullVerify(`base ref "${base}" does not exist`);
}

// --no-renames reports both sides of a move, so the package a file left is checked too.
const tracked = git(['diff', '--name-only', '--no-renames', base]);
const untracked = git(['ls-files', '--others', '--exclude-standard']);
if (tracked === null || untracked === null) fullVerify('git could not list the changed files');

const changed = [...new Set([...lines(tracked), ...lines(untracked)])];
if (changed.length === 0) {
  log(`nothing changed since ${base}.`);
  process.exit(0);
}

const rootConfig = changed.filter((file) => ROOT_CONFIG.some((pattern) => pattern.test(file)));
if (rootConfig.length > 0) fullVerify(`root config changed (${rootConfig.join(', ')})`);

const packages = workspacePackages();
const changedPackages = new Set();
const looseFiles = [];
for (const file of changed) {
  const owner = packages.find((pkg) => file.startsWith(`${pkg.dir}/`));
  if (owner) changedPackages.add(owner.name);
  else looseFiles.push(file);
}

let failed = false;

if (changedPackages.size > 0) {
  const filters = [...changedPackages].sort().flatMap((name) => ['--filter', `...${name}`]);
  log(`changed since ${base}: ${[...changedPackages].sort().join(', ')}`);
  log(`checking them and their dependents: ${selected(filters).join(', ')}`);
  // Every step runs even after a failure, so one pass reports everything that is broken.
  for (const step of STEPS) {
    if (!run('pnpm', [...filters, 'run', '--if-present', step])) failed = true;
  }
} else {
  log(`no workspace package changed since ${base}.`);
}

// Files outside every package (scripts, CI, docs) have no typecheck or tests; lint what Biome knows.
const lintable = looseFiles.filter((file) => existsSync(join(root, file)));
if (lintable.length > 0) {
  log(`linting ${lintable.length} changed file(s) outside the workspace packages`);
  const args = ['exec', 'biome', 'check', '--no-errors-on-unmatched', '--files-ignore-unknown=true', ...lintable];
  if (!run('pnpm', args)) failed = true;
}

process.exit(failed ? 1 : 0);

function fullVerify(reason) {
  log(`${reason}; running the full verify.`);
  process.exit(run('pnpm', ['verify']) ? 0 : 1);
}

// Longest directory first, so a file in a nested package maps to the innermost one.
function workspacePackages() {
  const result = spawnSync('pnpm', ['-r', 'ls', '--depth', '-1', '--json'], { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) fullVerify('pnpm could not list the workspace packages');
  return JSON.parse(result.stdout)
    .map((pkg) => ({ name: pkg.name, dir: relative(root, pkg.path).split(sep).join('/') }))
    .filter((pkg) => pkg.dir !== '')
    .sort((a, b) => b.dir.length - a.dir.length);
}

function selected(filters) {
  const result = spawnSync('pnpm', [...filters, 'ls', '--depth', '-1', '--json'], { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) return ['(could not resolve the selection)'];
  return JSON.parse(result.stdout)
    .map((pkg) => pkg.name)
    .sort();
}

function run(command, args) {
  return spawnSync(command, args, { cwd: root, stdio: 'inherit' }).status === 0;
}

// null means git failed, which is different from "no output".
function git(args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return result.status === 0 ? result.stdout : null;
}

function lines(text) {
  return text.split('\n').filter(Boolean);
}

function log(message) {
  console.log(`verify:changed: ${message}`);
}
