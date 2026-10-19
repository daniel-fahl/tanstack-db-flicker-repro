# TanStack DB: a confirmed write flickers back with SQLite persistence

An Electric collection with `persistedCollectionOptions` inserts a row and updates it right away. Both handlers await `awaitTxId`. After the update is confirmed, the collection shows the pre-update state for 10–30 ms, then the updated state again. Without persistence, this never happens.

**Open it:** [StackBlitz](https://stackblitz.com/github/daniel-fahl/tanstack-db-flicker-repro), or run `pnpm install && pnpm dev` and open the page. Click **Add and tick 30 times**.

## Where we hit it

We build a shopping list app with this stack. A user adds an item and ticks it off. The tick disappears for a moment, then comes back. An action that runs during that gap reads the old state: "clear bought items" saw the item as not bought and left it on the list. With 10× CPU throttling, the gap reached 263 ms in our app.

## Modes

Each mode is its own page load.

| Mode | URL | What changes | Result for us |
| --- | --- | --- | --- |
| The bug | `?` | SQLite persistence on. Writes go through `onInsert` and `onUpdate`, which send the change and await `awaitTxId`. | 30 of 30 runs flicker. |
| Control | `?persistence=off` | The same code without `persistedCollectionOptions`. | 0 of 30. |
| Our workaround | `?settle=150` | Persistence on. The handler waits 150 ms after `awaitTxId` resolves. | 0 of 30. |
| Outbox | `?via=outbox` | Persistence on. Writes go through `@tanstack/offline-transactions`, as in our app. | Mostly 0 of 30. The outbox sends one write at a time, so the update leaves only after the insert is confirmed and stored. It flickers when storing takes longer than that round trip. Our app has 9 collections in one database, and there a store took 64 ms. |

Each run inserts a new todo and updates `done` to `true` without waiting in between. The page records every state the collection shows for that todo. A run flickers when the state steps back:

```
missing +0 ms → unticked +0 ms → ticked +0 ms → unticked +24 ms → ticked +41 ms
```

## What we traced

We added timing logs to the libraries in our app. A flickering run goes like this:

1. The insert's synced transaction is stored in SQLite before it becomes visible. The store holds the runtime's `applyMutex`.
2. The update's txid arrives during that store. `lifecycle.publishEvidence` runs right after `commitSourceTransaction()`, so `awaitTxId` resolves.
3. The update's synced transaction still waits for `applyMutex`. It is not in `pendingSyncedTransactions` yet.
4. `onUpdate` returns and the transaction completes. `recomputeOptimisticState` holds optimistic rows only for keys in a committed pending synced transaction, so the update's optimistic row is dropped.
5. The collection shows the pre-update state until the update's synced transaction is stored and applied.

A log from our app, in ms since page load:

```
awaitTxId(51391) resolved at 1194.7   list_items pendingSyncedTransactions: none
applyMutex: insert's store held 1149 → 1212; update's store waited 17.9 ms
optimistic row dropped, DOM shows unticked at 1203.2
DOM shows ticked again at 1218.0
```

## Setup

- One `todos` collection: `electricCollectionOptions` inside `persistedCollectionOptions`, with `createBrowserWASQLitePersistence` on OPFS.
- A fake Electric server runs in the page (`src/fake-electric.ts`). It answers the shape protocol from memory and returns a txid for each write, so no backend is needed. Each write takes 15 ms, and its change reaches the stream 5 ms after the txid.
- Every page load opens a fresh SQLite database.

## Versions

`@tanstack/db` 0.15.1, `@tanstack/electric-db-collection` 0.6.2, `@tanstack/browser-db-sqlite-persistence` 0.2.36, `@tanstack/offline-transactions` 1.1.3, `@electric-sql/client` 1.5.28. The result is the same on `@tanstack/db` 0.13.0 with `@tanstack/electric-db-collection` 0.5.9.
