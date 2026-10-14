import Peer, { type DataConnection } from 'peerjs'
import { hostPeerId, peerOptions, randomId } from './net'
import type { Answer, ClientMsg, HostMsg, PlayerView } from './types'

export type ClientStatus = 'connecting' | 'joined' | 'reconnecting' | 'error' | 'kicked'

export interface ClientSnapshot {
  status: ClientStatus
  error?: string
  name: string
  view: PlayerView | null
  /** Místní čas, kdy vyprší aktuální otázka. */
  deadline: number
}

interface SavedPlayer {
  pin: string
  playerId: string
  name: string
  avatar: string
}

const SAVE_KEY = 'expres-ak-player'

export function loadSavedPlayer(): SavedPlayer | null {
  try {
    const raw = sessionStorage.getItem(SAVE_KEY)
    return raw ? (JSON.parse(raw) as SavedPlayer) : null
  } catch {
    return null
  }
}

export function clearSavedPlayer() {
  try {
    sessionStorage.removeItem(SAVE_KEY)
  } catch {
    /* nic */
  }
}

export class PlayerClient {
  private peer: Peer | null = null
  private conn: DataConnection | null = null
  private listeners = new Set<() => void>()
  private snapshot: ClientSnapshot
  private everJoined = false
  private destroyed = false
  private lastHeard = 0
  private pingTimer: number
  private retryTimer = 0
  private playerId: string

  constructor(
    private pin: string,
    name: string,
    private avatar: string,
    playerId?: string,
  ) {
    this.playerId = playerId ?? randomId()
    this.snapshot = { status: 'connecting', name, view: null, deadline: 0 }
    this.save()
    this.openPeer()
    this.pingTimer = window.setInterval(() => this.heartbeat(), 4000)
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  getSnapshot = () => this.snapshot

  destroy() {
    this.destroyed = true
    window.clearInterval(this.pingTimer)
    window.clearTimeout(this.retryTimer)
    this.conn?.close()
    this.peer?.destroy()
  }

  answer(qIndex: number, answer: Answer, joker: boolean) {
    this.send({ t: 'answer', qIndex, answer, joker })
    // Okamžitá odezva, než přijde potvrzení od hostitele.
    const v = this.snapshot.view
    if (v && v.phase === 'question' && v.qIndex === qIndex) {
      this.update({ view: { ...v, answered: true } })
    }
  }

  react(emoji: string) {
    this.send({ t: 'react', emoji })
  }

  private update(patch: Partial<ClientSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch }
    this.listeners.forEach((fn) => fn())
  }

  private save() {
    try {
      const s: SavedPlayer = { pin: this.pin, playerId: this.playerId, name: this.snapshot.name, avatar: this.avatar }
      sessionStorage.setItem(SAVE_KEY, JSON.stringify(s))
    } catch {
      /* nic */
    }
  }

  private openPeer() {
    if (this.destroyed) return
    const peer = new Peer(peerOptions())
    this.peer = peer
    peer.on('open', () => this.connect())
    peer.on('disconnected', () => {
      if (!peer.destroyed) window.setTimeout(() => !peer.destroyed && peer.disconnected && peer.reconnect(), 1500)
    })
    peer.on('error', (err) => {
      if (this.destroyed) return
      const type = (err as { type?: string }).type
      if (type === 'peer-unavailable') {
        if (!this.everJoined) {
          this.update({ status: 'error', error: 'Hra s tímto PINem neexistuje. Zkontroluj číslo na plátně.' })
          this.destroy()
        } else {
          this.scheduleRetry()
        }
        return
      }
      if (type === 'browser-incompatible') {
        this.update({ status: 'error', error: 'Tento prohlížeč nepodporuje WebRTC. Zkus jiný prohlížeč.' })
        this.destroy()
        return
      }
      if (!this.everJoined) this.update({ status: 'connecting', error: 'Spojení se nedaří, zkouším znovu…' })
      this.scheduleRetry()
    })
  }

  private connect() {
    const peer = this.peer
    if (!peer || peer.destroyed || this.destroyed) return
    this.conn?.close()
    const conn = peer.connect(hostPeerId(this.pin), { reliable: true, serialization: 'json' })
    this.conn = conn
    conn.on('open', () => {
      this.lastHeard = Date.now()
      this.send({ t: 'hello', playerId: this.playerId, name: this.snapshot.name, avatar: this.avatar })
    })
    conn.on('data', (raw) => this.onMsg(raw as HostMsg))
    const lost = () => {
      if (this.conn !== conn || this.destroyed) return
      this.conn = null
      if (this.snapshot.status === 'joined') this.update({ status: 'reconnecting' })
      this.scheduleRetry()
    }
    conn.on('close', lost)
    conn.on('error', lost)
  }

  private scheduleRetry() {
    if (this.destroyed) return
    window.clearTimeout(this.retryTimer)
    this.retryTimer = window.setTimeout(() => {
      const peer = this.peer
      if (!peer || peer.destroyed) this.openPeer()
      else if (peer.disconnected) {
        peer.reconnect()
        this.scheduleRetry()
      } else this.connect()
    }, 2000)
  }

  private heartbeat() {
    if (this.destroyed) return
    if (this.conn?.open) {
      this.send({ t: 'ping' })
      if (Date.now() - this.lastHeard > 12000) {
        // Hostitel neodpovídá – zkusíme se připojit znovu.
        const c = this.conn
        this.conn = null
        c.close()
        if (this.snapshot.status === 'joined') this.update({ status: 'reconnecting' })
        this.scheduleRetry()
      }
    }
  }

  private send(msg: ClientMsg) {
    try {
      if (this.conn?.open) this.conn.send(msg)
    } catch {
      /* nic */
    }
  }

  private onMsg(msg: HostMsg) {
    if (!msg || typeof msg !== 'object') return
    this.lastHeard = Date.now()
    switch (msg.t) {
      case 'welcome':
        this.everJoined = true
        this.update({ status: 'joined', error: undefined, name: msg.name })
        this.save()
        break
      case 'rejected':
        this.update({ status: 'error', error: msg.reason })
        clearSavedPlayer()
        this.destroy()
        break
      case 'kicked':
        this.update({ status: 'kicked' })
        clearSavedPlayer()
        this.destroy()
        break
      case 'view': {
        const v = msg.view
        const deadline = v.phase === 'question' ? Date.now() + v.remainingMs : this.snapshot.deadline
        this.update({ view: v, deadline, status: 'joined' })
        break
      }
    }
  }
}
