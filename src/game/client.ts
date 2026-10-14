import { P2PPlayerLink, RelayPlayerLink, relayAvailable, relayRoomExists, type LinkKind, type PlayerLink } from './link'
import { randomId } from './net'
import type { Answer, ClientMsg, HostMsg, PlayerView } from './types'

export type ClientStatus = 'connecting' | 'joined' | 'reconnecting' | 'host-away' | 'error' | 'kicked'

export interface ClientSnapshot {
  status: ClientStatus
  error?: string
  name: string
  view: PlayerView | null
  /** Místní čas, kdy vyprší aktuální otázka. */
  deadline: number
  /** Místní čas, kdy se otázka na telefonu objevila. */
  shownAt: number
}

interface SavedPlayer {
  pin: string
  playerId: string
  name: string
  avatar: string
  link?: LinkKind
  /** Hráč už byl ve hře přijatý (po obnovení stránky se nemá znovu ptát na PIN). */
  joined?: boolean
}

const SAVE_KEY = 'expres-ak-player'
/** Jak dlouho čekat na první připojení, než ukážeme chybu. */
const JOIN_TIMEOUT = 25_000

export function loadSavedPlayer(): SavedPlayer | null {
  try {
    const raw = sessionStorage.getItem(SAVE_KEY)
    return raw ? (JSON.parse(raw) as SavedPlayer) : null
  } catch {
    return null
  }
}

// Identita hráče pro daný PIN, aby po znovuotevření odkazu (nová karta, znovu naskenovaný QR)
// a zadání stejného jména pokračoval jako tentýž hráč a nepřišel o body.
const IDS_KEY = 'expres-ak-ids'
const ID_TTL = 4 * 3600_000

function readIds(): Record<string, { playerId: string; name: string; ts: number }> {
  try {
    const all = JSON.parse(localStorage.getItem(IDS_KEY) || '{}') as Record<string, { playerId: string; name: string; ts: number }>
    for (const k of Object.keys(all)) if (Date.now() - all[k].ts > ID_TTL) delete all[k]
    return all
  } catch {
    return {}
  }
}

function rememberIdentity(pin: string, playerId: string, name: string) {
  try {
    const all = readIds()
    all[pin] = { playerId, name, ts: Date.now() }
    localStorage.setItem(IDS_KEY, JSON.stringify(all))
  } catch {
    /* nic */
  }
}

function findIdentity(pin: string, name: string): string | undefined {
  const e = readIds()[pin]
  return e && e.name.trim().toLowerCase() === name.trim().toLowerCase() ? e.playerId : undefined
}

export function clearSavedPlayer() {
  try {
    sessionStorage.removeItem(SAVE_KEY)
  } catch {
    /* nic */
  }
}

/** Jak často se ptát serveru na novou obrazovku podle fáze hry (ms). */
const PACE: Record<PlayerView['phase'], number> = {
  lobby: 1200,
  intro: 600,
  question: 900,
  result: 1000,
  leaderboard: 1100,
  final: 4000,
}

export class PlayerClient {
  private link: PlayerLink | null = null
  private kind: LinkKind | undefined
  private listeners = new Set<() => void>()
  private snapshot: ClientSnapshot
  private joined = false
  private destroyed = false
  private pingTimer = 0
  private joinTimer = 0
  private playerId: string
  /** Na kterou otázku už hráč odpověděl (aby starší obrazovka ze serveru nepřepsala „odesláno“). */
  private answeredQ = -1
  private wasJoined: boolean

  constructor(
    private pin: string,
    name: string,
    private avatar: string,
    playerId?: string,
    link?: LinkKind,
    wasJoined = false,
  ) {
    this.playerId = playerId ?? findIdentity(pin, name) ?? randomId()
    this.kind = link
    this.wasJoined = wasJoined
    this.snapshot = { status: 'connecting', name, view: null, deadline: 0, shownAt: 0 }
    this.save()
    this.joinTimer = window.setTimeout(() => {
      if (!this.joined && !this.wasJoined && !this.destroyed) {
        this.fail('Nepodařilo se připojit ke hře. Zkontroluj PIN a jestli je hra na počítači spuštěná, a zkus to znovu.')
      }
    }, JOIN_TIMEOUT)
    void this.open()
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  getSnapshot = () => this.snapshot

  get gamePin() {
    return this.pin
  }

  destroy() {
    this.destroyed = true
    window.clearInterval(this.pingTimer)
    window.clearTimeout(this.joinTimer)
    this.link?.destroy()
  }

  answer(qIndex: number, answer: Answer, joker: boolean) {
    const ms = this.snapshot.shownAt ? Math.max(0, Date.now() - this.snapshot.shownAt) : undefined
    this.answeredQ = qIndex
    this.link?.send({ t: 'answer', qIndex, answer, joker, ms })
    const v = this.snapshot.view
    if (v && v.phase === 'question' && v.qIndex === qIndex) this.update({ view: { ...v, answered: true } })
  }

  react(emoji: string) {
    this.link?.send({ t: 'react', emoji })
  }

  // ---------- připojení ----------

  private hello = (): ClientMsg => ({ t: 'hello', playerId: this.playerId, name: this.snapshot.name, avatar: this.avatar })

  private async open() {
    const events = {
      status: (s: 'connecting' | 'connected' | 'reconnecting' | 'host-away') => {
        if (!this.joined && !this.wasJoined) return
        this.update({ status: s === 'connected' ? 'joined' : s === 'connecting' ? 'reconnecting' : s })
      },
      message: (msg: HostMsg, hostNow: number) => this.onMsg(msg, hostNow),
      missing: () => {
        if (this.joined || this.wasJoined) this.fail('Hra už skončila nebo ji hostitel zavřel.')
        else this.fail('Hra s tímto PINem neexistuje. Zkontroluj číslo na plátně.')
      },
    }
    let kind = this.kind
    if (!kind) {
      // Má-li web databázi, hostitel ji používá taky – hra pak musí existovat na serveru.
      // Bez databáze zkusíme přímé spojení přes PeerJS.
      kind = (await relayAvailable()) ? 'relay' : 'p2p'
      if (kind === 'relay') {
        try {
          if (!(await relayRoomExists(this.pin, this.playerId))) {
            if (!this.destroyed) events.missing()
            return
          }
        } catch {
          // Server teď neodpovídá – relay to bude zkoušet dál sám.
        }
      }
    }
    if (this.destroyed) return
    this.kind = kind
    this.save()
    if (kind === 'relay') {
      const link = new RelayPlayerLink(this.pin, this.playerId, events)
      this.link = link
      link.send(this.hello())
      this.pingTimer = window.setInterval(() => this.joined && link.send({ t: 'ping' }), 8000)
    } else {
      this.link = new P2PPlayerLink(this.pin, this.hello, events, (reason) => this.fail(reason), this.wasJoined)
    }
  }

  private fail(error: string) {
    this.update({ status: 'error', error })
    clearSavedPlayer()
    this.destroy()
  }

  private update(patch: Partial<ClientSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch }
    this.listeners.forEach((fn) => fn())
  }

  private save() {
    try {
      const s: SavedPlayer = {
        pin: this.pin,
        playerId: this.playerId,
        name: this.snapshot.name,
        avatar: this.avatar,
        link: this.kind,
        joined: this.joined || this.wasJoined,
      }
      sessionStorage.setItem(SAVE_KEY, JSON.stringify(s))
    } catch {
      /* nic */
    }
  }

  private onMsg(msg: HostMsg, hostNow: number) {
    if (!msg || typeof msg !== 'object' || this.destroyed) return
    switch (msg.t) {
      case 'welcome':
        this.joined = true
        window.clearTimeout(this.joinTimer)
        this.update({ status: 'joined', error: undefined, name: msg.name })
        this.save()
        rememberIdentity(this.pin, this.playerId, this.snapshot.name)
        break
      case 'rejected':
        this.fail(msg.reason)
        break
      case 'kicked':
        this.update({ status: 'kicked' })
        clearSavedPlayer()
        this.destroy()
        break
      case 'view': {
        let v = msg.view
        if (!this.joined) {
          // U relay může obrazovka dorazit dřív než potvrzení – bereme ji jako přihlášení.
          this.joined = true
          window.clearTimeout(this.joinTimer)
          this.save()
        }
        if (v.phase === 'question' && v.qIndex === this.answeredQ && !v.answered) v = { ...v, answered: true }
        const prev = this.snapshot.view
        const sameQuestion = prev?.phase === 'question' && v.phase === 'question' && prev.qIndex === v.qIndex
        const patch: Partial<ClientSnapshot> = { view: v, status: 'joined' }
        if (v.phase === 'question') {
          patch.deadline = Date.now() + (v.endsAt - hostNow)
          if (!sameQuestion) patch.shownAt = Date.now()
        }
        this.link?.pace(PACE[v.phase])
        this.update(patch)
        break
      }
    }
  }
}
