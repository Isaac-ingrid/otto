# Otto verification feature map

Run from repository root. The helper owns one isolated fixture at a time; evidence survives cleanup.

| User-facing feature | Journey / command | Coverage boundary |
| --- | --- | --- |
| [Conversation and stop](conversation.md) | `node scripts/verification/verify-otto.mjs run conversation` | Real browser + Node steward, scripted model; no real coding worker |
| [PR watch confirmation](pr-watch.md) | `node scripts/verification/verify-otto.mjs run pr-watch` | Browser create/confirm/refusal/expiry + API/approval contracts; fixed external evidence |
| [Event delivery and recovery](event-delivery.md) | `node scripts/verification/verify-otto.mjs run event-delivery` | Real connector sockets/SQLite + steward contracts + finite TLC model; not a fully joined deployment |

These are the initial three features, not an inventory of all Otto functionality. Machine pairing,
directory browsing, routine creation, phone push, real coding-agent dispatch and real GitHub CI are
not accepted by this map. Other repository suites cover parts of them; add explicit journeys before
claiming user-path verification. New alternate entry points must be recorded, not silently omitted.
