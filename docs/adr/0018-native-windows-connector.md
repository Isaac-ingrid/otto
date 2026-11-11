# ADR-0018: Native Windows support for the connector

Status: accepted. Amends decision 10 of [ADR-0001](0001-mvp-implementation-baseline.md) ("background
service on macOS (launchd) and Linux (systemd user unit); no Windows"). Phase 1 — a foreground
connector that runs a real pi task on a real Windows machine, read-only and then write — is
implemented and accepted (see the two acceptance records below). Phase 2 — the background lifecycle —
has landed all three of its steps: the one-daemon-per-state-directory lock (decision 10), the per-user
logon autostart (decision 11) and restart-on-failure (decision 12, `otto daemon --supervise`, which
the installed launcher now starts). What is left of phase 2 is running decision 6's acceptance list
on a real logoff/logon and a real reboot; an installer is explicitly a later phase.

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

## Acceptance record: the write closure, `commit → push → PR` (2026-11-10)

Phase 1 verified that a write task lands in a worktree. What it never did was close the loop — the
branch was left local, so the last leg of the product's core value had never run on this machine.

Setup, all of it required before the first PR could exist:

- A private lab repository (`otto-write-lab`, default branch `main`, one commit), registered on the
  machine as `worktree`/`parallel` and pushed so `origin` exists — `pr.ts` pushes the worktree's own
  branch and then runs `gh pr create` with the worktree as cwd, so both need a remote.
- `gh` on the machine, authenticated with the owner's own account (2.103.3, ssh protocol).
- **The launcher's baked `PATH` refreshed with `otto install`.** `cli.ts` captures `process.env.PATH`
  when the service is installed, and gh's installer does not add its directory to the machine's
  `Path` (checked: neither `HKCU\Environment` nor the machine one mentions it), so an install that
  predates gh produces a daemon that finds no `gh` and answers every consent with `gh_missing`.
- The running daemon restarted through the generated `otto-daemon.vbs` rather than by hand: its old
  environment carried the pre-gh `PATH`, and launching it this way also rehearses what the Run key
  will do at logon.

Run: one write task against the lab (append a section to `README.md`), then the report's consent
card, tapped `[同意]`. The connector's own log is the durable record:

```
command_received  cmdId=pr:w_…:12:1  kind=pr_worker
worker_event      type=pr_created
command_settled   cmdId=pr:w_…:12:1  kind=pr_worker  ok=true     # 9.7s end to end
```

Result: PR #1 open, base `main`, head `otto/t-01m72fjvv7gmgyt5fmhkadecsw-1`, one file, +4/-0,
`MERGEABLE`, body built from the report. Two things worth keeping from it:

- The commit was authored as `unknown <hexin@yaxon.com>`: the machine's global `user.name` is
  unset, and the **agent** runs `git commit` inside the worktree — the connector never does. So the
  identity is the machine's to fix (`git config --global user.name`), but a write closure that
  produces `unknown` authors is worth warning about rather than documenting.
- The PR title is the report's summary verbatim, which is deterministic by design (no LLM on this
  path) and read oddly here: it still ended with "未 push" in the sentence describing the work.

What this does **not** cover: the logoff/logon check below, and any failure stage other than the
happy one — `gh_missing`/`auth`/`push`/`create` have unit coverage (`pr.test.ts`,
`pr-consent.test.ts`, `report-template.test.ts`) and their copy is already written.

## Phase 2 (implemented): the background lifecycle

Decision 6 was phase 1's shape: `getServiceInstaller` returned `null` on win32 and the supported
shape was `otto connect … --foreground`. Phase 2 is the per-user autostart it deferred, and all three
of its questions are now decided and implemented: what starts the daemon (decision 10), what starts
it at logon (decision 11), and who supervises it (decision 12).

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

**Restart-on-failure is not the launcher's job.** launchd's `KeepAlive` and systemd's
`Restart=on-failure` have no Run-key counterpart: a value in the `Run` key can start a process but
never restart one, and the Start-menu "restart on failure" checkbox belongs to Task Scheduler (refused
without elevation). So the launcher starts `otto daemon --supervise` and the process it starts does
the restarting — decision 12. `install`'s notes say that, and that a *stop* stays stopped.

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

### Decision 12 (phase 2, step 3): `otto daemon --supervise` owns the lock and restarts the daemon

**`otto daemon --supervise` runs the daemon as a child and restarts it with backoff.** It is not a
Windows-only command: a container, a dev box with no service manager, or a `docker restart: always`
that only acts on `exit` all want the same thing. `WindowsService` installs the launcher with
`--supervise` appended by `daemonArgs()`, so a `ServiceSpec` built anywhere cannot silently install an
autostart that never comes back from a crash.

Who holds the lock is the load-bearing decision, and it follows from the supervisor outliving every
daemon it starts: **the supervisor holds `daemon.lock`** (its own pid and start time, decision 10's
identity discipline) and the supervised child must not take it. The child is authorised by evidence
rather than by trust, because an environment variable is something anything can set, and two daemons
over one `~/.otto` is exactly what the lock exists to prevent. Three checks, all fail-closed:

1. the environment says it is supervised (`OTTO_SUPERVISED_BY=<pid>`), and the value is a plausible
   pid;
2. that pid is the child's own parent (`process.ppid`);
3. that parent holds the lock — an unreadable lock owner is *not* a pass (decision 10).

A failure names which of the three is missing and exits, so `otto daemon` under a stale or forged
`OTTO_SUPERVISED_BY` refuses instead of quietly sharing the state directory, and a supervisor never
starts a second daemon behind a running one.

Restart policy: **1s → 2s → 5s → 15s → 30s → 60s**, and a run that lasted a minute resets the ladder
— a daemon that worked and then died is not a crash loop, while one that dies during startup is. A
stop races every wait, so a pending restart never delays `otto stop`; the child gets SIGTERM and a 5s
grace, and the force-kill stays `otto stop`'s job (`taskkill /T /F`, which a supervisor cannot do
better).

The supervisor adds a process layer, so it owes the operator what the daemon used to print:

- `logs/supervisor.log` gets the child's stdout/stderr, which a hidden autostart otherwise loses
  before the logger exists (decision 11's console problem, one level up).
- `logs/supervisor.json` records the supervisor pid, the child pid and the restart count, and
  `otto status` appends `[supervised: child pid N, M restarts]` to its `daemon:` line — but only while
  the lock's holder really is that supervisor, so a state file left by a previous run cannot decorate
  the current one.
- `otto stop` is unchanged and is still the whole stop story: the Run value first, then the lock's
  holder (`taskkill /T` takes the child with it), then the stale lock a forced kill leaves behind.

Accepted on the real machine (Windows 11, build 26100), against the real state directory and the real
steward over the SSH tunnel: a stale lock left by a killed daemon was taken over by the supervisor
(pid 5268, child 76420), and `otto status` read `running pid 5268 … [supervised: child pid 76420]`;
`taskkill /F` of the child was logged as `exited after 12109ms (code 1, signal none)` plus `restart 1
in 1000ms`, and the new pid (62980) was up 1.04s later, already reconnected (`connEpoch` 9) with
`restarts: 1` in `supervisor.json`; `taskkill /T /F` of the supervisor killed the child with it and
left a stale lock, which `otto stop` cleared — `daemon: not running (no daemon.lock)`, Run key still
empty. Unit tests cover the loop and the gate with an injected world (`supervisor.test.ts`) and the
gate through the real CLI with a throwaway state directory (`supervise-cli.test.ts`); ten mutations
(an uncapped backoff, no health reset, no SIGTERM, a restart that ignores a stop, both gate checks,
the state-file validation, the launcher's `--supervise`, the status note's holder check, the child
authorisation) each fail at least one test.

### Decision 13 (phase 2): `otto install` — the service, without a pairing code

`connect` was the only way to get a background service, and it costs a freshly generated, single-use
pairing code. That is the wrong price for the machine that is already paired and merely has no logon
entry: a `--foreground` pairing, an install that failed after the code was redeemed, a `Run` value
removed by hand (or by `otto uninstall`) while the credential is still in `~/.otto/connector.sqlite`.

**`otto install` writes the service for the credential that is already there** — the inverse of
`otto uninstall` — and is flat rather than namespaced (`otto service install`) so `install`/`uninstall`
read as one pair, like `start`/`stop`. It takes no arguments, because there is no code and no URL to
pass, so there is nothing for it to spend.

Two refusals, both before anything is written:

- **unpaired** → "not paired yet (…/connector.sqlite) — run `otto connect <url> <code>` first", plus
  what the command is *not* for ("never needs a pairing code"). An autostart for a machine with no
  credential can only fail at logon.
- **`OTTO_HOME` set** → the same refusal `connect` makes: the unit file and the `Run` value are shared
  machine state under one fixed label, so installing from a private state directory would silently
  repoint this machine's connector at it.

The order is the one decision 9 and the phase-2 section already agreed on, and it now lives in one
exported function (`installService` in `service.ts`), because `otto install` is not the only caller
that must not get it wrong: the installer's install-blocking `preflight()` first, then this version's
pi assets (a service installed without them comes up and fails every worker), then the unit/launcher,
then a fresh status. `otto connect` cannot reuse it — it writes the assets before it knows whether it
will install anything (`--foreground` does not) — so what is shared is the sequence, asserted directly
with a double (`install-service.test.ts`) rather than through either command.

Output says which of the two it was: `installed` vs `refreshed` (decided by the pre-install status),
the service line, the installer's notes (the `--supervise` hint on Windows), the credential the
service will use, and the log path. `WindowsService.start()`'s "launcher is not installed" refusal
now names `otto install` first and `otto connect` second, because on a paired machine it is the
command that fixes it.

Accepted on the real machine (Windows 11, build 26100) through the real CLI with a throwaway `HOME`:
exit 0, `installed windows dev.otto.connector (…\otto-daemon.vbs)`, the `Run` value
`…\System32\wscript.exe "<home>\.otto\otto-daemon.vbs"`, this version's assets in `<home>/.otto/ext`,
`otto status` reading `service: windows dev.otto.connector — running pid N` and `daemon: running pid
N … [supervised: child pid M]` with `supervisor.json` agreeing, a second `otto install` reporting
`refreshed` with the same supervisor pid (no second daemon), and `otto uninstall` killing the tree and
removing the launcher while keeping `connector.sqlite`. `test/windows-live.test.ts` runs it under
`OTTO_WIN_LIVE_INSTALL=1`; the CI-safe refusals are in `test/install-command.test.ts`, whose cases park
a tripwire — the state directory path is a *file*, so a run that got past a removed check dies in
`installAssets` with `ENOTDIR` — so that a mutation cannot leave a real `Run` value on the machine.
Nine mutations (both refusals, the argv check, the usage line, the `preflight()` call, the assets,
their order, the `otto install` hint, the before-status) each fail at least one test.

### Open (phase 2)

1. **What starts the daemon at logon — decided (decision 11).** The Run key plus a generated
   `otto-daemon.vbs`, because it is the only zero-elevation option of the three shapes above.
   *Machine evidence: `wscript.exe`/`cscript.exe` are present, the `Run` key holds seven per-user
   entries and no `NoRun` policy blocks it, the machine is not domain-joined, UAC is on and the shell
   is not elevated, and a `schtasks /Create /SC ONLOGON` probe failed with "access is denied"*.
   What this choice does **not** answer is restart-on-failure (below). The remaining fork if a
   managed machine ever needs it: Task Scheduler as an *opt-in* path (`otto install-task`, documented
   as needing elevation or an admin's approval) rather than what `connect` does by default.
2. **Who supervises the process — decided (decision 12).** `otto daemon --supervise`, spawned by the
   launcher: 1s → 60s backoff, a healthy run resets it, the lock moves to the supervisor, the child
   proves its parent holds it, and `logs/supervisor.log` + `logs/supervisor.json` replace the console
   a hidden autostart never had. The machines that do *not* need it — launchd's `KeepAlive`, systemd's
   `Restart=on-failure`, a container runtime's restart policy — keep their own mechanism; the Run key
   is the one that has none. The remaining fork is Task Scheduler as an *opt-in* path
   (`otto install-task`, needing elevation) whose restart-on-failure would make step 3 redundant on a
   managed machine: not built, and not blocked by anything here.

The acceptance test decision 6 asked for still applies, and four of its five checks are now
reachable: a killed daemon comes back with backoff under the installed launcher (decision 12,
verified on the machine); `otto stop` keeps it down across the next logon until `otto start`;
`uninstall` leaves neither an autostart entry nor an orphan process; and a second daemon refuses to
start (decision 10). What is still to be run is the one check no unit test can stand in for: a real
logoff/logon (and one real reboot) with the autostart installed, after which the machine must be
online in the workspace with no terminal opened.

**Deferred (2026-11-10).** The owner does not log off in normal use, and doing it deliberately costs
the terminal that would verify the result — so the launcher's own path was exercised the other way
instead: running the generated `otto-daemon.vbs` by hand put a new supervisor and child in place and
took over `daemon.lock`, which is everything the Run key does except the Run key firing. What remains
untested is therefore only whether Windows runs it at logon. Keep that check opportunistic: after the
next ordinary reboot, `otto status` must show a `service:`/`daemon:` pair whose pids and start time
are newer than the logon, and `supervisor.log` must gain a `supervising … as pid N` line. The "online
with no terminal" half is separate and still blocked on replacing the tunnel (phase 3) — **closed
below the next day.**

## Acceptance record: logon with no terminal (2026-11-11)

The deferred check above had a structural blocker: the connector was paired through
`http://127.0.0.1:8787`, a local SSH forward that dies with the session, so "online with no terminal"
could not pass by construction. Re-pointing it at the public address needed no pairing code — the
steward knows a machine by `deviceId` + `token`, and `serverUrl` is local bookkeeping, so one
`UPDATE credentials SET serverUrl` (daemon stopped) plus a start was enough; the record of that is in
`deploy/NOTES.md`. Then the owner rebooted and logged in. **No terminal was opened, no tunnel was
re-created, nothing was clicked.**

| # | check | before the reboot | after the reboot |
|---|-------|-------------------|------------------|
| 1 | `otto status` service / daemon | pid 78516, child 89624 | **pid 32496, child 7532, since 09:56:16** |
| 2 | `daemon.lock` / `supervisor.json` | pid 78516, `restarts: 0` | **pid 32496, `restarts: 0`** |
| 3 | `logs/supervisor.log` | `supervising … as pid 78516` | **`supervising C:\Users\Administrator\.otto as pid 32496`** |
| 4 | steward `sh_machine` | `online=1`, `bootId 20da15bb-…` | **`online=1`, `bootId d040529b-1b97-4daf-a4da-fdd6c99f0022`, `lastSeen 2026-11-11 09:56:16`** |
| 5 | `logs/connector.log` | `welcomed serverUrl=https://115.29.164.8` | **`daemon_start pid 7532` + `welcomed serverUrl=https://115.29.164.8`** |
| 6 | `connection_closed` | none since 2026-11-10 | **none** |

Windows confirms the reboot itself (`LastBootUpTime` 2026-11-06 11:43:33 → 2026-11-11 09:55:10), and
the steward's `bootId` changing is what makes this a reboot rather than a restarted process. So the
whole shape decision 11 chose is now observed end to end on the machine it was chosen for: the Run
key fires at logon, the generated `.vbs` starts the supervisor with no console, the supervisor takes
`daemon.lock`, and the child reaches the steward over TLS on the public IP with nobody watching.

What this still does **not** cover: a machine that is not logged in at all. The Run key is per-user
by decision 6, so an unattended Windows box needs the Task Scheduler path this ADR leaves opt-in; and
`otto stop` surviving the next logon is still asserted by unit tests only.
