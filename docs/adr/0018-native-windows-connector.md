# ADR-0018: Native Windows support for the connector

Status: accepted. Amends decision 10 of [ADR-0001](0001-mvp-implementation-baseline.md) ("background
service on macOS (launchd) and Linux (systemd user unit); no Windows"). Phase 1 — a foreground
connector that runs a real pi task on a real Windows machine, read-only and then write — is
implemented and accepted (see the two acceptance records below); phase 2 (the background lifecycle)
has landed its first two steps — the one-daemon-per-state-directory lock (decision 10) and the
per-user logon autostart (decision 11) — while restart-on-failure, the last open question, is step
3; an installer is explicitly a later phase.

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
   JavaScript entry read out of the shim and run with the connector's **own** node. `stdio` pipes
   and argv stay byte-exact in both shapes. The third shape is a **refusal**, not a launch: a shim
   that is neither a native binary nor readable as a JavaScript entry (a `.bat` with its own
   logic, a PowerShell shim, a broken install) resolves to `windows-unresolved` with the reason,
   `argv` stays the untouched command, and every spawn path fails with that reason instead of
   falling back to `cmd.exe`. Resolution is deliberately narrow: only a single bare command name
   is rewritten. An explicit `command` option (tests, embedders), a path, or an `.exe` is
   returned untouched, and `OTTO_PI_COMMAND` remains the escape hatch for installs that are not on
   `PATH` — including a wrapper a human deliberately wants a shell to run
   (`OTTO_PI_COMMAND="cmd /c C:\path\pi.bat"`).
   The Claude adapter resolves through the same path (npm installs `claude.cmd` too), and
   `detectClaude` resolves before `spawnSync` for the same reason.
   *Why:* the alternative — always going through `cmd.exe` — re-quotes session paths, extension
   paths and worktree paths, which is the fragile path the spike's protocol work avoided. A
   shell fallback would therefore be a silent, argument-mangling launch chosen automatically,
   and it is the one shape whose failure cannot be told from a bad install; refusing keeps the
   diagnosis (and the fix, which is an explicit `OTTO_PI_COMMAND`) in the operator's hands.

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

7. **`otto status` prints the resolved agent launch, and checks that it can be spawned.** One
   line — source, detail, and `NOT SPAWNABLE: …` when the executable it names does not exist, or
   the resolution's own refusal when it produced no launchable argv at all — so "pi works in my
   shell but otto cannot start it" is diagnosable before a task is dispatched rather than after,
   from a worker's stderr. `otto doctor` fails the same check, the daemon's `daemon_start` line
   records the resolved argv (and the refusal, if any), and both adapters refuse to spawn a
   refused launch. A wrong `OTTO_PI_COMMAND` (a spaced path whose inner quotes were lost) used to
   reach the user as "the task failed" with no reason.

8. **Testing is platform-parameterized, and Windows is a CI target.** New platform code takes its
   platform, environment and subprocess runners as injectable dependencies, so the Windows
   branches run on Linux CI; the tests that must be real (the CIM query, `taskkill`, the sampler
   against a genuinely busy child) are `runIf(win32)` and run on a Windows CI job.

9. **`connect` refuses before it spends the pairing code.** Pairing is single-use (protocol §5.2),
   so a machine that cannot install the service must say so before the `/pair` call rather than
   after it: Windows has no installer at all, and a headless Linux session has no reachable
   systemd user bus. `ServiceInstaller` gained an optional `preflight()` — systemd: one
   `systemctl --user show-environment`; launchd: `launchctl print gui/<uid>`, the same domain
   `install()` bootstraps into — and `connect` runs it before pairing, skipping it for
   `--foreground`, which needs no service. Only facts that would fail the install outright are
   allowed in there, never a preference; the cost of getting this wrong was a freshly generated
   code for every retry on Windows.

## Consequences

- The Windows branches are exercised by CI, but the acceptance test for this phase is a manual one
  on a real machine, with no WSL in the loop: pairing, a read-only pi task and a write task in an
  isolated worktree. Both halves now have a record below.
- Process introspection on Windows costs a PowerShell process per sweep (~0.4–1.5 s). That is
  affordable at the existing cadences (snapshot loop, watchdog tick at ≥5 s) and is the reason
  decision 5 keeps the sampler to one query per sample rather than two.
- POSIX behaviour is unchanged: `pi-launch` returns the argv untouched, `kill` signals directly,
  and `descendants`/`locks`/`session-holders` keep using `ps`/`/proc`. The existing macOS/Linux
  tests must stay green, which is the regression gate for this ADR.
- The Windows test suite is not yet fully green (POSIX-shaped path assertions and temp-directory
  cleanup are the remaining debt). That debt is tracked with the background phase, not hidden by
  skipping whole files.

## Acceptance record (2026-11-10)

The phase-1 test was run on a real Windows machine (`CXFZB-liwq`, `dev_4f426b79da4b`, Windows 11,
Node 24) connected to the deployed steward, with no WSL in the loop:

| Step | Observed |
| --- | --- |
| Pairing | code redeemed over an SSH tunnel, `connEpoch 1`; steward shows the machine online with `["pi"]` |
| Launch | `otto status`: `pi: windows-node-entry — C:\Users\Administrator\.pi\agent\bin\pi-launcher.js`, no environment override |
| Task | steward-dispatched **read-only** "summarize this repository" on `D:/project/tstock` |
| Worker | `w_01M728HKXJ67NYCYVG9BPYY7Q2`: `started → 5 × progress → report → settled` in 48.5 s |
| Steward | `sh_worker.lastOutcome = reported:done`, worker `idle`, thread `unread 0` |
| Report | a `文件:行号`-cited summary (purpose / stack / entry points / layout) delivered as a card |
| Read-only respected | tools used: `read`, `ls`, `report` — no write, no shell |
| Repository untouched | HEAD `6456c51b…`; `git status` (31 entries) and `git diff \| sha1sum` byte-identical to the pre-run fingerprint |

The same machine settled three failures before that pass, and they are part of the record because
they are what decision 7 and the settled-error pass-through ([connector-pi.md §5.2](../design/connector-pi.md))
exist for:

- two `error:unknown` settles: pi's default provider (`openai-codex`) was out of quota, and the
  reason stayed in pi's session file — the steward saw only the class;
- one `startup_failed`: the launch came from an `OTTO_PI_COMMAND` whose spaced path lost its inner
  quotes, so `argv[0]` was `C:\Program` and spawn returned `ENOENT`.

Two operational prerequisites for a Windows connector follow from this run and are documented in
[agent-connect.md](../agent-connect.md) and the READMEs: the local agent's *default* provider must
have usable quota (an agent that silently falls back to a logged-in but exhausted provider reports
only a provider-side error), and a spaced path in `OTTO_PI_COMMAND` must be inner-quoted — or use
`node <launcher> …`, which has no space to quote.

## Acceptance record: write task in a worktree (2026-11-10)

The write half of the phase-1 acceptance ran on the same machine against a throwaway Git
repository — `D:\project\otto-write-lab`, one commit `8355e96`, registered through the workspace's
*Add directory* — so that the isolation claim is checkable and nothing real is at risk. Task: create
exactly one file, `NOTES.md`, holding three given lines; no other file, no dependency install, no
build, and no commit (so the change stays visible in the worktree).

| Step | Observed |
| --- | --- |
| Policy | `otto repo-config`: `capability: git`, `isolation: worktree`, `concurrency: parallel` — the default for a Git repository, with no per-repo override |
| Worker | `w_01M72FJVVAWH14D834892Y2J94`: `mode=write`, `base=main`, `branch=otto/t-01m72fjvv7gmgyt5fmhkadecsw-1` |
| Worktree | `C:\Users\Administrator\.otto\worktrees\otto-write-lab-8731e22d\t-01m72fjvv7gmgyt5fmhkadecsw-1`, created by the connector's `git worktree add -b` before the agent started |
| Product | `NOTES.md`, 29 bytes, 3 lines, LF — byte-identical to the requested text (no BOM, no CRLF) |
| Worktree state | `?? NOTES.md`; `git.head == git.base == 8355e96`, `ahead 0`, `dirty 1`, `pushed false` |
| **Registered directory** | `git status --porcelain` empty, `HEAD` still `8355e96`, still holding only `.git` and `README.md` |
| Agent's own account | the report's `changes[0]` names the worktree's absolute path; its `next` hands the commit decision back to the owner |
| Steward | `lastOutcome = reported:done`, worker `idle`, thread `unread 1`, `lastMachine` unchanged |

Isolation is confirmed from both sides at once: the disk (the registered directory is untouched and
the change exists only under `~/.otto/worktrees/`) and the agent's own report (it knows which
checkout it wrote into). Deliberately *not* covered by this run: the commit → push → PR path, since
the task text forbade committing (`ahead 0`, `pushed false`).

## Phase 2 (implementing): the background lifecycle

Decision 6 was phase 1's shape: `getServiceInstaller` returned `null` on win32 and the supported
shape was `otto connect … --foreground`. Phase 2 is the per-user autostart it deferred. Question 3
(what starts the daemon) and question 1 (what starts it at logon) are now decided and implemented
as decisions 10 and 11; question 2 (who supervises it) is the remaining step.

### Decision 10 (phase 2, step 1): one daemon per state directory

**A daemon lock is a prerequisite for any autostart, and it is implemented as such** — step 1 of
phase 2, because neither of the other two questions is safe to answer without it.

- `~/.otto/daemon.lock`, claimed by `otto daemon` and by `otto connect --foreground` (the supported
  shape on Windows, and the escape hatch everywhere else), released on SIGTERM/SIGINT.
- Identity discipline is `locks.ts`'s: `pid` + process start time; a dead pid or a live pid whose
  start time differs is stale, and a live pid whose start time cannot be read is *unknown* and the
  lock stays held. An unparseable lock file is held for the same reason — the holder cannot be
  checked at all. Refusing costs one retry; granting costs a second daemon.
- Release is owner-checked, so a daemon that lost a race does not delete the new holder's lock.
- It lives in the state-dir root, not `locks/`, because the §9.1 worker sweep rewrites every
  `*.lock` in that directory.
- `otto status` prints it as its own `daemon:` line, which separates *running* from *a stale lock left
  by a crash*. Since decision 11 the `service:` line above it is no longer "not supported" on
  Windows; the two answer different questions (a Run value can exist with nothing running, and
  `otto daemon` runs with no Run value at all), so both lines are kept.
- `otto connect --foreground` checks it before redeeming the pairing code, under decision 9’s rule
  (a fact that would make the run fail outright, never a preference). The service path deliberately
  does **not** check it: the installer restarts the machine's single daemon, which releases the lock
  on the way out, and refusing there would break a legitimate re-pair.

Accepted on the real machine (Windows 11, build 26100): the lock was written with the live pid and
its creation timestamp; a second `otto daemon` refused with the holding pid, start time and version
(exit 1); a `--foreground` connect refused the same way before any `/pair` traffic; a hand-corrupted
lock file was refused with the file left in place; a stale lock (dead pid, left by a `taskkill /F`
of the previous build) was replaced and the directory was clean again after the daemon exited on an
unrelated failure. Unit tests (`daemon-lock.test.ts`) cover each verdict with injected process
identities, and `connect-preflight.test.ts` covers the ordering for `--foreground` on every platform.

### Decision 11 (phase 2, step 2): a per-user Run key, launched through a generated wscript file

**The Windows logon autostart is one `HKCU\…\Run` value pointing at a generated `~/.otto/otto-daemon.vbs`,
and `otto connect` installs it without elevation.** A Windows *Service* is rejected by decision 6
(session 0 has no user profile, no desktop and no user PATH, and the agent it spawns is a
user-profile program), so what is left is per-user autostart, and of its three shapes:

- **Task Scheduler's logon trigger** is the structural analogue — a unit on disk, hidden, with
  restart-on-failure — and it is what a managed machine would use. It cannot be what `otto connect`
  does: on this machine a `schtasks /Create /SC ONLOGON` probe was refused with `access is denied`
  (exit 1, no task created) from an unelevated shell.
- **A Startup-folder shortcut** has the Run key's limits and adds a `.lnk` that needs PowerShell COM
  to write.
- **The Run key** needs no elevation, is visible to the user in Task Manager's startup tab, and is
  one value to remove. It wins by elimination, not preference.

The launcher is not decoration: `node.exe` is a console program, so a Run value pointing straight at
it opens a console window that the user can close. Through `wscript.exe` the window is style 0
(hidden), and the VBS also does the job the plist/unit's `EnvironmentVariables` does — at logon the
environment knows nothing of `OTTO_HOME` or of whatever directory `node`/`git` were installed into.
It is the Windows analogue of the unit file: written by `connect`, named by `status`, removed by
`uninstall`, and it holds no credential (the daemon reads its own from the state directory).

Consequences carried into the CLI:

- `start` re-enables the value and waits for the **daemon lock** (decision 10) before reporting
  success, so a launcher that cannot start says so instead of leaving a dead autostart entry. It
  refuses when the launcher is missing — the same "not installed" answer launchd/systemd give —
  rather than writing a Run value for a machine that never paired.
- `stop` removes the value first (so being stopped survives the next logon, like launchd's
  `disable` before `bootout`) and then ends the daemon named by the lock. A Windows force-kill
  cannot run the daemon's SIGTERM handler, so the lock file it leaves is cleared with it — otherwise
  `otto status` would claim a connector that is not there.
- `status` reads the run value, the launcher and the lock: *not in the Run key* / *starts at the next
  logon* / *Run key + otto-daemon.vbs* with the pid. A Run value whose launcher is gone is reported
  as not installed, because it would fail silently at logon.
- `preflight` (decision 9) refuses three read-only facts — a policy-disabled Run key
  (`…\Policies\Explorer\NoRun`), Windows Script Host turned off (`…\Windows Script Host\Settings\Enabled=0`),
  or a missing `wscript.exe` — because each makes the install pointless and each is discoverable
  before the single-use pairing code is spent. Whether the registry write itself will be allowed is
  not checked: that cannot be known without writing, and `HKCU` is the user's own hive.

**Not covered: restart-on-failure.** launchd's `KeepAlive` and systemd's `Restart=on-failure` have no
Run-key counterpart, so a crashed daemon stays down until the next logon. `install` says exactly that
in its notes instead of leaving a user to discover it; step 3 (`otto daemon --supervise`) is the
platform-independent answer.

Accepted on the real machine (Windows 11, build 26100), with a throwaway state directory and entry
script so no credential or steward was involved: `install` wrote the launcher and the Run value
(`reg query` returns `C:\Windows\System32\wscript.exe "…\otto-daemon.vbs"`), the launcher really ran —
the hidden child wrote back the `OTTO_HOME`, a PATH prefixed with a test directory and a marker
variable it was given through `sh.Environment("PROCESS")`, with its cwd set to the state directory —
and `start` only returned once the child's lock was held, which `status` then reported with its pid.
`stop` removed the value, ended the child (verified by `tasklist`) and cleared the lock; a second
`install` after that stop worked, and `uninstall` removed the launcher and the value while keeping
`connector.sqlite`. The same run is available as `test/windows-live.test.ts`, skipped unless
`OTTO_WIN_LIVE_INSTALL=1` is set (it refuses to run while `dev.otto.connector` is already in the Run
key, so it can never overwrite a working installation). Unit tests cover the rest with injected
`reg.exe`, launch, taskkill and lock deps, and ten mutations of the new code (dropping the
start-refusal, the kill, the lock cleanup, the path quoting, window style 0, the policy check, the
launcher check, the env block, the Run write, the lock wait) each fail at least one test.

### Open (phase 2)

1. **What starts the daemon at logon — decided (decision 11).** The Run key plus a generated
   `otto-daemon.vbs`, because it is the only zero-elevation option of the three shapes above.
   *Machine evidence: `wscript.exe`/`cscript.exe` are present, the `Run` key holds seven per-user
   entries and no `NoRun` policy blocks it, the machine is not domain-joined, UAC is on and the shell
   is not elevated, and a `schtasks /Create /SC ONLOGON` probe failed with "access is denied"*.
   What this choice does **not** answer is restart-on-failure (below). The remaining fork if a
   managed machine ever needs it: Task Scheduler as an *opt-in* path (`otto install-task`, documented
   as needing elevation or an admin's approval) rather than what `connect` does by default.
2. **Who supervises the process.** launchd (`KeepAlive`) and systemd (`Restart=on-failure`) restart a
   crashed daemon; nothing on Windows does. If the chosen mechanism does not, a small
   platform-independent supervisor mode is the alternative (`otto daemon --supervise`: spawn,
   restart with backoff, append the child's stdout/stderr under the log dir). The daemon's own log
   (`~/.otto/logs/connector.log`, rotated) already covers what the process does; what a hidden
   autostart loses is whatever is printed to the console before the logger exists. A supervisor adds
   a second process layer, so the lock's holding pid becomes the supervisor's.

The acceptance test decision 6 asked for still applies, and three of its five checks are now
reachable: after logoff/logon the machine is online in the workspace with no terminal opened (the
one part that needs a real logoff, still to be run); `otto stop` keeps it down across the next logon
until `otto start`; a killed daemon comes back **only if** supervision is claimed — with decision 11
and no supervisor it stays down until the next logon, which is why step 3 exists; `uninstall` leaves
neither an autostart entry nor an orphan process (verified on the machine); and a second daemon
refuses to start (decision 10, verified).
