import { QUESTION_SETS } from '../data/questions'
import { P2PHostLink, RelayHostLink, waitRelayStatus, type HostLink, type LinkKind, type SavedLink } from './link'
import { AVATARS, REACTIONS, cleanName, randomPin } from './net'
import { later } from './ticker'
import {
  correctText,
  evaluate,
  questionPoints,
  shuffledOrder,
  streakBonus,
  toPublic,
} from './scoring'
import type {
  Answer,
  ClientMsg,
  HostMsg,
  MeInfo,
  PlayerResult,
  PlayerView,
  Question,
  QuestionSet,
} from './types'

export type HostPhase = 'lobby' | 'intro' | 'question' | 'result' | 'leaderboard' | 'final'

export interface HostPlayer {
  id: string
  name: string
  avatar: string
  score: number
  prevScore: number
  streak: number
  jokerUsed: boolean
  connected: boolean
  rank: number
  prevRank: number
  joinedAt: number
  answer?: { value: Answer; elapsed: number; joker: boolean }
  result?: PlayerResult
}

export interface Reaction {
  key: number
  emoji: string
  x: number
}

export interface QuestionStat {
  qIndex: number
  correctPct: number
  answered: number
}

export interface HostSnapshot {
  status: 'connecting' | 'ready' | 'error'
  error?: string
  /** Jakým způsobem se připojují hráči (null = ještě se zjišťuje). */
  link: LinkKind | null
  pin: string
  phase: HostPhase
  set: QuestionSet
  quick: boolean
  questions: Question[]
  qIndex: number
  question: Question | undefined
  introEndsAt: number
  /** Začátek otázky v místním čase prohlížeče (pro odpočet na plátně). */
  startedAt: number
  orderShuffle: number[]
  players: HostPlayer[]
  answeredCount: number
  connectedCount: number
  reactions: Reaction[]
  stats: QuestionStat[]
  locked: boolean
}

interface SavedGame {
  v: 2
  link: SavedLink | null
  phase: HostPhase
  setId: string
  quick: boolean
  qIndex: number
  players: HostPlayer[]
  stats: QuestionStat[]
  banned: string[]
  locked?: boolean
  savedAt: number
}

const SAVE_KEY = 'expres-ak-host'
export const INTRO_MS = 4500
const MAX_PLAYERS = 80
/** Za jak dlouho bez zprávy považujeme hráče za odpojeného (relay posílá ping méně často). */
const PING_TIMEOUT = { relay: 50_000, p2p: 20_000 }

export function loadSavedGame(): SavedGame | null {
  try {
    const raw = localStorage.getItem(SAVE_KEY)
    if (!raw) return null
    const s = JSON.parse(raw) as SavedGame
    if (s.v !== 2 || !s.link?.pin || Date.now() - s.savedAt > 3 * 3600_000) return null
    if (s.phase === 'final' || (s.phase === 'lobby' && s.players.length === 0)) return null
    return s
  } catch {
    return null
  }
}

export function clearSavedGame() {
  try {
    localStorage.removeItem(SAVE_KEY)
  } catch {
    /* nic */
  }
}

function questionsOf(set: QuestionSet, quick: boolean): Question[] {
  if (!quick || !set.quick?.length) return set.questions
  return set.questions.filter((q) => set.quick!.includes(q.id))
}

export class HostGame {
  private link: HostLink | null = null
  private destroyed = false
  private listeners = new Set<() => void>()
  private snapshot!: HostSnapshot
  private players: HostPlayer[] = []
  private lastSeen = new Map<string, number>()
  private lastReact = new Map<string, number>()
  private banned = new Set<string>()
  private timers: (() => void)[] = []
  private watchdog: number
  private reactionKey = 0
  private locked = false

  private status: HostSnapshot['status'] = 'connecting'
  private error: string | undefined
  private pin = ''
  private phase: HostPhase = 'lobby'
  private set: QuestionSet = QUESTION_SETS[0]
  private quick = false
  private questions: Question[] = this.set.questions
  private qIndex = 0
  private introEndsAt = 0
  /** Začátek otázky v časové ose spojení (u relay čas serveru). */
  private startedAtLink = 0
  /** Začátek otázky v místním čase. */
  private startedAt = 0
  private orderShuffle: number[] = []
  private reactions: Reaction[] = []
  private stats: QuestionStat[] = []

  constructor(saved?: SavedGame | null) {
    if (saved) this.restore(saved)
    this.buildSnapshot()
    void this.connect(saved?.link ?? null)
    this.watchdog = window.setInterval(() => this.tick(), 3000)
  }

  // ---------- veřejné API pro React ----------

  subscribe = (fn: () => void) => {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  getSnapshot = () => this.snapshot

  destroy() {
    this.destroyed = true
    this.clearTimers()
    window.clearInterval(this.watchdog)
    this.link?.destroy()
  }

  setOptions(setId: string, quick: boolean) {
    if (this.phase !== 'lobby') return
    this.set = QUESTION_SETS.find((s) => s.id === setId) ?? QUESTION_SETS[0]
    this.quick = quick
    this.questions = questionsOf(this.set, quick)
    this.emit()
  }

  start() {
    if (this.phase !== 'lobby' || this.players.length === 0) return
    this.resetScores()
    this.qIndex = 0
    this.beginIntro()
  }

  /** Posune hru dál (tlačítko „Další“, mezerník, šipka nebo klikátko). */
  next() {
    switch (this.phase) {
      case 'intro':
        this.beginQuestion()
        break
      case 'question':
        this.endQuestion()
        break
      case 'result':
        if (this.qIndex >= this.questions.length - 1) this.finish()
        else this.setPhase('leaderboard')
        break
      case 'leaderboard':
        this.qIndex++
        this.beginIntro()
        break
    }
  }

  playAgain() {
    this.clearTimers()
    this.resetScores()
    this.qIndex = 0
    this.stats = []
    this.setPhase('lobby')
  }

  /** Zamčené lobby nepustí nové hráče (známí se můžou dál připojovat). */
  setLocked(locked: boolean) {
    this.locked = locked
    this.emit()
  }

  kick(id: string) {
    this.link?.send(id, { t: 'kicked' })
    this.link?.drop(id)
    this.banned.add(id)
    this.players = this.players.filter((p) => p.id !== id)
    this.rank()
    this.broadcast()
  }

  // ---------- spojení ----------

  private async connect(saved: SavedLink | null) {
    const events = {
      status: (status: HostSnapshot['status'], error?: string) => {
        const wasReady = this.status === 'ready'
        this.status = status
        this.error = status === 'ready' ? undefined : error
        // Po (znovu)připojení pošleme hráčům aktuální obrazovky.
        if (status === 'ready' && !wasReady) this.broadcast()
        else this.emit()
      },
      pin: (pin: string) => {
        this.pin = pin
        this.emit()
      },
      message: (id: string, msg: ClientMsg, at: number) => this.onMessage(id, msg, at),
      drop: (id: string) => {
        const p = this.players.find((x) => x.id === id)
        if (p?.connected) {
          p.connected = false
          this.emit()
        }
      },
    }
    // Pokud má web databázi, jde spojení přes server (spolehlivé na každé síti),
    // jinak přímo mezi zařízeními přes WebRTC. Rozehraná hra přes server zůstane
    // na serveru i při výpadku Wi-Fi (jinak by se změnil PIN a třída by se odpojila).
    const relay =
      saved?.kind === 'relay' ||
      (await waitRelayStatus(
        () => events.status('connecting', 'Ověřuji spojení se serverem hry…'),
        () => this.destroyed,
      ))
    if (this.destroyed) return
    if (relay) {
      this.link = new RelayHostLink(events, saved?.kind === 'relay' ? saved : undefined)
    } else {
      const pin = saved?.kind === 'p2p' ? saved.pin : randomPin()
      const restored = !!saved
      this.link = new P2PHostLink(events, pin, () => !restored && this.phase === 'lobby' && this.players.length === 0)
    }
    this.emit()
  }

  private linkNow() {
    return this.link ? this.link.now() : Date.now()
  }

  private send(id: string, msg: HostMsg) {
    this.link?.send(id, msg)
  }

  // ---------- průběh hry ----------

  private resetScores() {
    for (const p of this.players) {
      p.score = 0
      p.prevScore = 0
      p.streak = 0
      p.jokerUsed = false
      p.rank = 0
      p.prevRank = 0
      p.answer = undefined
      p.result = undefined
    }
    this.stats = []
    this.rank()
  }

  private beginIntro() {
    this.clearTimers()
    const q = this.questions[this.qIndex]
    for (const p of this.players) {
      p.answer = undefined
      p.result = undefined
    }
    this.orderShuffle = q.type === 'order' ? shuffledOrder(q.items.length) : []
    this.introEndsAt = Date.now() + INTRO_MS
    this.setPhase('intro')
    this.later(() => this.beginQuestion(), INTRO_MS)
  }

  private beginQuestion() {
    if (this.phase !== 'intro') return
    this.clearTimers()
    const q = this.questions[this.qIndex]
    this.startedAt = Date.now()
    this.startedAtLink = this.linkNow()
    this.setPhase('question')
    // Přes server dorazí odpovědi z poslední vteřiny o kousek později – počkáme na ně.
    const grace = this.link?.kind === 'relay' ? 1500 : 300
    this.later(() => this.endQuestion(), q.time * 1000 + grace)
  }

  private endQuestion() {
    if (this.phase !== 'question') return
    this.clearTimers()
    const q = this.questions[this.qIndex]
    let correctCount = 0
    let answered = 0
    for (const p of this.players) {
      const a = p.answer
      const { fraction, correct } = evaluate(q, a?.value)
      if (a) answered++
      if (correct) correctCount++
      const joker = !!a?.joker
      const points = a ? questionPoints(q, fraction, a.elapsed, joker) : 0
      p.streak = correct ? p.streak + 1 : 0
      const bonus = correct ? streakBonus(p.streak) : 0
      p.prevScore = p.score
      p.score += points + bonus
      p.result = {
        correct,
        fraction,
        points,
        streakBonus: bonus,
        joker,
        answered: !!a,
        correctText: correctText(q),
      }
    }
    const total = this.players.length || 1
    this.stats = this.stats.filter((s) => s.qIndex !== this.qIndex)
    this.stats.push({ qIndex: this.qIndex, correctPct: Math.round((correctCount / total) * 100), answered })
    for (const p of this.players) p.prevRank = p.rank
    this.rank()
    this.setPhase('result')
  }

  private finish() {
    this.clearTimers()
    this.setPhase('final')
  }

  private rank() {
    const sorted = this.players.slice().sort((a, b) => b.score - a.score || a.joinedAt - b.joinedAt)
    sorted.forEach((p, i) => {
      p.rank = i + 1
      if (!p.prevRank) p.prevRank = i + 1
    })
  }

  private setPhase(phase: HostPhase) {
    this.phase = phase
    this.broadcast()
  }

  // ---------- zprávy od hráčů ----------

  /** Hlídá hráče, kteří se dlouho neozvali (zavřený mobil, ztracený signál). */
  private tick() {
    if (this.destroyed) return
    const now = Date.now()
    let changed = false
    for (const p of this.players) {
      if (p.connected && now - (this.lastSeen.get(p.id) ?? 0) > PING_TIMEOUT[this.link?.kind ?? 'p2p']) {
        p.connected = false
        this.link?.drop(p.id)
        changed = true
      }
    }
    if (changed) this.emit()
  }

  private onMessage(id: string, msg: ClientMsg, at: number) {
    if (!msg || typeof msg !== 'object') return
    if (msg.t === 'hello') return this.onHello(id, msg)
    const p = this.players.find((x) => x.id === id)
    // Zprávy od neznámých hráčů (např. ping vyhozeného) ignorujeme – vyhozený už dostal „kicked“.
    if (!p) return
    this.lastSeen.set(id, Date.now())
    if (!p.connected) {
      p.connected = true
      this.sendView(p)
      this.emit()
    }
    if (msg.t === 'ping') this.send(id, { t: 'pong' })
    else if (msg.t === 'answer') this.onAnswer(p, msg, at)
    else if (msg.t === 'react') this.onReact(p, msg.emoji)
  }

  private onHello(id: string, msg: Extract<ClientMsg, { t: 'hello' }>) {
    id = String(id || '').slice(0, 64)
    if (!id) return
    if (this.banned.has(id)) {
      this.send(id, { t: 'rejected', reason: 'Hostitel tě z této hry odebral.' })
      return
    }
    let p = this.players.find((x) => x.id === id)
    if (!p) {
      if (this.locked) {
        this.send(id, { t: 'rejected', reason: 'Vstup do hry je zamčený. Požádej hostitele, ať ho odemkne.' })
        return
      }
      if (this.players.length >= MAX_PLAYERS) {
        this.send(id, { t: 'rejected', reason: 'Hra je plná.' })
        return
      }
      let name = cleanName(String(msg.name || ''))
      if (!name) {
        this.send(id, { t: 'rejected', reason: 'Zadej přezdívku.' })
        return
      }
      const taken = (n: string) => this.players.some((x) => x.name.toLowerCase() === n.toLowerCase())
      if (taken(name)) {
        let i = 2
        while (taken(`${name.slice(0, 13)} ${i}`)) i++
        name = `${name.slice(0, 13)} ${i}`
      }
      const avatar = AVATARS.includes(msg.avatar) ? msg.avatar : AVATARS[0]
      p = {
        id,
        name,
        avatar,
        score: 0,
        prevScore: 0,
        streak: 0,
        jokerUsed: false,
        connected: true,
        rank: this.players.length + 1,
        prevRank: this.players.length + 1,
        joinedAt: Date.now(),
      }
      this.players.push(p)
      this.rank()
    }
    this.lastSeen.set(id, Date.now())
    p.connected = true
    this.send(id, { t: 'welcome', playerId: id, name: p.name })
    this.broadcast()
  }

  private onAnswer(p: HostPlayer, msg: Extract<ClientMsg, { t: 'answer' }>, at: number) {
    if (this.phase !== 'question' || msg.qIndex !== this.qIndex || p.answer) return
    const q = this.questions[this.qIndex]
    const sinceStart = Math.max(0, at - this.startedAtLink)
    if (sinceStart > q.time * 1000 + 2500) return
    // Telefon posílá, za jak dlouho po zobrazení otázky hráč odpověděl. Díky tomu
    // nikoho neznevýhodní pomalejší síť; víc, než kolik uplynulo na serveru, to být nemůže.
    const reported = typeof msg.ms === 'number' && msg.ms >= 0 ? msg.ms : sinceStart
    // Zpoždění sítě odečteme nejvýš o pár vteřin – víc by šlo zneužít podvrženou hodnotou.
    const slack = this.link?.kind === 'relay' ? 2500 : 1000
    const elapsed = Math.max(sinceStart - slack, Math.min(sinceStart, reported))
    const useJoker = !!msg.joker && !p.jokerUsed
    if (useJoker) p.jokerUsed = true
    p.answer = { value: msg.answer, elapsed, joker: useJoker }
    this.sendView(p)
    this.emit()
    const waiting = this.players.some((x) => x.connected && !x.answer)
    if (!waiting) this.later(() => this.endQuestion(), 700)
  }

  private onReact(p: HostPlayer, emoji: string) {
    const now = Date.now()
    if (now - (this.lastReact.get(p.id) ?? 0) < 600) return
    if (!REACTIONS.includes(emoji)) return
    this.lastReact.set(p.id, now)
    const r = { key: ++this.reactionKey, emoji, x: 4 + Math.random() * 92 }
    this.reactions = [...this.reactions.slice(-30), r]
    this.emit()
    window.setTimeout(() => {
      this.reactions = this.reactions.filter((x) => x.key !== r.key)
      this.emit()
    }, 3200)
  }

  private sendView(p: HostPlayer) {
    this.send(p.id, { t: 'view', view: this.viewFor(p), now: this.linkNow() })
  }

  private broadcast() {
    for (const p of this.players) this.sendView(p)
    this.emit()
  }

  private viewFor(p: HostPlayer): PlayerView {
    const me: MeInfo = {
      name: p.name,
      avatar: p.avatar,
      score: p.score,
      rank: p.rank,
      streak: p.streak,
      jokerUsed: p.jokerUsed,
    }
    const q = this.questions[this.qIndex]
    const base = { me, qIndex: this.qIndex, qTotal: this.questions.length }
    switch (this.phase) {
      case 'lobby':
        return { phase: 'lobby', me, players: this.players.length }
      case 'intro':
        return { phase: 'intro', ...base, type: q.type, double: !!q.double, text: q.text }
      case 'question':
        return {
          phase: 'question',
          ...base,
          text: q.text,
          double: !!q.double,
          question: toPublic(q, this.orderShuffle),
          endsAt: this.startedAtLink + q.time * 1000,
          totalMs: q.time * 1000,
          answered: !!p.answer,
        }
      case 'result': {
        const above = this.players.find((x) => x.rank === p.rank - 1)
        return {
          phase: 'result',
          ...base,
          result: p.result ?? {
            correct: false,
            fraction: 0,
            points: 0,
            streakBonus: 0,
            joker: false,
            answered: false,
            correctText: correctText(q),
          },
          behind: above ? { name: above.name, gap: above.score - p.score } : null,
        }
      }
      case 'leaderboard':
        return { phase: 'leaderboard', ...base }
      case 'final':
        return { phase: 'final', me, total: this.players.length }
    }
  }

  // ---------- pomocné ----------

  private later(fn: () => void, ms: number) {
    this.timers.push(later(fn, ms))
  }

  private clearTimers() {
    this.timers.forEach((cancel) => cancel())
    this.timers = []
  }

  private emit() {
    this.buildSnapshot()
    this.persist()
    this.listeners.forEach((fn) => fn())
  }

  private buildSnapshot() {
    const q = this.questions[this.qIndex]
    this.snapshot = {
      status: this.status,
      error: this.error,
      link: this.link?.kind ?? null,
      pin: this.pin,
      phase: this.phase,
      set: this.set,
      quick: this.quick,
      questions: this.questions,
      qIndex: this.qIndex,
      question: q,
      introEndsAt: this.introEndsAt,
      startedAt: this.startedAt,
      orderShuffle: this.orderShuffle,
      players: this.players.map((p) => ({ ...p })),
      answeredCount: this.players.filter((p) => p.answer).length,
      connectedCount: this.players.filter((p) => p.connected).length,
      reactions: this.reactions,
      stats: this.stats,
      locked: this.locked,
    }
  }

  private persist() {
    const save: SavedGame = {
      v: 2,
      link: this.link && this.pin ? this.link.saved() : null,
      phase: this.phase,
      setId: this.set.id,
      quick: this.quick,
      qIndex: this.qIndex,
      players: this.players.map((p) => ({ ...p, answer: undefined, connected: false })),
      stats: this.stats,
      banned: [...this.banned],
      locked: this.locked,
      savedAt: Date.now(),
    }
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify(save))
    } catch {
      /* úložiště nemusí být k dispozici */
    }
  }

  private restore(s: SavedGame) {
    this.pin = s.link?.pin ?? ''
    this.set = QUESTION_SETS.find((x) => x.id === s.setId) ?? QUESTION_SETS[0]
    this.quick = s.quick
    this.questions = questionsOf(this.set, this.quick)
    this.players = s.players.map((p) => ({ ...p, connected: false, answer: undefined }))
    this.stats = s.stats ?? []
    this.banned = new Set(s.banned ?? [])
    this.locked = !!s.locked
    this.qIndex = Math.min(s.qIndex, this.questions.length - 1)
    let phase = s.phase
    // Rozehranou otázku nejde obnovit – vrátíme se na průběžné pořadí a otázku spustíme znovu.
    if (phase === 'intro' || phase === 'question') {
      if (this.qIndex === 0) {
        phase = 'lobby'
      } else {
        phase = 'leaderboard'
        this.qIndex -= 1
      }
    }
    this.phase = phase
    this.rank()
  }
}
