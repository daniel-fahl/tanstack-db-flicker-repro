// A minimal in-memory stand-in for Postgres + Electric, so the repro runs in a
// browser tab with no backend. It speaks just enough of the Electric HTTP
// protocol for ShapeStream: the initial snapshot, live long-polls, and change
// messages that carry the txid of the write that caused them.

export interface Todo {
  id: string
  title: string
  done: boolean
}

type Message =
  | { key: string, value: Record<string, string>, headers: { operation: 'insert' | 'update', txids?: number[] } }
  | { headers: { control: 'up-to-date' } }

const HANDLE = 'repro-shape-1'
const SCHEMA = JSON.stringify({ id: { type: 'text', pk_index: 0 }, title: { type: 'text' }, done: { type: 'bool' } })

const wire = (todo: Todo) => ({ id: todo.id, title: todo.title, done: String(todo.done) })
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

export function createFakeElectric(seed: Todo[]) {
  const log: Message[] = seed.map(todo => ({ key: `"public"."todos"/"${todo.id}"`, value: wire(todo), headers: { operation: 'insert' } }))
  let nextTxid = 1000
  let wake: (() => void) | undefined

  const offsetOf = (index: number) => `${index}_0`
  const indexOf = (offset: string | null) => (offset === null || offset === '-1' ? 0 : Number(offset.split('_')[0]))

  function respond(messages: Message[], upTo: number, live: boolean): Response {
    const headers = new Headers({
      'content-type': 'application/json',
      'electric-handle': HANDLE,
      'electric-offset': offsetOf(upTo),
      'electric-schema': SCHEMA,
      'electric-up-to-date': '',
    })
    if (live) headers.set('electric-cursor', String(Date.now()))
    return new Response(JSON.stringify([...messages, { headers: { control: 'up-to-date' } }]), { status: 200, headers })
  }

  const fetchClient: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    const live = url.searchParams.get('live') === 'true'
    const from = indexOf(url.searchParams.get('offset'))

    if (live && from >= log.length) {
      const woken = new Promise<void>((resolve) => { wake = resolve })
      const aborted = new Promise<void>((resolve) => init?.signal?.addEventListener('abort', () => resolve()))
      await Promise.race([woken, aborted, sleep(20_000)])
      if (init?.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    }

    return respond(log.slice(from), log.length, live)
  }

  // Like a real backend: commit, answer the client with the txid, and let the
  // change reach the replication stream a moment later.
  async function write(todo: Todo, { operation }: { operation: 'insert' | 'update' }): Promise<number> {
    await sleep(15)
    const txid = nextTxid++
    setTimeout(() => {
      log.push({ key: `"public"."todos"/"${todo.id}"`, value: wire(todo), headers: { operation, txids: [txid] } })
      wake?.()
    }, 5)
    return txid
  }

  return { fetchClient, write }
}
