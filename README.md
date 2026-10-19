# awaitTxId flicker with SQLite persistence

A confirmed write briefly shows an older state when an Electric collection uses SQLite persistence.

## Run it

```bash
pnpm install
pnpm dev
```

Open the page, then click **Add and tick 30 times**.

## What it does

- One `todos` collection: `electricCollectionOptions`, wrapped in `persistedCollectionOptions` with `createBrowserWASQLitePersistence` (SQLite on OPFS, the browser's private file system).
- A fake Electric server runs inside the page (`src/fake-electric.ts`). It stands in for Postgres and Electric, so the repro needs no backend.
- `onInsert` and `onUpdate` send the change to the fake server, then `await collection.utils.awaitTxId(txid)`.
- Each run inserts a new todo and ticks it right away. The page records every state the collection shows for that todo: missing → unticked → ticked. A flicker is a step back to an older state.

## Result

| Mode | Runs that flicker |
| --- | --- |
| Persistence on (`?`) | 30 of 30 |
| Persistence off (`?persistence=off`) | 0 of 30 |
| Persistence on, wait 150 ms after `awaitTxId` (`?settle=150`) | 0 of 30 |

A typical flicker: `missing +0 ms → unticked +0 ms → ticked +1 ms → unticked +27 ms → ticked +42 ms`.

`?via=outbox` sends the writes through `@tanstack/offline-transactions` instead. It sends one write at a time, so it flickers only when storing a write in SQLite takes longer than sending the next one.

## Versions

`@tanstack/db` 0.15.1, `@tanstack/electric-db-collection` 0.6.2, `@tanstack/browser-db-sqlite-persistence` 0.2.36, `@tanstack/offline-transactions` 1.1.3, `@electric-sql/client` 1.5.28. These were the latest releases on 2026-10-19.

The same result shows on `@tanstack/db` 0.15.0 with `@tanstack/electric-db-collection` 0.6.1, and on 0.13.0 with 0.5.9.
