import type { Row } from '@electric-sql/client'
import type { ElectricCollectionUtils } from '@tanstack/electric-db-collection'
import {
  BrowserCollectionCoordinator,
  createBrowserWASQLitePersistence,
  openBrowserWASQLiteOPFSDatabase,
  persistedCollectionOptions,
} from '@tanstack/browser-db-sqlite-persistence'
import { createCollection } from '@tanstack/db'
import { electricCollectionOptions } from '@tanstack/electric-db-collection'
import { startOfflineExecutor } from '@tanstack/offline-transactions'
import { createFakeElectric, type Todo } from './fake-electric'

const params = new URLSearchParams(location.search)
const withPersistence = params.get('persistence') !== 'off'
const viaOutbox = params.get('via') === 'outbox'
const settleMs = Number(params.get('settle') ?? 0)

type TodoRow = Todo & Row<unknown>
type Operation = 'insert' | 'update'

const server = createFakeElectric([{ id: 'seed', title: 'Buy milk', done: false }])
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function send(operation: Operation, todo: Todo) {
  const txid = await server.write(todo, { operation })
  await todos.utils.awaitTxId(txid)
  if (settleMs) await sleep(settleMs)
}

const electric = electricCollectionOptions<TodoRow>({
  id: 'todos',
  shapeOptions: { url: `${location.origin}/fake-electric/v1/shape`, params: { table: 'todos' }, fetchClient: server.fetchClient },
  getKey: todo => todo.id,
  ...(viaOutbox
    ? {}
    : {
        onInsert: ({ transaction }) => send('insert', transaction.mutations[0]!.modified),
        onUpdate: ({ transaction }) => send('update', transaction.mutations[0]!.modified),
      }),
})

async function persisted() {
  // A fresh database per page load, so a stored resume offset never meets the
  // fake server's fresh log.
  const name = `repro-${crypto.randomUUID()}`
  const database = await openBrowserWASQLiteOPFSDatabase({ databaseName: `${name}.sqlite` })
  const persistence = createBrowserWASQLitePersistence({ database, coordinator: new BrowserCollectionCoordinator({ dbName: name }) })
  return persistedCollectionOptions<TodoRow, string | number, never, ElectricCollectionUtils<TodoRow>>({ ...electric, persistence, schemaVersion: 1 })
}

const todos = withPersistence ? createCollection(await persisted()) : createCollection(electric)
await todos.toArrayWhenReady()

const outbox = viaOutbox
  ? startOfflineExecutor({
      collections: { todos },
      mutationFns: {
        send: ({ transaction }) => {
          const [mutation] = transaction.mutations
          return send(mutation!.type as Operation, mutation!.modified as unknown as Todo)
        },
      },
    })
  : undefined
await outbox?.waitForInit()

function viaOutboxWrite(executor: NonNullable<typeof outbox>, fn: () => void): Promise<unknown> {
  const tx = executor.createOfflineTransaction({ mutationFnName: 'send', autoCommit: false })
  const done = tx.mutate(fn).isPersisted.promise
  return tx.commit().then(() => done)
}

const insert = (todo: Todo) => outbox
  ? viaOutboxWrite(outbox, () => todos.insert(todo as TodoRow))
  : todos.insert(todo as TodoRow).isPersisted.promise

const update = (id: string, fn: (draft: Todo) => void) => outbox
  ? viaOutboxWrite(outbox, () => todos.update(id, fn))
  : todos.update(id, fn).isPersisted.promise

type State = 'missing' | 'unticked' | 'ticked'
const RANK: Record<State, number> = { missing: 0, unticked: 1, ticked: 2 }
const stateOf = (id: string): State => {
  const todo = todos.get(id)
  return todo === undefined ? 'missing' : todo.done ? 'ticked' : 'unticked'
}

function record(id: string) {
  const trail: { state: State, at: number }[] = [{ state: stateOf(id), at: performance.now() }]
  const subscription = todos.subscribeChanges(() => {
    const state = stateOf(id)
    if (trail.at(-1)!.state !== state) trail.push({ state, at: performance.now() })
  })
  return () => {
    subscription.unsubscribe()
    return trail
  }
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const log = $<HTMLOListElement>('log')

const currentMode = !withPersistence ? 'persistence-off' : settleMs ? 'settle' : viaOutbox ? 'outbox' : 'default'
document.querySelector(`tr[data-mode="${currentMode}"]`)?.classList.add('current')

$('mode').textContent = [
  `SQLite persistence ${withPersistence ? 'ON' : 'OFF'}`,
  viaOutbox ? 'writes through @tanstack/offline-transactions' : 'writes through onInsert/onUpdate',
  settleMs ? `workaround: wait ${settleMs} ms after awaitTxId` : '',
].filter(Boolean).join(', ')

let runs = 0
let flickers = 0
let longest = 0

async function addAndTick() {
  const id = crypto.randomUUID()
  const stop = record(id)
  const startedAt = performance.now()

  const inserted = insert({ id, title: `Todo ${runs + 1}`, done: false })
  const ticked = update(id, (draft) => { draft.done = true })
  await Promise.all([inserted, ticked])
  await sleep(400)
  const trail = stop()

  runs++
  let best = 0
  let droppedAt: number | undefined
  let gap = 0
  for (const { state, at } of trail) {
    if (RANK[state] < best && droppedAt === undefined) droppedAt = at
    if (RANK[state] >= best && droppedAt !== undefined) {
      gap = Math.max(gap, at - droppedAt)
      droppedAt = undefined
    }
    best = Math.max(best, RANK[state])
  }

  const line = trail.map(({ state, at }) => `${state} +${Math.round(at - startedAt)} ms`).join('  →  ')
  const item = document.createElement('li')
  if (gap > 0) {
    flickers++
    longest = Math.max(longest, gap)
    item.className = 'bad'
    item.textContent = `FLICKER, ${Math.round(gap)} ms back on an older state:  ${line}`
  }
  else {
    item.textContent = line
  }
  log.prepend(item)
  $('stats').textContent = `${flickers} of ${runs} runs flickered${flickers ? `, longest ${Math.round(longest)} ms` : ''}`
}

const buttons = [...document.querySelectorAll('button')]
async function run(count: number) {
  buttons.forEach((b) => { b.disabled = true })
  for (let i = 0; i < count; i++) await addAndTick()
  buttons.forEach((b) => { b.disabled = false })
}

$('once').addEventListener('click', () => run(1))
$('many').addEventListener('click', () => run(30))
