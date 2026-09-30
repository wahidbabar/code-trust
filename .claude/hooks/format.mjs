#!/usr/bin/env node
// PostToolUse: format the file Claude just wrote with Biome, once Biome is installed. Never blocks.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

try {
  const input = JSON.parse(readFileSync(0, 'utf8'));
  const root = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
  const file = input.tool_input?.file_path;
  const biome = join(root, 'node_modules', '.bin', 'biome');
  if (file && /\.(ts|tsx|mts|cts|js|mjs|cjs|jsx|json|jsonc|css)$/.test(file) && existsSync(biome) && existsSync(file)) {
    spawnSync(biome, ['format', '--write', file], { cwd: root, stdio: 'ignore', timeout: 20_000 });
  }
} catch {}
process.exit(0);
