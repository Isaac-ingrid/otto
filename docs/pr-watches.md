# Read-only PR / CI Follow-up

Date: 2026-11-13. First persistent-commission pilot from the
[supervised improvement procedure](design/otto-improvement.md). The owner explicitly binds a GitHub
PR to an existing Thread. Otto waits, checks external state, and reports meaningful changes without
starting an LLM turn or worker. This is not automatic repair, review, branch protection verification,
or permission to push/merge/re-run anything.

## Natural-language tools (deployed 2026-11-15)

The source includes `create_pr_watch`, `list_pr_watches` and `cancel_pr_watch`. Creation/cancellation
are now **two-phase** ([ADR-0019](adr/0019-pr-watch-owner-confirmation.md)): the model only proposes;
the owner must press the dedicated server-rendered confirmation button before any watch change.
The preview binds the operation, PR, Thread, evidence scope, interval and lifetime. Ordinary text,
quoted agreement and generic ask buttons cannot authorize it. Confirmations expire after ten
minutes and duplicate taps do not repeat or renew the effect. Source `4f66827` passed independent
review, full Node/workerd app suites and the real-model routing/intent gates before deployment;
see [experiment 0007](research/experiments/0007-bound-pr-watch-confirmation.md). The live lab smoke
used authenticated workspace HTTP/CSRF actions and synthetic statuses, not real CI/phone push.

Examples:

- "Follow https://github.com/owner/repo/pull/42; only commit statuses, notify me when successful,
  do not modify code."
- "Which PRs are being followed?"
- "Cancel watch pw_123."

This first tool version binds to an **existing Thread**. An explicit URL must occur in the real
owner message, or a uniquely known PR may be reused from an explicitly selected/named Thread.
Known targets come from structured PR-consent/watch records, not arbitrary worker prose. If the
PR or Thread is ambiguous, ask the owner; do not dispatch a worker to invent an association.
`get_thread` includes `pullRequests` and `prWatches` to make those references inspectable.

Creation and cancellation tool proposals require an actual owner run; event/routine/follow-up
runs cannot propose a commission. Applying the owner's button decision does not invoke the model. Conversation-tool creation additionally requires explicit persistent intent; a URL
or "check once" request is not enough. Explicit one-shot/negative or contradictory watch wording
refuses creation before reuse/replay. This conservative lexical gate is not a general language
parser: clarify ambiguous intent. "CI and commit statuses" means full evidence scope, while
negated CI/Checks is not full-scope authorization. Limited scope must be explicit in the owner's
words. The explicit confirmation, not keyword matching, is the mutation authority. A repeated
request proposes reuse of an active watch; only confirmation can re-arm it, without extending
expiry. Replays of an already applied proposal do not re-arm it again. Conflicting scope or
lifetime requires owner clarification. Once a PR-create tool has been attempted, the same turn
cannot fall back to a worker or another routine/follow-up (and the reverse order is also blocked).
An unrelated later owner turn is unaffected. These are deterministic boundary tests; scripted
model tests do not prove a real model will select the right tool.

## Create, inspect, cancel via Owner API

This programmatic surface uses the optional explicit-SERVER_KEY [Owner API](../CONTEXT.md).
Its authenticated typed create/cancel commands remain direct; the confirmation protocol above
applies to model-generated conversational proposals. Browser-only installations do not need to enable
this API unless they want the pilot. Use your deployment's HTTPS origin and keep credentials out
of committed scripts or shell history.

```sh
# SERVER_KEY comes from your secret manager. THREAD_ID is an existing Thread.
curl --fail-with-body "$OTTO_ORIGIN/api/pr-watches" \
  -H "Authorization: Bearer $SERVER_KEY" -H 'Content-Type: application/json' \
  --data "{\"action\":\"create\",\"id\":\"follow-pr-42\",\"threadId\":\"$THREAD_ID\",\"url\":\"https://github.com/example/project/pull/42\"}"

curl --fail-with-body "$OTTO_ORIGIN/api/pr-watches" -H "Authorization: Bearer $SERVER_KEY"

curl --fail-with-body "$OTTO_ORIGIN/api/pr-watches" \
  -H "Authorization: Bearer $SERVER_KEY" -H 'Content-Type: application/json' \
  --data '{"action":"cancel","id":"follow-pr-42"}'
```

Create fields:

| Field | Meaning |
|---|---|
| `id` | Owner-chosen idempotency key, 1–80 ASCII letters/digits/underscore/hyphen |
| `threadId` | Existing Thread to receive the reports |
| `url` | Canonical `https://github.com/owner/repo/pull/number` URL only |
| `intervalSeconds` | Optional, 60–3600; default 900 (15 minutes) |
| `evidenceMode` | Optional, `checks-and-statuses` (default) or explicit `statuses-only`; immutable for an id |
| `expiresAt` | Optional Unix epoch milliseconds, future and within 7 days; default 24 hours |

Retry the same create payload with the same id. A conflicting payload returns 409. An id is never
reused to resurrect cancelled, expired or completed work; start a new commission with a new id.
The default expiry is chosen once. GET returns the latest 100 records, active first. Cancel is
idempotent for known ids; it suppresses pending notifications, but cannot unsend a message already
handed to the durable outbound queue or browser push service. Completed history is retained.

## Permissions and network access

All external requests are GETs to `https://api.github.com`; redirects are refused. No arbitrary API
host, commands, check logs, PR titles/bodies/comments or workflow names are accepted as instructions.
The reader stores structured counts, commit SHA and fixed reason codes, not raw provider errors.

Public repositories can be read without a token, subject to GitHub's unauthenticated rate limit.
For private repositories or higher limits, set `OTTO_GITHUB_READ_TOKEN` on the server (Node env or
protected `.dev.vars`; Cloudflare secret). Do not grant write permissions.

For **explicit `statuses-only` commissions**, a selected-repository fine-grained token with read-only
Pull requests, Commit statuses and automatic Metadata permissions is sufficient. In the owner's
current GitHub PAT UI, Checks is not selectable; server verification returned 200 for PR/statuses
but 403 for check runs. The original instruction to select Checks on that screen was incorrect.
Do not switch to a broad classic token or assume Actions permissions are a substitute.

The default `checks-and-statuses` mode still requires a credential that can actually read both
sources (for example an appropriately scoped GitHub App token). It never falls back after a 403.
To use the limited mode, create a **new** id with `"evidenceMode":"statuses-only"`; it reads PR and
commit statuses only, and every result notice states that Checks/Actions and full CI were not
verified. No modes are inferred from a credential's permissions.
The token never enters a model context, API response or notice. Revoking it at GitHub or removing
it from deployment config blocks later authorized reads; this is distinct from cancelling a watch.
A request already in flight may finish, so use watch cancellation to reject its late result.

GitHub Enterprise hosts are not supported. A moved repository that redirects is unavailable until
the owner creates a commission for its canonical URL. No shell `gh` invocation or ambient local
GitHub credentials are used.

## State and evidence

- **active**: wait for evidence; failed CI remains active and can later recover.
- **completed**: observed checks pass, or PR was closed/merged. `observedState` distinguishes these.
- **cancelled**: no further checks. In-flight results lose authority.
- **expired**: no further checks; a single expiry notice states success was not established.

The timer answers *when to inspect*. The observed condition answers *whether to act*. One durable
minute cron serves all watches; each pass handles at most two due watches. Empty passes use local
SQL only. Default first observation occurs on the next cron pass; later observations respect the
stored interval. At most 10 watches may be active. Rate limits and outages back off at least five
minutes and do not create a Needs you item for every failure.

For an open PR, the default reader gets the head SHA, latest check runs and combined commit statuses
pinned to that SHA, then re-reads the PR. `statuses-only` skips the check-runs request entirely but
retains the same head recheck, pagination validation, cancellation and expiry safeguards. Empty
commit statuses remain waiting, not success. The scope is stored in SQLite and returned by the API;
a create retry cannot silently strengthen or weaken it. A changed head/state invalidates the observation. Unknown
conclusions, response truncation (over 100 results), malformed data or a mismatched check SHA are
unavailable evidence, never success. Zero checks and all-skipped/neutral checks remain waiting;
a success requires at least one actual success and no observed failure or pending check.

**Observed checks passing is not proof that required workflows have all started, branch protection
is satisfied, or the owner's requirement is met.** New workflows can appear after an observation.
Success ends this one-shot commission for the observed head, not an everlasting promise that the
PR will remain green; start another watch if further monitoring is wanted. A final head recheck
reduces races but is not an atomic snapshot of GitHub.

On unavailable evidence, the last successful observation stays in the record with its original
`checkedAt`; `lastError` indicates it is not fresh. No error is silently converted into a failed
build or green result. An outage can still conceal a transient state between polls.

## Recovery and notifications

The observation and notification intent commit in one SQLite transaction. Delivery to the existing
outbound queue uses a stable id: commission × head × observation kind. A crash after delivery but
before acknowledgement retries that id rather than creating another message. Failed reads are
leased; restart retries after the lease expires. Generation checks reject cancelled, expired or
superseded reads. Startup re-arms the cron if active work or pending notices exist.

Failure is summarized as failed/pending counts and the PR/commit reference. Subsequent migrations
(`044`, `045`, and `052`) added bounded out-of-band CI failure log diagnosis, merge-conflict and
trusted-review triage (`watchGoal: "ci_pass" | "merged"`), stuck-watch detection, and owner-consented
zero-checkout blind PR review while preserving the read-only GitHub boundary:

- **CI failure & review/conflict triage (`044`–`045`)**: extracts bounded failing check excerpts,
  mergeability (`mergeable` / `conflicted`), and cursor-deduplicated review threads via tool-less
  completion callbacks (falling back to deterministic summaries when over budget or without a model).
- **Stalled watch consent card (`052`)**: when an active PR head stays stalled in `waiting`,
  `conflicted`, or `changes_requested` past 2 hours (`PR_WATCH_STUCK_THRESHOLD_MS`), Otto sends at
  most one deduplicated owner card per head (`[派发只读探针诊断]` / `[继续等待]` / `[取消此 PR 跟进]`)
  and never auto-merges or mutates the PR.
- **Zero-checkout blind PR review (`052`)**: only when the owner taps `[派发只读探针诊断]`, the
  connector extracts unified diff facts directly from git objects (`git_pr_diff` with
  `-c core.hooksPath=/dev/null`, refusing octopus merges `parentCount > 2` and leaving local dirty
  working trees untouched), strips the author worker's conversation/reasoning, and dispatches a
  read-only review worker (preferring a distinct engine family from the author worker when available,
  otherwise a fresh zero-history read-only session).

Waiting/repeated observations remain silent; failure, conflict, new review feedback, success,
closure, merge and expiry produce a Thread-linked message. Browser push is best-effort and respects
existing quiet hours. Delivery and GitHub observation are different states.

## Acceptance evidence

The [experiment record](research/experiments/0002-pr-watch.md) and
[agent-autoloop adoption plan](plan/agent-autoloop-adoptions.md) document the checks and boundaries.
Tests use fake GitHub responses, real dirty git worktrees for zero-checkout diff isolation, and both
steward runtimes.
