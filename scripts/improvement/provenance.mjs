// Read-only, dependency-free evidence capture. Never serializes credentials or process.env.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

export const repoRoot = resolve(fileURLToPath(new URL('../../', import.meta.url)));
export const hash = value => createHash('sha256').update(value).digest('hex');
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function sources(root, dir) {
  return readdirSync(join(root, dir), { withFileTypes: true }).flatMap(entry => {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return sources(root, path);
    return entry.isFile() && /\.(ts|mjs)$/.test(entry.name) ? [path] : [];
  });
}

export function captureProvenance(configuration, { root = repoRoot } = {}) {
  const paths = [
    ...sources(root, 'apps/steward/src'),
    ...sources(root, 'apps/steward/eval').filter(path => !path.includes('/results/')),
    ...sources(root, 'packages/protocol/src'),
    ...sources(root, 'scripts/improvement'),
    'package.json', 'apps/steward/package.json', 'packages/protocol/package.json', 'pnpm-lock.yaml',
  ].sort();
  // Textual input identity, independent of Windows checkout line endings. Not a byte hash.
  const files = Object.fromEntries(paths.map(path => [path, hash(readFileSync(join(root, path), 'utf8').replace(/\r\n/g, '\n'))]));
  const git = args => {
    try { return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
    catch { return null; }
  };
  const status = git(['status', '--porcelain', '--untracked-files=normal']);
  const sourceHash = hash(canonical(files));
  const runtime = { node: process.version, platform: process.platform, arch: process.arch };
  return {
    version: 1, normalization: 'utf8-lf',
    git: { commit: git(['rev-parse', 'HEAD']), dirty: status === null ? null : status.length > 0 },
    files, sourceHash, runtime, configuration,
    fingerprint: hash(canonical({ sourceHash, runtime, configuration })),
  };
}

// Intentionally no CLI taking arbitrary config: callers must explicitly select safe fields.
