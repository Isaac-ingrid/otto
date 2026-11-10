// Rewrite files so a stale on-disk view can no longer make `tsc` call them binary.
//
// Symptom (Windows, this checkout): after git rewrites a file — `git checkout --`, `git stash pop`,
// a branch switch — the TypeScript 7 native binary can report
//     src/notes.ts(1,1): error TS1490: File appears to be binary.
// for a file that is plain UTF-8 with no NUL bytes, and that Node, git and PowerShell all read
// back byte-for-byte unchanged. The bytes are fine; the *file* is. Unlinking and re-creating the
// same bytes clears it, which is all this script does — deliberately by unlink + write rather than
// write-in-place, because overwriting in place is what leaves the stale state behind.
//
// Usage:
//   node scripts/refresh-stale-files.mjs <file> [<file>...]
//   node scripts/refresh-stale-files.mjs --from-tsc        # parse `pnpm -r typecheck` on stdin
//
// The content is never changed: each file is read, compared against git's object for it when git
// can supply one, and written back identically. Run `git diff --stat` afterwards; if it is empty
// for these paths, the rewrite was a no-op.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";

function repoRoot() {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  } catch {
    return process.cwd();
  }
}

/** Paths out of `tsc` output: `src/x.ts(1,1): error TS1490: ...` on stdin. */
function pathsFromTsc(text) {
  const found = new Set();
  for (const line of text.split(/\r?\n/)) {
    const match = /^(\S+?)\(\d+,\d+\): error TS1490\b/.exec(line.trim());
    if (match) found.add(match[1]);
  }
  return [...found];
}

/** Which package directory a reported path belongs to, so the file can be found from the root. */
function candidates(reportedPath, root) {
  if (reportedPath.startsWith("apps/") || reportedPath.startsWith("packages/")) {
    return [resolve(root, reportedPath)];
  }
  const matches = [];
  for (const pkg of ["apps/connector", "apps/steward", "apps/preview-machine", "packages/protocol"]) {
    const full = resolve(root, pkg, reportedPath);
    if (existsSync(full)) matches.push(full);
  }
  return matches;
}

const root = repoRoot();
const args = process.argv.slice(2);
let targets;
if (args.includes("--from-tsc")) {
  const stdin = readFileSync(0, "utf8");
  targets = pathsFromTsc(stdin).flatMap((p) => candidates(p, root));
  if (targets.length === 0) {
    console.error("refresh-stale-files: no TS1490 lines on stdin");
    process.exit(1);
  }
} else {
  targets = args.map((a) => resolve(root, a));
  if (targets.length === 0) {
    console.error("refresh-stale-files: pass file paths, or --from-tsc to read a typecheck log");
    process.exit(2);
  }
}

let rewritten = 0;
for (const file of targets) {
  const before = readFileSync(file);
  rmSync(file);
  writeFileSync(file, before);
  const after = readFileSync(file);
  if (!before.equals(after)) {
    console.error(`refresh-stale-files: content CHANGED while rewriting ${relative(root, file)}`);
    process.exit(1);
  }
  rewritten += 1;
  console.log(`refreshed ${relative(root, file)} (${before.length} bytes)`);
}
console.log(`refresh-stale-files: ${rewritten} file(s) refreshed; run typecheck again`);
