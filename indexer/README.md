# Prism Indexer

An optional indexer that polls Soroban RPC and persists contract deployments, invocations (including successful return values), storage changes, and events into PostgreSQL. It removes the RPC node's ~24-hour retention limit and enables full storage-key enumeration — neither of which is possible with plain RPC access.

## Quick Start

```bash
cd indexer
npm install

# Set the required database connection string and Soroban RPC endpoint
export DATABASE_URL="postgresql://user:password@localhost:5432/prism"
export SOROBAN_RPC_URL="https://soroban-testnet.stellar.org"

# Generate the Prisma client and run migrations
npm run prisma:generate
npm run prisma:migrate

# Start the indexer (watch mode)
npm run dev
```

To index a historical ledger range, run:

```bash
npm run backfill -- --from 1000 --to 2000
```

The backfill uses the same transaction processor as live indexing. Its progress is checkpointed in PostgreSQL after each RPC page, so rerunning the same range resumes safely after an interruption. Inserts are idempotent; a different range cannot replace an incomplete backfill. After a range is complete, a new range may be started. The requested end ledger must be available from the configured RPC node.

Or run everything together with Docker Compose from the repository root:

```bash
docker compose up
```

## Configuration

| Environment Variable | Default                              | Description                          |
| -------------------- | ------------------------------------ | ------------------------------------ |
| `DATABASE_URL`       | *(required)*                         | PostgreSQL connection string         |
| `SOROBAN_RPC_URL`    | *(required)*                         | Soroban RPC endpoint to poll        |
| `POLL_INTERVAL_MS`   | `5000`                               | Milliseconds between poll cycles     |
| `HEALTH_PORT`        | `8080`                               | Port for the `GET /healthz` endpoint |
| `HEALTH_MAX_LEDGER_LAG` | `60`                              | Ledgers behind the network before `/healthz` returns 503 |
| `INDEXER_START_LEDGER` | *(latest ledger)*                  | First ledger to index on a fresh database; must be inside the RPC node's retention window. Ignored once a cursor exists |

## How It Works

1. On first run, the live indexer seeds a cursor (`IndexerCursor`) at the current latest ledger, or just before `INDEXER_START_LEDGER` if set. **No historical backfill is performed automatically.**
2. Each poll cycle fetches new transactions from the RPC node, processes them in pages of 50, and advances the cursor.
3. Both live indexing and backfill use RPC transaction cursors to safely paginate across pages, including pages that split a ledger.
4. Processing is idempotent — `skipDuplicates` on insert means a crash-before-cursor-advance is safe to replay.

### Cursor Model

The live cursor is a single row (`id = 1`) tracking the last processed ledger and RPC page position. Live indexing remains forward-only; use the backfill command to load historical ranges. Backfill progress is tracked independently in `BackfillCursor`, allowing it to coexist with the live cursor.

## Tables

### `indexer_cursor`
Singleton row (id always 1) tracking how far the indexer has processed.

| Column      | Type     | Description                    |
| ----------- | -------- | ------------------------------ |
| `lastLedger` | `Int`   | Last processed ledger          |
| `paginationCursor` | `String?` | RPC page position when a ledger has more transactions |
| `updatedAt`  | `DateTime` | Last cursor advance time     |

### `invocations`
One row per Soroban contract function invocation.

| Column         | Type      | Description                           |
| -------------- | --------- | ------------------------------------- |
| `txHash`       | `String`  | Transaction hash (unique)             |
| `ledger`       | `Int`     | Ledger sequence number                |
| `contractId`   | `String`  | Contract address                      |
| `functionName` | `String`  | Invoked function name                 |
| `args`         | `Json`    | Decoded arguments                     |
| `successful`   | `Boolean` | Whether the invocation succeeded      |
| `sourceAccount`| `String`  | Transaction source account            |
| `returnValue`  | `String?` | Decoded return value for a successful invocation |

### `contracts`
One row per observed contract deployment.

| Column             | Type     | Description                         |
| ------------------ | -------- | ----------------------------------- |
| `contractId`       | `String` | Deployed contract address           |
| `creator`          | `String` | Transaction source account          |
| `deploymentLedger` | `Int`    | Ledger sequence of the deployment   |
| `deploymentTxHash` | `String` | Transaction that deployed the contract |

### `backfill_cursor`
Singleton row tracking the active (or most recently completed) fixed-range backfill, including its RPC pagination cursor.

### `storage_changes`
Append-only log of every observed change to a contract storage entry. The "current value" for a key is its most recent non-removed row — this is what makes full key enumeration possible.

| Column        | Type     | Description                                      |
| ------------- | -------- | ------------------------------------------------ |
| `contractId`  | `String` | Contract address                                 |
| `durability`  | `String` | `persistent` / `temporary` / `instance`          |
| `keyDisplay`  | `String` | Human-readable decoded key                       |
| `valueDisplay`| `String` | Decoded value (null when removed)                |
| `changeType`  | `String` | `created` / `updated` / `removed` / `state`      |
| `ledger`      | `Int`    | Ledger sequence number                           |
| `txHash`      | `String` | Transaction hash                                 |

### `contract_event_records`
One row per contract event emitted.

| Column       | Type     | Description                    |
| ------------ | -------- | ------------------------------ |
| `eventId`    | `String` | Unique event identifier        |
| `contractId` | `String` | Contract address               |
| `type`       | `String` | Event type                     |
| `topic`      | `Json`   | Event topics                   |
| `value`      | `String` | Event value (decoded)          |

### `indexer_gaps`
One row per ledger range the live indexer skipped without indexing, because the RPC node's retention window had already passed the cursor. Gaps apply to every contract. The frontend returns them as `historyGaps` from `GET /api/contract/{id}`.

| Column        | Type     | Description                          |
| ------------- | -------- | ------------------------------------ |
| `fromLedger`  | `Int`    | First ledger skipped                 |
| `toLedger`    | `Int`    | Last ledger skipped                  |
| `reason`      | `String` | Why the range was skipped            |

## Failure Behaviour

- **Crash before cursor advance**: Safe. The next run reprocesses the same page; `skipDuplicates` prevents double-inserts.
- **RPC unreachable**: The indexer retries with exponential backoff and jitter (1s doubling to a 60s cap) and resets once a poll succeeds. No data is lost — the cursor only advances after successful processing.
- **Database unreachable**: The indexer throws and exits. Restart after the database is available; the cursor is preserved.
- **SIGTERM / SIGINT**: The indexer finishes the page it is processing, saves the cursor, disconnects Prisma, and exits. A second signal exits immediately.

## Health Endpoint

`GET /healthz` on `HEALTH_PORT` returns the indexer's state as JSON:

```json
{ "healthy": true, "cursor": 1234, "latestLedger": 1236, "lag": 2, "lastPollFailed": false }
```

It returns `200` when the last poll succeeded and `lag` (`latestLedger - cursor`) is at most `HEALTH_MAX_LEDGER_LAG`. Otherwise it returns `503`. The Compose file uses this endpoint for the indexer's healthcheck.

## Retention Gap

Live indexing starts at the ledger current on first launch. Historical data can be loaded separately with the backfill command, subject to the configured RPC node's available history. Data outside the live start point and any completed backfill ranges remains unindexed.

## Running Tests

```bash
cd indexer
npm test
```

Tests cover the XDR decoder (`decode.test.ts`) — the most correctness-critical component, which turns raw transaction envelopes into typed invocation/storage/event records.
