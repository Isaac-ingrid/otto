import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

export const root = fileURLToPath(new URL('../../', import.meta.url));
export const cache = resolve(root, '.cache/verification');
export const pins = JSON.parse(readFileSync(new URL('./toolchain.json', import.meta.url), 'utf8'));
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export function javaEnv() {
  const env = { ...process.env };
  // Do not let ambient Java flags change the check or leak their values into logs.
  for (const name of ['JAVA_TOOL_OPTIONS', '_JAVA_OPTIONS', 'JDK_JAVA_OPTIONS']) delete env[name];
  return env;
}
export function toolchain() {
  const portable = resolve(cache, 'java', pins.windowsJre.directory, 'bin/java.exe');
  const java = process.env.OTTO_JAVA || (process.env.JAVA_HOME
    ? resolve(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java')
    : process.platform === 'win32' && existsSync(portable) ? portable : 'java');
  const version = spawnSync(java, ['-version'], { encoding: 'utf8', env: javaEnv(), timeout: 10_000 });
  const javaVersion = `${version.stdout ?? ''}${version.stderr ?? ''}`.trim();
  if (version.error || version.status !== 0 || Number(/version "(\d+)/.exec(javaVersion)?.[1]) < 17 || !/version "\d+/.test(javaVersion)) {
    throw new Error('Java 17+ is required. Set OTTO_JAVA/JAVA_HOME or run setup-tla.mjs --java on Windows x64.');
  }
  const jar = resolve(cache, pins.tla.filename);
  if (!existsSync(jar)) throw new Error('TLC is missing: run node scripts/verification/setup-tla.mjs');
  if (sha256(readFileSync(jar)) !== pins.tla.sha256) throw new Error('TLC checksum mismatch; do not run this JAR.');
  return { java, javaVersion, jar, jarSha256: pins.tla.sha256 };
}
