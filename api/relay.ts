/**
 * Vercel Function: jednoduchý „přeposílač“ zpráv mezi hostitelem (projektor) a hráči (mobily).
 *
 * Hostitel dál řídí celou hru. Server jen drží:
 *  - ak:<PIN>:meta   tajný klíč hostitele (aby do hry nemohl zapisovat nikdo jiný)
 *  - ak:<PIN>:views  hash „co má vidět který hráč“ (+ pole __host s časem posledního kontaktu hostitele)
 *  - ak:<PIN>:inbox  frontu zpráv od hráčů (přihlášení, odpovědi, reakce)
 *
 * Data se ukládají do Upstash Redis (Vercel → Storage). Bez databáze vrací relay:false
 * a web se automaticky přepne na přímé spojení přes PeerJS. Při lokálním vývoji (npm run dev)
 * se použije úložiště v paměti.
 */

const TTL = 6 * 3600
const INBOX_TTL = 3600
const HOST_FIELD = '__host'
const MAX_BODY = 256 * 1024

type Cmd = (string | number)[]

interface Store {
  run(cmds: Cmd[]): Promise<unknown[]>
}

// ---------- Upstash Redis přes REST ----------

function upstashStore(url: string, token: string): Store {
  const base = url.replace(/\/+$/, '')
  return {
    async run(cmds) {
      const res = await fetch(`${base}/pipeline`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(cmds.map((c) => c.map(String))),
      })
      if (!res.ok) throw new Error(`Upstash HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
      const out = (await res.json()) as { result?: unknown; error?: string }[]
      return out.map((r) => {
        if (r.error) throw new Error(`Upstash: ${r.error}`)
        return r.result
      })
    },
  }
}

// ---------- Úložiště v paměti (jen pro lokální vývoj) ----------

interface MemEntry {
  v: string | Map<string, string> | string[]
  exp: number
}

function memoryStore(): Store {
  const g = globalThis as unknown as { __akMem?: Map<string, MemEntry> }
  const m = (g.__akMem ??= new Map())
  const get = (k: string) => {
    const e = m.get(k)
    if (e && e.exp && e.exp < Date.now()) {
      m.delete(k)
      return undefined
    }
    return e
  }
  const exec = (c: Cmd): unknown => {
    const [op, key, ...a] = c.map(String)
    const e = get(key)
    switch (op.toUpperCase()) {
      case 'GET':
        return e && typeof e.v === 'string' ? e.v : null
      case 'SET': {
        const nx = a.includes('NX')
        const exIdx = a.indexOf('EX')
        if (nx && e) return null
        m.set(key, { v: a[0], exp: exIdx >= 0 ? Date.now() + Number(a[exIdx + 1]) * 1000 : 0 })
        return 'OK'
      }
      case 'EXPIRE':
        if (!e) return 0
        e.exp = Date.now() + Number(a[0]) * 1000
        return 1
      case 'HSET': {
        const h = e && e.v instanceof Map ? e.v : new Map<string, string>()
        if (!e) m.set(key, { v: h, exp: 0 })
        let added = 0
        for (let i = 0; i < a.length; i += 2) {
          if (!h.has(a[i])) added++
          h.set(a[i], a[i + 1])
        }
        return added
      }
      case 'HMGET': {
        const h = e && e.v instanceof Map ? e.v : null
        return a.map((f) => h?.get(f) ?? null)
      }
      case 'HDEL': {
        const h = e && e.v instanceof Map ? e.v : null
        return a.filter((f) => h?.delete(f)).length
      }
      case 'RPUSH': {
        const l = e && Array.isArray(e.v) ? e.v : []
        if (!e) m.set(key, { v: l, exp: 0 })
        l.push(...a)
        return l.length
      }
      case 'LPOP': {
        const l = e && Array.isArray(e.v) ? e.v : null
        if (!l || !l.length) return null
        const n = a.length ? Number(a[0]) : 1
        const out = l.splice(0, n)
        if (!l.length) m.delete(key)
        return a.length ? out : out[0]
      }
      case 'DEL':
        return [key, ...a].filter((k) => m.delete(k)).length
      default:
        throw new Error(`Nepodporovaný příkaz ${op}`)
    }
  }
  return {
    async run(cmds) {
      return cmds.map(exec)
    },
  }
}

/**
 * Najde přístup k Upstash Redis. Vercel ho podle způsobu připojení pojmenuje
 * KV_REST_API_URL/KV_REST_API_TOKEN nebo UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN,
 * případně s vlastní předponou (např. KVIZ_KV_REST_API_URL).
 */
function findUpstash(env: Record<string, string | undefined>): { url: string; token: string } | null {
  for (const [suffixUrl, suffixToken] of [
    ['KV_REST_API_URL', 'KV_REST_API_TOKEN'],
    ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'],
  ]) {
    const keys = Object.keys(env)
      .filter((key) => key === suffixUrl || key.endsWith('_' + suffixUrl))
      .sort((a, b) => a.length - b.length)
    for (const key of keys) {
      const prefix = key.slice(0, key.length - suffixUrl.length)
      const url = env[key]
      const token = env[prefix + suffixToken]
      if (url && token && /^https:\/\//.test(url)) return { url, token }
      if (url && token && !env.VERCEL) return { url, token }
    }
  }
  return null
}

function getStore(): Store | null {
  const env = process.env
  // Jen pro testy: vypne relay a hra použije přímé spojení.
  if (env.RELAY_DISABLED) return null
  const creds = findUpstash(env)
  if (creds) return upstashStore(creds.url, creds.token)
  // Na Vercelu bez databáze relay nenabízíme (paměť se mezi instancemi nesdílí).
  if (env.VERCEL) return null
  return memoryStore()
}

// ---------- pomocné ----------

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  })

const isPin = (p: unknown): p is string => typeof p === 'string' && /^\d{6}$/.test(p)
const isId = (p: unknown): p is string => typeof p === 'string' && p.length > 0 && p.length <= 64 && p !== HOST_FIELD
const k = (pin: string, part: 'meta' | 'views' | 'inbox') => `ak:${pin}:${part}`

function randomSecret() {
  const b = new Uint8Array(18)
  crypto.getRandomValues(b)
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
}

function randomPin() {
  const b = new Uint32Array(1)
  crypto.getRandomValues(b)
  return String(100000 + (b[0] % 900000))
}

// Ověřené klíče hostitelů si instance pamatuje, ať se databáze neptá při každém dotazu.
const verified = new Map<string, number>()

async function checkHost(store: Store, pin: string, secret: unknown): Promise<boolean> {
  if (typeof secret !== 'string' || !secret) return false
  const cacheKey = `${pin}:${secret}`
  if ((verified.get(cacheKey) ?? 0) > Date.now()) return true
  const [stored] = await store.run([['GET', k(pin, 'meta')]])
  if (stored !== secret) return false
  verified.set(cacheKey, Date.now() + 60_000)
  return true
}

// ---------- operace ----------

type Body = Record<string, unknown>

async function handle(store: Store, b: Body): Promise<Response> {
  const now = Date.now()
  switch (b.op) {
    case 'health':
      return json({ relay: true, now })

    // Hostitel založí místnost (nebo obnoví tu svoji po načtení stránky).
    case 'create': {
      if (isPin(b.pin) && typeof b.secret === 'string' && b.secret) {
        const [stored] = await store.run([['GET', k(b.pin, 'meta')]])
        if (stored === b.secret) {
          await store.run([['EXPIRE', k(b.pin, 'meta'), TTL]])
          return json({ pin: b.pin, secret: b.secret, now, resumed: true })
        }
        if (stored == null) {
          const [ok] = await store.run([['SET', k(b.pin, 'meta'), b.secret, 'NX', 'EX', TTL]])
          if (ok === 'OK') return json({ pin: b.pin, secret: b.secret, now, resumed: true })
        }
      }
      const secret = randomSecret()
      for (let i = 0; i < 12; i++) {
        const pin = randomPin()
        const [ok] = await store.run([['SET', k(pin, 'meta'), secret, 'NX', 'EX', TTL]])
        if (ok === 'OK') {
          await store.run([['HSET', k(pin, 'views'), HOST_FIELD, String(now)], ['EXPIRE', k(pin, 'views'), TTL]])
          return json({ pin, secret, now, resumed: false })
        }
      }
      return json({ error: 'Nepodařilo se vytvořit hru, zkus to znovu.' }, 503)
    }

    // Hostitel zapíše, co mají vidět hráči, a vyzvedne jejich zprávy.
    case 'sync': {
      if (!isPin(b.pin)) return json({ error: 'bad-pin' }, 400)
      if (!(await checkHost(store, b.pin, b.secret))) return json({ error: 'forbidden' }, 403)
      const cmds: Cmd[] = []
      const slots = (b.slots && typeof b.slots === 'object' ? b.slots : {}) as Record<string, unknown>
      const pairs: string[] = [HOST_FIELD, String(now)]
      for (const [id, slot] of Object.entries(slots)) if (isId(id) && typeof slot === 'string') pairs.push(id, slot)
      cmds.push(['HSET', k(b.pin, 'views'), ...pairs])
      if (Array.isArray(b.remove) && b.remove.length) cmds.push(['HDEL', k(b.pin, 'views'), ...b.remove.filter(isId)])
      cmds.push(['LPOP', k(b.pin, 'inbox'), 200])
      // Prodloužení platnosti stačí jednou za čas, šetří to příkazy databáze.
      if (b.touch) cmds.push(['EXPIRE', k(b.pin, 'views'), TTL], ['EXPIRE', k(b.pin, 'meta'), TTL])
      const out = await store.run(cmds)
      const popped = out[cmds.findIndex((c) => c[0] === 'LPOP')]
      const inbox = Array.isArray(popped) ? popped : popped ? [popped] : []
      return json({ now, inbox })
    }

    // Hráč pošle zprávu hostiteli (server ji opatří časem přijetí).
    case 'send': {
      if (!isPin(b.pin) || !isId(b.playerId)) return json({ error: 'bad-request' }, 400)
      const msg = b.msg
      if (!msg || typeof msg !== 'object') return json({ error: 'bad-request' }, 400)
      const entry = JSON.stringify({ from: b.playerId, at: now, msg })
      const [vals] = (await store.run([
        ['HMGET', k(b.pin, 'views'), HOST_FIELD],
        ['RPUSH', k(b.pin, 'inbox'), entry],
        ['EXPIRE', k(b.pin, 'inbox'), INBOX_TTL],
      ])) as (string | null)[][]
      if (vals[0] == null) return json({ error: 'no-room' }, 404)
      return json({ now })
    }

    // Hráč se ptá, co má zobrazit.
    case 'poll': {
      if (!isPin(b.pin) || !isId(b.playerId)) return json({ error: 'bad-request' }, 400)
      const [vals] = (await store.run([['HMGET', k(b.pin, 'views'), HOST_FIELD, b.playerId]])) as (string | null)[][]
      if (vals[0] == null) return json({ error: 'no-room' }, 404)
      return json({ now, hostSeen: Number(vals[0]), slot: vals[1] })
    }

    default:
      return json({ error: 'unknown-op' }, 400)
  }
}

export async function GET(): Promise<Response> {
  return json({ relay: getStore() !== null, now: Date.now() })
}

export async function POST(request: Request): Promise<Response> {
  const store = getStore()
  if (!store) return json({ relay: false, error: 'no-store' }, 503)
  let body: Body
  try {
    const text = await request.text()
    if (text.length > MAX_BODY) return json({ error: 'too-large' }, 413)
    body = JSON.parse(text) as Body
  } catch {
    return json({ error: 'bad-json' }, 400)
  }
  try {
    return await handle(store, body)
  } catch (e) {
    console.error('relay error', e)
    return json({ error: 'store-error' }, 502)
  }
}
