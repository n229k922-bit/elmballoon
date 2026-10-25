# Storage usage reduction (2026-10-26)

## Implemented

- Legacy explicit order-start messages (`注文したい`, `注文担当を呼び出します`) no longer read KV to decide whether an order may be created. That decision is already true regardless of session state. This removes one KV read for each matching event. Reply processing still reads fresh state and writes with the existing 14-day TTL.
- Pending-change notifications and subsequent recording reuse the customer names already read in the same recordCustomerMessage call, removing one D1 primary-key lookup in that path. This is not a cross-request cache.
- Migration 0019 adds an `(action, result)` audit index. The notification-success lookup and all three correlated audit subqueries in legacy retry maintenance use this index instead of scanning audit history. Query-plan tests use 10,000 audit rows and verify identical lookup results. Existing migration rehearsals verify preserved table contents and relationships.

## Limits and rollout

No deployment, remote migration, LINE send, production setting or main-branch change is part of this work. The D1 benefit requires applying 0019 to the intended database in a separately authorized rollout. Index creation consumes database resources; the index adds storage and maintenance work to audit writes. Validate these costs against actual account metrics before rollout.

The KV read saving applies to legacy explicit order starts, not all LINE events or v2 intake. The D1 name lookup saving applies when pendingChanges is nonempty. No account-wide percentage saving is claimed; Cloudflare usage metrics and the deployed engine remain unverified.

TTL refreshes, KV writes, confirmation gates, delayed message bundle reads, and public API freshness are preserved. No long-lived cache or broad state-store migration is introduced. In particular, sharing a session snapshot across network calls could miss concurrent messages, so the reply-time read is retained.

## Validation

The 26 Node command groups in validate-worker.yml were run locally. 25 passed immediately; the migration rehearsal correctly required explicitly listing the new migration. After adding 0019 to that list, the remaining group passed all 25 tests. The new storage suite passes 4 tests. Syntax and whitespace checks also pass. External LINE and Cloudflare services were not used by this validation.

Run `node --test tools/test-storage-usage.mjs` for the targeted checks. CI includes this command alongside the existing regression suite.
