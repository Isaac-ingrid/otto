// Explicit setup only: checks/downloads public pinned tools, never installs globally.
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { cache, pins, sha256 } from './toolchain.mjs';

const args = process.argv.slice(2);
if (args.some(arg => arg !== '--java') || new Set(args).size !== args.length) throw new Error('Usage: node scripts/verification/setup-tla.mjs [--java]');
if (args.includes('--java') && (process.platform !== 'win32' || process.arch !== 'x64')) throw new Error('--java supports Windows x64 only; supply Java 17+ via OTTO_JAVA/JAVA_HOME elsewhere.');
await mkdir(cache, { recursive: true });
async function download(pin, filename, maxBytes) {
  try {
    if (sha256(await readFile(filename)) === pin.sha256) { console.log(`Verified cached ${filename}`); return; }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const response = await fetch(pin.url, { signal: AbortSignal.timeout(240_000) });
  if (!response.ok || !response.body) throw new Error(`Tool download failed: HTTP ${response.status}`);
  const parts = []; let size = 0;
  for await (const part of response.body) {
    size += part.byteLength;
    if (size > maxBytes) throw new Error('Tool download exceeds expected size limit');
    parts.push(part);
  }
  const bytes = Buffer.concat(parts);
  if (sha256(bytes) !== pin.sha256) throw new Error('Tool download checksum mismatch; refusing installation');
  const partial = `${filename}.${process.pid}.partial`;
  try { await writeFile(partial, bytes); await rename(partial, filename); }
  finally { await rm(partial, { force: true }); }
  console.log(`Downloaded and verified ${filename}`);
}
await download(pins.tla, resolve(cache, pins.tla.filename), 16 * 1024 * 1024);
if (args.includes('--java')) {
  const zip = resolve(cache, 'temurin17-jre.zip');
  await download(pins.windowsJre, zip, 64 * 1024 * 1024);
  const quote = value => `'${value.replaceAll("'", "''")}'`;
  const unpack = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `Expand-Archive -LiteralPath ${quote(zip)} -DestinationPath ${quote(resolve(cache, 'java'))} -Force`], { stdio: 'inherit' });
  if (unpack.error || unpack.status !== 0) throw new Error('Portable JRE extraction failed');
}
console.log('Setup complete; run node scripts/verification/verify-otto.mjs doctor');
