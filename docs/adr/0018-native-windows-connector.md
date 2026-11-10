# ADR-0018: Native Windows support for the connector

Status: accepted. Amends decision 10 of [ADR-0001](0001-mvp-implementation-baseline.md) ("background
service on macOS (launchd) and Linux (systemd user unit); no Windows"). Phase 1 (a foreground
connector that runs a real pi task on a real Windows machine) is implemented; the background
lifecycle and an installer are explicitly later phases.

Context: the deployment shape this project settled on is a steward running 24/7 on a small cloud
server with connectors on the machines the owner actually works on — and those include Windows.
On Windows the connector's three POSIX assumptions all break, and each one fails in a way that is
worse than "unsupported":

- **Spawning the agent.** npm-style installers (and pi's own installer) put `pi.cmd` on `PATH`.
  Node refuses to spawn a `.cmd`/`.bat` without a shell (the CVE-2024-27980 hardening), and pi
  installs both `pi` (sh) and `pi.cmd`/`pi.ps1`, so `spawn("pi")` throws `EINVAL` on a machine
  where `pi` works perfectly in the user's terminal.
- **Process introspection.** `locks.ts`, `descendants.ts`, `session-holders.ts` and `watchdog.ts`
  shell out to `ps` and/or read `/proc/<pid>/cmdline`. Windows has neither. The old behaviour was
  the safe half of "unsupported": no descendant snapshot, no stall sampling — and therefore no
  orphan cleanup and no stall detection, silently.
- **Signalling.** `process.kill(pid)` reaches one process. A pi run is a tree (pi plus its tool
  children); on Windows a stop has to be a tree kill (`taskkill /T`), or tool children keep
  running with their worktrees.

Windows also has no launchd/systemd equivalent that can host an interactive agent: a Windows
*Service* runs in session 0, with no desktop, no user profile and a different `PATH` — the wrong
place for a process that must spawn the user's own agent CLI. Foreground is the honest shape
until a per-user logon autostart exists.

## Decisions

1. **Resolve the agent launch instead of shelling out.** `pi-launch.ts` turns the bare command
   name into an argv Windows can spawn: a native `pi.exe` if present, otherwise the real
   JavaScript entry read out of the shim and run with the connector's **own** node, and only as a
   last resort `cmd.exe /d /s /c <shim>`. `stdio` pipes and argv stay byte-exact in the first two
   shapes; the shell fallback is the shape that can re-quote an argument, which is why it is last.
   Resolution is deliberately narrow: only a single bare command name is rewritten. An explicit
   `command` option (tests, embedders), a path, or an `.exe` is returned untouched, and
   `OTTO_PI_COMMAND` remains the escape hatch for installs that are not on `PATH`.
   The Claude adapter resolves through the same path (npm installs `claude.cmd` too), and
   `detectClaude` resolves before `spawnSync` for the same reason.
   *Why:* the alternative — always going through `cmd.exe` — re-quotes session paths, extension
   paths and worktree paths, which is the fragile path the spike's protocol work avoided.

2. **One process table per sweep, read through Win32_Process.** `win32.ts` runs a single
   `Get-CimInstance Win32_Process` query (PowerShell, falling back to `pwsh`; `wmic` is gone in
   Windows 11 24H2) and shapes the rows exactly like one `ps -axo pid=,ppid=,lstart=` pass:
   pid, parent pid, creation time, cumulative CPU, and — on request — the command line. The
   command-line variant is a separate cached table because it is the expensive one. A failed
   query degrades to `[]`, never to a wrong answer.

3. **Process identity is `pid + creation time`, as on POSIX.** `lockIsHeld` and `killOrphans`
   compare the recorded start time against the live one so a recycled pid is never killed. On
   Windows the creation timestamp from decision 2 plays `lstart`'s role. The comparison is only
   ever against a value this machine produced, so the two formats never meet.

4. **Termination is a tree kill, guarded by the same "never touch the system pids" rule.**
   `kill.ts` uses `taskkill /PID <pid> /T [/F]` on Windows and the plain signal elsewhere.
   SIGTERM vs SIGKILL maps to non-forced vs forced, so the graceful path stays graceful. Pids
   0, 1, 2, 4 and the connector's own pid are never signalled on either platform.
   `taskkill /F` is *not* treated as an equivalent of POSIX signal escalation — it is a
   best-effort tree kill, and a Windows Job Object (or equivalent) is the real answer if
   run-away tool children turn up in practice.

5. **The stall watchdog's CPU sample never comes from a cache.** On Windows the two samples of
   `sampleTreeCpu` each read one *fresh* table (the shared cache is bypassed) and derive both the
   member set and the CPU totals from that single table. A delta measured across a cached
   snapshot is exactly zero, which reads as a stone-cold tree and would strike — and respawn —
   a healthy worker. Any member that is absent from the table, or whose counter is unreadable, or
   the root itself missing, yields *no sample*, never a low one: a smaller-than-real sum is
   indistinguishable from a stall.

6. **No background connector service on Windows in this phase.** `getServiceInstaller` keeps
   returning `null` for `win32`, and both `otto connect` and `otto status` say what to do instead
   (`--foreground`). A per-user logon autostart is a later decision with its own acceptance test
   (survives logoff/logon, never auto-restarts a task the user explicitly stopped). Putting the
   connector into session 0 is rejected: the agent it spawns is an interactive, user-profile
   program.

7. **`otto status` prints the resolved agent launch.** One line — source and detail — so "pi works
   in my shell but otto cannot start it" is diagnosable without reading the log.

8. **Testing is platform-parameterized, and Windows is a CI target.** New platform code takes its
   platform, environment and subprocess runners as injectable dependencies, so the Windows
   branches run on Linux CI; the tests that must be real (the CIM query, `taskkill`, the sampler
   against a genuinely busy child) are `runIf(win32)` and run on a Windows CI job.

## Consequences

- The Windows branches are exercised by CI, but the acceptance test for this phase stays a manual
  one on a real machine: pairing, a read-only pi task, and an append or write task in an isolated
  worktree, with no WSL in the loop.
- Process introspection on Windows costs a PowerShell process per sweep (~0.4–1.5 s). That is
  affordable at the existing cadences (snapshot loop, watchdog tick at ≥5 s) and is the reason
  decision 5 keeps the sampler to one query per sample rather than two.
- POSIX behaviour is unchanged: `pi-launch` returns the argv untouched, `kill` signals directly,
  and `descendants`/`locks`/`session-holders` keep using `ps`/`/proc`. The existing macOS/Linux
  tests must stay green, which is the regression gate for this ADR.
- The Windows test suite is not yet fully green (POSIX-shaped path assertions and temp-directory
  cleanup are the remaining debt). That debt is tracked with the background phase, not hidden by
  skipping whole files.
