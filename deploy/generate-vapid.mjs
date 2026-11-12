#!/usr/bin/env node
// Writes a new Web Push signing keypair to an explicitly named private file; never prints it.
import { createECDH } from 'node:crypto';
import { open, realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const [file, subject] = process.argv.slice(2);
if (process.platform === 'win32') {
  console.error('Generate keys on the Linux server: Windows does not honor mode 0600 for new files.');
  process.exit(2);
}
if (!file || !subject || !/^(https:\/\/[^\s]+|mailto:[^\s@]+@[^\s@]+)$/.test(subject)) {
  console.error('usage: node deploy/generate-vapid.mjs <private-output-file> <https://origin-or-mailto:email>');
  process.exit(2);
}
const output = resolve(file);
const repo = resolve(import.meta.dirname, '..');
const parent = await realpath(dirname(output));
if (parent === repo || parent.startsWith(`${repo}/`) || parent.startsWith(`${repo}\\`)) {
  console.error('Refusing to write keys inside the repository. Choose a private location.');
  process.exit(2);
}
const ecdh = createECDH('prime256v1');
ecdh.generateKeys();
const scalar = ecdh.getPrivateKey();
const privateKey = Buffer.concat([Buffer.alloc(32 - scalar.length), scalar]).toString('base64url');
const content = `VAPID_PUBLIC_KEY=${ecdh.getPublicKey(undefined, 'uncompressed').toString('base64url')}\n` +
  `VAPID_PRIVATE_KEY=${privateKey}\nVAPID_SUBJECT=${subject}\n`;
const handle = await open(output, 'wx', 0o600);
try { await handle.writeFile(content); } finally { await handle.close(); }
console.log(`Created private VAPID config: ${output} (keep the private key for disaster recovery)`);
