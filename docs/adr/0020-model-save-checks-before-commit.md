# ADR-0020: Model candidates are saved separately from activation

Status: implementation candidate; local validation required before release.

## Context

Settings used to replace the active model, provider key and endpoint before testing them.
Rolling back only the selection cannot recover a key or headers overwritten by a rejected
candidate. Awaiting a test also allows another user action to change the selection meanwhile.

## Decisions

1. Workspace saves persist a sealed snapshot in `sh_model_draft` (migration 037). Saving
   without `autoTest` saves only a candidate; it never enables an unchecked configuration.
   Candidate metadata/status are public to the authenticated settings page, but keys and custom
   headers are never returned. Inherited credentials/headers are frozen when saving.
2. A candidate is identified by id and monotonically increasing revision. Re-editing the same
   provider/model replaces that candidate with a new revision. Verification is bound to that
   revision and cannot mark a later revision verified. Deletion also checks revision.
3. Verification runs against the sealed candidate without writing live verification/probe caches.
   Failures store only bounded, enumerated error codes. A successful test is evidence of an
   accepted request at that time, not a permanent availability or reasoning guarantee.
4. Activation requires a verified revision, unchanged live generation and an idle root session.
   Every normal live configuration write increments the durable generation, including legacy
   RPC writes and composer switches. If a different selection or credential was committed during
   testing, activation returns `conflict`; the owner must edit/save a new candidate. Busy drafts
   remain verified and pending. There is no automatic activation when a reply ends.
5. Crypto/decryption/import preparation precedes the final busy observation. The final revision
   and generation checks, key, selection, saved-model/import rows, verification/probe caches,
   generation increment and candidate status share one synchronous storage transaction with no
   external await. Notification happens only after commit. A failed write rolls everything back.
6. Existing internal `setModelConfig` callers retain their trusted low-level meaning, but now
   commit atomically. The workspace path does not use it to enable unverified candidates.
7. `POST /app/api/settings/model` returns explicit `activated` and a lifecycle status (`saved`,
   `verification_failed`, `verified`, `activated`, `busy`, `conflict`) plus candidate id/revision.
   `POST /app/api/settings/model/draft` accepts authenticated, CSRF-protected `verify`, `activate`
   and `delete` actions for an exact id/revision. Settings lists persisted candidates so a reload
   does not hide a failed test. Retrying verification and activating are distinct owner actions.
8. Tests may consume provider credits. Compatible endpoints can require several thinking probes.
   Existing matching probe caches may be reused; a forced manual test makes new requests and is
   not promised free. Candidate verification results enter live caches only upon activation.

## Validation boundaries

`test/model-draft.test.ts` exercises real SQLite and crypto: persistence/redaction, request
validation/CSRF, test-slot contention, busy-to-explicit-activation, stale revision, inherited-key
rotation and a slow test, and injected SQL failure after the selection write with complete
rollback. Only the provider boundary is scripted for success/timing; the unknown-model failure
uses the real verifier without a network request. `test/model-switch.test.ts` retains legacy
selection/key/catalog coverage and tests the changed workspace save semantics. Trusted RPC
fixtures seed live state where older tests used an unchecked workspace save.

Browser test 8 in `e2e/workspace-smoke.spec.ts` covers failure persistence across reload and the
separate retry/activation buttons with scripted provider responses. The conversation journey is
a separate regression check, not evidence that real-provider credentials work. No paid model call
or production access is authorized by these tests.

The event-delivery TLA+ model does not cover model configuration transactions. Its pass would
not establish this contract; the injected real-SQL transaction regression is the relevant check.
