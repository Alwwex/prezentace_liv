import Peer, { type DataConnection } from 'peerjs'
import { hostPeerId, peerOptions, randomPin } from './net'
import { later } from './ticker'
import type { ClientMsg, HostMsg, PlayerView } from './types'

/**
 * Spojení mezi hostitelem a hráči. Jsou dvě varianty:
 *  - 'relay': přes server webu (Vercel Function /api/relay + databáze Upstash Redis).
 *     Funguje na každé síti, kde jde otevřít web, protože je to obyčejné HTTPS.
 *  - 'p2p': přímé spojení přes WebRTC (PeerJS). Použije se, když server nemá databázi.
 */
export type LinkKind = 'relay' | 'p2p'
export type LinkStatus = 'connecting' | 'ready' | 'error'

const API = '/api/relay'

export class RelayError extends Error {
  constructor(
    public status: number,
    public code: string,
  ) {
    super(code)
  }
}

async function api<T>(body: object, timeoutMs = 10000): Promise<T> {
  const ctrl = new AbortController()
  const timer = window.setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
      signal: ctrl.signal,
    })
    const data = (await res.json().catch(() => ({}))) as { error?: string }
    if (!res.ok) throw new RelayError(res.status, data.error ?? `http-${res.status}`)
    return data as T
  } catch (e) {
    if (e instanceof RelayError) throw e
    throw new RelayError(0, 'network')
  } finally {
    window.clearTimeout(timer)
  }
}

export type RelayState = 'yes' | 'no' | 'unknown'

let relayYes = false

/**
 * Je k dispozici spojení přes server? 'no' jen při jednoznačné odpovědi (web nemá databázi,
 * databáze nefunguje, nebo /api/relay vůbec neexistuje). Při výpadku sítě vrací 'unknown',
 * aby se hra kvůli chvilkovému zakolísání Wi-Fi nepřepnula na přímé spojení.
 */
export async function relayStatus(): Promise<RelayState> {
  if (relayYes) return 'yes'
  try {
    const ctrl = new AbortController()
    const timer = window.setTimeout(() => ctrl.abort(), 6000)
    const res = await fetch(API, { cache: 'no-store', signal: ctrl.signal })
    window.clearTimeout(timer)
    if (res.status === 404 || res.status === 405) return 'no'
    if (!res.ok) return 'unknown'
    let data: { relay?: boolean }
    try {
      data = (await res.json()) as { relay?: boolean }
    } catch {
      return 'no' // místo API přišla HTML stránka (statický hosting bez funkcí)
    }
    if (data.relay) relayYes = true
    return data.relay ? 'yes' : 'no'
  } catch {
    return 'unknown'
  }
}

/** Opakuje relayStatus(), dokud nepřijde jednoznačná odpověď. */
export async function waitRelayStatus(onWaiting: () => void, isCancelled: () => boolean): Promise<boolean> {
  for (let i = 0; ; i++) {
    const st = await relayStatus()
    if (st !== 'unknown') return st === 'yes'
    if (isCancelled()) return false
    onWaiting()
    await wait(Math.min(8000, 1500 * (i + 1)))
    if (isCancelled()) return false
  }
}

// ============================================================
// Hostitel
// ============================================================

export interface HostLinkEvents {
  status(status: LinkStatus, error?: string): void
  pin(pin: string): void
  message(playerId: string, msg: ClientMsg, at: number): void
  drop(playerId: string): void
}

export interface HostLink {
  readonly kind: LinkKind
  /** Čas ve stejné časové ose, jakou dostávají hráči (u relay čas serveru). */
  now(): number
  send(playerId: string, msg: HostMsg): void
  drop(playerId: string): void
  saved(): SavedLink
  destroy(): void
}

export interface SavedLink {
  kind: LinkKind
  pin: string
  secret?: string
}

/** Co si hráč přečte ze serveru: stav přihlášení + aktuální obrazovka. */
interface Slot {
  s: 'ok' | 'rejected' | 'kicked'
  name?: string
  reason?: string
  view?: PlayerView
}

const SYNC_MS = 400
/** Když se nic neděje, ptáme se serveru méně často (šetří limit databáze). */
const SYNC_CALM_MS = 800
const SYNC_IDLE_MS = 1500
const SYNC_SLEEP_MS = 5000
const TOUCH_MS = 60_000

export class RelayHostLink implements HostLink {
  readonly kind = 'relay'
  private pin = ''
  private secret = ''
  private offset = 0
  private bestRtt = Infinity
  private slots = new Map<string, Slot>()
  private dirty = new Set<string>()
  private cancelTimer: (() => void) | null = null
  private lastActivity = Date.now()
  private inFlight = false
  private again = false
  private destroyed = false
  private lastTouch = 0
  private failures = 0

  /** Uložené spojení z minula – vracíme ho, dokud se místnost znovu nezaloží. */
  private initial: SavedLink | undefined

  constructor(
    private ev: HostLinkEvents,
    saved?: SavedLink,
  ) {
    this.initial = saved
    void this.open(saved)
  }

  now() {
    return Date.now() + this.offset
  }

  saved(): SavedLink {
    if (!this.pin && this.initial) return this.initial
    return { kind: 'relay', pin: this.pin, secret: this.secret }
  }

  send(playerId: string, msg: HostMsg) {
    const slot = this.slots.get(playerId) ?? { s: 'ok' }
    switch (msg.t) {
      case 'welcome':
        slot.s = 'ok'
        slot.name = msg.name
        break
      case 'rejected':
        slot.s = 'rejected'
        slot.reason = msg.reason
        slot.view = undefined
        break
      case 'kicked':
        slot.s = 'kicked'
        slot.view = undefined
        break
      case 'view':
        slot.view = msg.view
        break
      default:
        return
    }
    this.slots.set(playerId, slot)
    this.dirty.add(playerId)
    this.schedule(30)
  }

  drop() {
    /* u relay není co zavírat – hráč se ozve sám */
  }

  destroy() {
    this.destroyed = true
    this.cancelTimer?.()
  }

  private async open(saved?: SavedLink) {
    while (!this.destroyed) {
      try {
        const t0 = Date.now()
        const r = await api<{ pin: string; secret: string; now: number }>({
          op: 'create',
          pin: saved?.kind === 'relay' ? saved.pin : undefined,
          secret: saved?.kind === 'relay' ? saved.secret : undefined,
        })
        this.clock(t0, r.now)
        this.pin = r.pin
        this.secret = r.secret
        this.initial = { kind: 'relay', pin: r.pin, secret: r.secret }
        this.ev.pin(r.pin)
        this.ev.status('ready')
        this.lastTouch = Date.now()
        // Po obnovení stránky pošleme hráčům znovu všechno.
        this.slots.forEach((_, id) => this.dirty.add(id))
        this.schedule(0)
        return
      } catch {
        this.ev.status('error', 'Nepodařilo se spojit se serverem hry. Zkouším to znovu…')
        await wait(3000)
      }
    }
  }

  private clock(t0: number, serverNow: number) {
    const t1 = Date.now()
    const rtt = t1 - t0
    // Bereme měření s nejkratší odezvou, to je nejpřesnější.
    if (rtt <= this.bestRtt + 20) {
      this.bestRtt = Math.min(this.bestRtt, rtt)
      this.offset = serverNow - (t0 + rtt / 2)
    }
  }

  private schedule(ms: number) {
    if (this.destroyed || !this.pin) return
    if (this.inFlight) {
      this.again = true
      return
    }
    this.cancelTimer?.()
    this.cancelTimer = later(() => void this.sync(), ms)
  }

  private async sync() {
    if (this.destroyed || this.inFlight) return
    this.inFlight = true
    const ids = [...this.dirty]
    this.dirty.clear()
    const slots: Record<string, string> = {}
    for (const id of ids) {
      const s = this.slots.get(id)
      if (s) slots[id] = JSON.stringify(s)
    }
    const touch = Date.now() - this.lastTouch > TOUCH_MS
    try {
      const t0 = Date.now()
      const r = await api<{ now: number; inbox: string[] }>({ op: 'sync', pin: this.pin, secret: this.secret, slots, touch })
      this.clock(t0, r.now)
      if (touch) this.lastTouch = Date.now()
      if (this.failures) this.ev.status('ready')
      this.failures = 0
      if (r.inbox.length || ids.length) this.lastActivity = Date.now()
      for (const raw of r.inbox) {
        try {
          const e = JSON.parse(raw) as { from: string; at: number; msg: ClientMsg }
          this.ev.message(e.from, e.msg, e.at)
        } catch {
          /* poškozená zpráva */
        }
      }
    } catch (e) {
      ids.forEach((id) => this.dirty.add(id))
      this.failures++
      if (e instanceof RelayError && e.status === 403) {
        // Místnost vypršela nebo ji smazal server – založíme ji znovu se stejným PINem.
        const again: SavedLink = { kind: 'relay', pin: this.pin, secret: this.secret }
        this.initial = again
        this.inFlight = false
        this.pin = ''
        void this.open(again)
        return
      }
      if (this.failures >= 3) this.ev.status('error', 'Spojení se serverem hry kolísá. Zkouším to znovu…')
    } finally {
      this.inFlight = false
    }
    const idle = Date.now() - this.lastActivity
    const calm =
      idle > 10 * 60_000 ? SYNC_SLEEP_MS : idle > 60_000 ? SYNC_IDLE_MS : idle > 10_000 ? SYNC_CALM_MS : SYNC_MS
    const next = this.again || this.dirty.size ? 30 : this.failures ? Math.min(5000, 600 * this.failures) : calm
    this.again = false
    this.schedule(next)
  }
}

function hostToken(): string {
  const KEY = 'expres-ak-peer-token'
  try {
    let t = localStorage.getItem(KEY)
    if (!t) {
      t = Math.random().toString(36).slice(2)
      localStorage.setItem(KEY, t)
    }
    return t
  } catch {
    return Math.random().toString(36).slice(2)
  }
}

export class P2PHostLink implements HostLink {
  readonly kind = 'p2p'
  private peer: Peer | null = null
  private conns = new Map<string, DataConnection>()
  private destroyed = false
  private reopening = false
  private watchdog: number

  constructor(
    private ev: HostLinkEvents,
    private pin: string,
    /** Smí se při kolizi vylosovat nový PIN? (jen v prázdném lobby) */
    private canChangePin: () => boolean,
  ) {
    this.ev.pin(pin)
    this.openPeer()
    this.watchdog = window.setInterval(() => this.tick(), 3000)
  }

  now() {
    return Date.now()
  }

  saved(): SavedLink {
    return { kind: 'p2p', pin: this.pin }
  }

  send(playerId: string, msg: HostMsg) {
    const conn = this.conns.get(playerId)
    try {
      if (conn?.open) conn.send(msg)
    } catch {
      /* spojení se mezitím zavřelo */
    }
  }

  drop(playerId: string) {
    const conn = this.conns.get(playerId)
    this.conns.delete(playerId)
    if (conn) window.setTimeout(() => conn.close(), 300)
  }

  destroy() {
    this.destroyed = true
    window.clearInterval(this.watchdog)
    this.peer?.destroy()
  }

  private openPeer() {
    this.reopening = false
    if (this.destroyed) return
    this.ev.status('connecting')
    // Stejný token po obnovení stránky = server nám PIN hned vrátí (jinak by ho chvíli držel).
    const peer = new Peer(hostPeerId(this.pin), { ...peerOptions(), token: hostToken() })
    this.peer = peer
    peer.on('open', () => this.ev.status('ready'))
    peer.on('connection', (conn) => this.onConnection(conn))
    peer.on('disconnected', () => {
      if (this.destroyed || peer.destroyed) return
      this.ev.status('connecting')
      window.setTimeout(() => !peer.destroyed && peer.disconnected && peer.reconnect(), 1500)
    })
    peer.on('error', (err) => {
      if (this.destroyed) return
      const type = (err as { type?: string }).type
      if (type === 'unavailable-id') {
        this.reopening = true
        peer.destroy()
        const change = this.canChangePin()
        if (change) {
          this.pin = randomPin()
          this.ev.pin(this.pin)
        }
        window.setTimeout(() => this.openPeer(), change ? 200 : 3000)
        return
      }
      if (type === 'peer-unavailable') return
      if (type === 'browser-incompatible') {
        this.ev.status('error', 'Tento prohlížeč nepodporuje WebRTC. Zkus Chrome, Edge, Firefox nebo Safari.')
        return
      }
      this.ev.status('error', 'Nepodařilo se spojit se serverem PeerJS. Zkouším to znovu…')
    })
  }

  private tick() {
    if (this.destroyed || this.reopening) return
    const peer = this.peer
    if (!peer || peer.destroyed) this.openPeer()
    else if (peer.disconnected) peer.reconnect()
  }

  private onConnection(conn: DataConnection) {
    let id: string | null = null
    conn.on('data', (raw) => {
      const msg = raw as ClientMsg
      if (!msg || typeof msg !== 'object') return
      if (msg.t === 'hello') {
        const pid = String(msg.playerId || '').slice(0, 64)
        if (!pid) return
        const old = this.conns.get(pid)
        if (old && old !== conn) old.close()
        this.conns.set(pid, conn)
        id = pid
      }
      if (id) this.ev.message(id, msg, Date.now())
    })
    const lost = () => {
      if (id && this.conns.get(id) === conn) {
        this.conns.delete(id)
        this.ev.drop(id)
      }
    }
    conn.on('close', lost)
    conn.on('error', lost)
  }
}

// ============================================================
// Hráč
// ============================================================

export type PlayerLinkStatus = 'connecting' | 'connected' | 'reconnecting' | 'host-away'

export interface PlayerLinkEvents {
  status(s: PlayerLinkStatus): void
  /** hostNow = čas v časové ose hostitele, který odpovídá okamžiku přijetí (Date.now()). */
  message(msg: HostMsg, hostNow: number): void
  /** Hra neexistuje / přestala existovat. */
  missing(): void
}

export interface PlayerLink {
  readonly kind: LinkKind
  send(msg: ClientMsg): void
  /** Jak často se ptát serveru (jen relay). */
  pace(ms: number): void
  destroy(): void
}

/** Existuje hra s tímto PINem na serveru? */
export async function relayRoomExists(pin: string, playerId: string): Promise<boolean> {
  try {
    await api({ op: 'poll', pin, playerId }, 8000)
    return true
  } catch (e) {
    if (e instanceof RelayError && e.status === 404) return false
    throw e
  }
}

const HOST_AWAY_MS = 12_000

export class RelayPlayerLink implements PlayerLink {
  readonly kind = 'relay'
  private destroyed = false
  private timer = 0
  private interval = 1000
  private polling = false
  private lastSlot: string | null = null
  private lastView: string | null = null
  private welcomed = false
  private failures = 0
  private status: PlayerLinkStatus = 'connecting'
  private queue: ClientMsg[] = []
  private sending = false
  private soon = false
  private onVisible = () => {
    if (document.visibilityState === 'visible') this.pollSoon(0)
  }

  constructor(
    private pin: string,
    private playerId: string,
    private ev: PlayerLinkEvents,
  ) {
    document.addEventListener('visibilitychange', this.onVisible)
    this.pollSoon(0)
  }

  send(msg: ClientMsg) {
    this.queue.push(msg)
    void this.flush()
  }

  pace(ms: number) {
    this.interval = ms
  }

  destroy() {
    this.destroyed = true
    window.clearTimeout(this.timer)
    document.removeEventListener('visibilitychange', this.onVisible)
  }

  private setStatus(s: PlayerLinkStatus) {
    if (s !== this.status) {
      this.status = s
      this.ev.status(s)
    }
  }

  private async flush() {
    if (this.sending || this.destroyed) return
    this.sending = true
    while (this.queue.length && !this.destroyed) {
      const msg = this.queue[0]
      try {
        await api({ op: 'send', pin: this.pin, playerId: this.playerId, msg })
        this.queue.shift()
        // Po odeslání se hned zeptáme na novou obrazovku.
        if (msg.t !== 'ping' && msg.t !== 'react') this.pollSoon(150)
      } catch (e) {
        if (e instanceof RelayError && e.status === 404) {
          this.queue = []
          this.ev.missing()
          break
        }
        if (e instanceof RelayError && e.status >= 400 && e.status < 500) {
          this.queue.shift()
          continue
        }
        // Výpadek sítě: ping a reakce zahodíme, důležité zprávy zkusíme znovu.
        if (msg.t === 'ping' || msg.t === 'react') this.queue.shift()
        await wait(1500)
      }
    }
    this.sending = false
  }

  private pollSoon(ms: number) {
    if (this.destroyed) return
    if (this.polling) {
      this.soon = true
      return
    }
    window.clearTimeout(this.timer)
    this.timer = window.setTimeout(() => void this.poll(), ms)
  }

  private async poll() {
    if (this.destroyed || this.polling) return
    this.polling = true
    let next = this.interval
    try {
      const r = await api<{ now: number; hostSeen: number; slot: string | null }>({
        op: 'poll',
        pin: this.pin,
        playerId: this.playerId,
      })
      this.failures = 0
      const away = r.now - r.hostSeen > HOST_AWAY_MS
      if (r.slot && r.slot !== this.lastSlot) {
        this.lastSlot = r.slot
        const slot = JSON.parse(r.slot) as Slot
        if (slot.s === 'rejected') this.ev.message({ t: 'rejected', reason: slot.reason ?? 'Připojení odmítnuto.' }, r.now)
        else if (slot.s === 'kicked') this.ev.message({ t: 'kicked' }, r.now)
        else {
          if (!this.welcomed && slot.name) {
            this.welcomed = true
            this.ev.message({ t: 'welcome', playerId: this.playerId, name: slot.name }, r.now)
          }
          const v = slot.view ? JSON.stringify(slot.view) : null
          if (slot.view && v !== this.lastView) {
            this.lastView = v
            this.ev.message({ t: 'view', view: slot.view, now: r.now }, r.now)
          }
        }
      }
      this.setStatus(away ? 'host-away' : this.welcomed ? 'connected' : 'connecting')
    } catch (e) {
      if (e instanceof RelayError && e.status === 404) {
        this.ev.missing()
        this.polling = false
        return
      }
      this.failures++
      if (this.welcomed) this.setStatus('reconnecting')
      next = Math.min(5000, 800 * this.failures)
    }
    this.polling = false
    if (this.soon) {
      this.soon = false
      next = Math.min(next, 100)
    }
    this.pollSoon(next)
  }
}

const OPEN_TIMEOUT = 12_000
const GONE_AFTER = 45_000

export class P2PPlayerLink implements PlayerLink {
  readonly kind = 'p2p'
  private peer: Peer | null = null
  private conn: DataConnection | null = null
  private destroyed = false
  private lastHeard = 0
  private retryTimer = 0
  private openTimer = 0
  private pingTimer: number
  private connected = false
  /** Zprávy, které se nesmí ztratit (odpověď) – pošlou se po znovupřipojení. */
  private pending: ClientMsg[] = []
  private failedAttempts = 0
  private lostSince = 0

  constructor(
    private pin: string,
    private hello: () => ClientMsg,
    private ev: PlayerLinkEvents,
    private fatal: (reason: string) => void,
    /** Byl hráč už dřív ve hře? (pak „hra neexistuje“ znamená jen dočasný výpadek hostitele) */
    private everJoined: boolean,
  ) {
    this.openPeer()
    this.pingTimer = window.setInterval(() => this.heartbeat(), 4000)
  }

  send(msg: ClientMsg) {
    if (this.conn?.open) {
      try {
        this.conn.send(msg)
        return
      } catch {
        /* spojení se právě zavřelo */
      }
    }
    if (msg.t === 'answer') this.pending = [msg]
  }

  pace() {
    /* u přímého spojení zprávy chodí samy */
  }

  destroy() {
    this.destroyed = true
    window.clearInterval(this.pingTimer)
    window.clearTimeout(this.retryTimer)
    window.clearTimeout(this.openTimer)
    this.detach()
    this.peer?.destroy()
  }

  private openPeer() {
    if (this.destroyed) return
    const peer = new Peer(peerOptions())
    this.peer = peer
    // 'open' přijde i po každém obnovení spojení se signalizačním serverem –
    // fungující datové spojení kvůli tomu nerušíme.
    peer.on('open', () => {
      if (!this.conn?.open) this.connect()
    })
    peer.on('disconnected', () => {
      if (!peer.destroyed) window.setTimeout(() => !peer.destroyed && peer.disconnected && peer.reconnect(), 1500)
    })
    peer.on('error', (err) => {
      if (this.destroyed) return
      const type = (err as { type?: string }).type
      if (type === 'peer-unavailable') {
        if (!this.everJoined) {
          this.ev.missing()
          return
        }
        this.markLost()
        this.scheduleRetry(3000)
        return
      }
      if (type === 'browser-incompatible') {
        this.fatal('Tento prohlížeč nepodporuje WebRTC. Zkus jiný prohlížeč.')
        return
      }
      // Výpadek signalizačního serveru nevadí, pokud datové spojení drží.
      if (this.conn?.open) return
      this.scheduleRetry(2000)
    })
  }

  /** Odpojí staré spojení tak, aby jeho zavření nespustilo další pokus. */
  private detach() {
    const c = this.conn
    this.conn = null
    window.clearTimeout(this.openTimer)
    if (c) {
      c.removeAllListeners()
      try {
        c.close()
      } catch {
        /* nic */
      }
    }
  }

  private connect() {
    const peer = this.peer
    if (!peer || !peer.open || this.destroyed) return
    if (this.conn?.open) return
    this.detach()
    const conn = peer.connect(hostPeerId(this.pin), { reliable: true, serialization: 'json' })
    this.conn = conn
    // PeerJS nehlásí, když se spojení nepodaří navázat (síť blokuje WebRTC) – hlídáme si to sami.
    this.openTimer = window.setTimeout(() => {
      if (this.conn !== conn || conn.open) return
      this.failedAttempts++
      if (this.failedAttempts >= 2) this.ev.status(this.connected ? 'reconnecting' : 'connecting')
      this.detach()
      this.scheduleRetry(1000)
    }, OPEN_TIMEOUT)
    conn.on('open', () => {
      window.clearTimeout(this.openTimer)
      this.lastHeard = Date.now()
      this.connected = true
      this.everJoined = true
      this.failedAttempts = 0
      this.lostSince = 0
      try {
        conn.send(this.hello())
        const queued = this.pending
        this.pending = []
        queued.forEach((m) => conn.send(m))
      } catch {
        /* nic */
      }
    })
    conn.on('data', (raw) => {
      this.lastHeard = Date.now()
      const msg = raw as HostMsg & { now?: number }
      if (!msg || typeof msg !== 'object') return
      if (this.status !== 'connected') {
        this.status = 'connected'
        this.ev.status('connected')
      }
      this.ev.message(msg, msg.t === 'view' && typeof msg.now === 'number' ? msg.now : Date.now())
    })
    const lost = () => {
      if (this.conn !== conn || this.destroyed) return
      this.detach()
      this.markLost()
      this.scheduleRetry(1500)
    }
    conn.on('close', lost)
    conn.on('error', lost)
  }

  private status: PlayerLinkStatus = 'connecting'

  private markLost() {
    if (!this.lostSince) this.lostSince = Date.now()
    const s: PlayerLinkStatus = Date.now() - this.lostSince > GONE_AFTER ? 'host-away' : 'reconnecting'
    if (this.connected && s !== this.status) {
      this.status = s
      this.ev.status(s)
    }
  }

  private scheduleRetry(ms: number) {
    if (this.destroyed) return
    window.clearTimeout(this.retryTimer)
    this.retryTimer = window.setTimeout(() => {
      const peer = this.peer
      if (!peer || peer.destroyed) this.openPeer()
      else if (peer.disconnected) {
        peer.reconnect()
        this.scheduleRetry(2000)
      } else if (!peer.open) this.scheduleRetry(1000)
      else this.connect()
    }, ms)
  }

  private heartbeat() {
    if (this.destroyed) return
    if (this.lostSince) this.markLost()
    if (!this.conn?.open) return
    this.send({ t: 'ping' })
    if (Date.now() - this.lastHeard > 12000) {
      this.detach()
      this.markLost()
      this.scheduleRetry(500)
    }
  }
}

function wait(ms: number) {
  return new Promise((r) => window.setTimeout(r, ms))
}
