import Peer, { type DataConnection } from 'peerjs'
import { QUESTION_SETS } from '../data/questions'
import { AVATARS, cleanName, hostPeerId, peerOptions, randomPin } from './net'
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
  pin: string
  phase: HostPhase
  set: QuestionSet
  quick: boolean
  questions: Question[]
  qIndex: number
  question: Question | undefined
  introEndsAt: number
  startedAt: number
  orderShuffle: number[]
  players: HostPlayer[]
  answeredCount: number
  connectedCount: number
  reactions: Reaction[]
  stats: QuestionStat[]
}

interface SavedGame {
  v: 1
  pin: string
  phase: HostPhase
  setId: string
  quick: boolean
  qIndex: number
  players: HostPlayer[]
  stats: QuestionStat[]
  banned: string[]
  savedAt: number
}

const SAVE_KEY = 'expres-ak-host'
export const INTRO_MS = 4500
const MAX_PLAYERS = 80
const PING_TIMEOUT = 16000

export function loadSavedGame(): SavedGame | null {
  try {
    const raw = localStorage.getItem(SAVE_KEY)
    if (!raw) return null
    const s = JSON.parse(raw) as SavedGame
    if (s.v !== 1 || Date.now() - s.savedAt > 3 * 3600_000) return null
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
  private peer: Peer | null = null
  private destroyed = false
  private listeners = new Set<() => void>()
  private snapshot!: HostSnapshot
  private players: HostPlayer[] = []
  private conns = new Map<string, DataConnection>()
  private lastSeen = new Map<string, number>()
  private lastReact = new Map<string, number>()
  private banned = new Set<string>()
  private timers: number[] = []
  private watchdog: number
  private reactionKey = 0
  private restored: boolean
  private reopening = false

  private status: HostSnapshot['status'] = 'connecting'
  private error: string | undefined
  private pin: string
  private phase: HostPhase = 'lobby'
  private set: QuestionSet = QUESTION_SETS[0]
  private quick = false
  private questions: Question[] = this.set.questions
  private qIndex = 0
  private introEndsAt = 0
  private startedAt = 0
  private orderShuffle: number[] = []
  private reactions: Reaction[] = []
  private stats: QuestionStat[] = []

  constructor(saved?: SavedGame | null) {
    this.restored = !!saved
    this.pin = saved?.pin ?? randomPin()
    if (saved) this.restore(saved)
    this.buildSnapshot()
    this.openPeer()
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
    this.peer?.destroy()
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

  kick(id: string) {
    const conn = this.conns.get(id)
    if (conn) {
      this.send(conn, { t: 'kicked' })
      window.setTimeout(() => conn.close(), 300)
    }
    this.conns.delete(id)
    this.banned.add(id)
    this.players = this.players.filter((p) => p.id !== id)
    this.rank()
    this.broadcast()
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
    this.setPhase('question')
    this.later(() => this.endQuestion(), q.time * 1000 + 300)
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

  // ---------- síť ----------

  private openPeer() {
    this.reopening = false
    if (this.destroyed) return
    this.status = 'connecting'
    const peer = new Peer(hostPeerId(this.pin), peerOptions())
    this.peer = peer
    peer.on('open', () => {
      this.status = 'ready'
      this.error = undefined
      this.emit()
    })
    peer.on('connection', (conn) => this.onConnection(conn))
    peer.on('disconnected', () => {
      if (this.destroyed || peer.destroyed) return
      this.status = 'connecting'
      this.emit()
      window.setTimeout(() => !peer.destroyed && peer.disconnected && peer.reconnect(), 1500)
    })
    peer.on('error', (err) => {
      if (this.destroyed) return
      const type = (err as { type?: string }).type
      if (type === 'unavailable-id') {
        this.reopening = true
        peer.destroy()
        // V lobby bez hráčů prostě vylosujeme nový PIN, jinak čekáme, až server uvolní ten starý.
        if (this.phase === 'lobby' && this.players.length === 0 && !this.restored) this.pin = randomPin()
        window.setTimeout(() => this.openPeer(), this.restored ? 3000 : 200)
        return
      }
      if (type === 'peer-unavailable') return
      if (type === 'browser-incompatible') {
        this.status = 'error'
        this.error = 'Tento prohlížeč nepodporuje WebRTC. Zkus Chrome, Edge, Firefox nebo Safari.'
        this.emit()
        return
      }
      this.status = 'error'
      this.error = 'Nepodařilo se spojit se serverem. Zkouším to znovu…'
      this.emit()
    })
  }

  /** Hlídá spojení se serverem a hráče, kteří se odmlčeli. */
  private tick() {
    if (this.destroyed) return
    const peer = this.peer
    if (!this.reopening) {
      if (!peer || peer.destroyed) this.openPeer()
      else if (peer.disconnected) peer.reconnect()
    }

    const now = Date.now()
    let changed = false
    for (const p of this.players) {
      if (p.connected && now - (this.lastSeen.get(p.id) ?? 0) > PING_TIMEOUT) {
        p.connected = false
        this.conns.get(p.id)?.close()
        this.conns.delete(p.id)
        changed = true
      }
    }
    if (changed) this.emit()
  }

  private onConnection(conn: DataConnection) {
    conn.on('data', (raw) => this.onData(conn, raw as ClientMsg))
    const drop = () => {
      for (const [id, c] of this.conns) {
        if (c === conn) {
          this.conns.delete(id)
          const p = this.players.find((x) => x.id === id)
          if (p) p.connected = false
          this.emit()
        }
      }
    }
    conn.on('close', drop)
    conn.on('error', drop)
  }

  private onData(conn: DataConnection, msg: ClientMsg) {
    if (!msg || typeof msg !== 'object') return
    if (msg.t === 'hello') return this.onHello(conn, msg)
    const id = this.idOf(conn)
    if (!id) return
    this.lastSeen.set(id, Date.now())
    const p = this.players.find((x) => x.id === id)
    if (!p) return
    if (msg.t === 'ping') this.send(conn, { t: 'pong' })
    else if (msg.t === 'answer') this.onAnswer(p, msg.qIndex, msg.answer, msg.joker)
    else if (msg.t === 'react') this.onReact(p, msg.emoji)
  }

  private idOf(conn: DataConnection): string | undefined {
    for (const [id, c] of this.conns) if (c === conn) return id
    return undefined
  }

  private onHello(conn: DataConnection, msg: Extract<ClientMsg, { t: 'hello' }>) {
    const id = String(msg.playerId || '').slice(0, 64)
    if (!id) return
    if (this.banned.has(id)) {
      this.send(conn, { t: 'rejected', reason: 'Hostitel tě z této hry odebral.' })
      return
    }
    let p = this.players.find((x) => x.id === id)
    if (!p) {
      if (this.players.length >= MAX_PLAYERS) {
        this.send(conn, { t: 'rejected', reason: 'Hra je plná.' })
        return
      }
      let name = cleanName(String(msg.name || ''))
      if (!name) {
        this.send(conn, { t: 'rejected', reason: 'Zadej přezdívku.' })
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
    const old = this.conns.get(id)
    if (old && old !== conn) old.close()
    this.conns.set(id, conn)
    this.lastSeen.set(id, Date.now())
    p.connected = true
    this.send(conn, { t: 'welcome', playerId: id, name: p.name })
    this.broadcast()
  }

  private onAnswer(p: HostPlayer, qIndex: number, value: Answer, joker: boolean) {
    if (this.phase !== 'question' || qIndex !== this.qIndex || p.answer) return
    const q = this.questions[this.qIndex]
    const elapsed = Date.now() - this.startedAt
    if (elapsed > q.time * 1000 + 1500) return
    const useJoker = !!joker && !p.jokerUsed
    if (useJoker) p.jokerUsed = true
    p.answer = { value, elapsed, joker: useJoker }
    this.sendView(p)
    this.emit()
    const waiting = this.players.some((x) => x.connected && !x.answer)
    if (!waiting) this.later(() => this.endQuestion(), 700)
  }

  private onReact(p: HostPlayer, emoji: string) {
    const now = Date.now()
    if (now - (this.lastReact.get(p.id) ?? 0) < 600) return
    if (!['👏', '😮', '😂', '❤️', '🔥', '🚂'].includes(emoji)) return
    this.lastReact.set(p.id, now)
    const r = { key: ++this.reactionKey, emoji, x: 4 + Math.random() * 92 }
    this.reactions = [...this.reactions.slice(-30), r]
    this.emit()
    window.setTimeout(() => {
      this.reactions = this.reactions.filter((x) => x.key !== r.key)
      this.emit()
    }, 3200)
  }

  private send(conn: DataConnection, msg: HostMsg) {
    try {
      if (conn.open) conn.send(msg)
    } catch {
      /* spojení se mezitím zavřelo */
    }
  }

  private sendView(p: HostPlayer) {
    const conn = this.conns.get(p.id)
    if (conn) this.send(conn, { t: 'view', view: this.viewFor(p) })
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
          remainingMs: Math.max(0, this.startedAt + q.time * 1000 - Date.now()),
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
    this.timers.push(window.setTimeout(fn, ms))
  }

  private clearTimers() {
    this.timers.forEach((t) => window.clearTimeout(t))
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
    }
  }

  private persist() {
    const save: SavedGame = {
      v: 1,
      pin: this.pin,
      phase: this.phase,
      setId: this.set.id,
      quick: this.quick,
      qIndex: this.qIndex,
      players: this.players.map((p) => ({ ...p, answer: undefined, connected: false })),
      stats: this.stats,
      banned: [...this.banned],
      savedAt: Date.now(),
    }
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify(save))
    } catch {
      /* úložiště nemusí být k dispozici */
    }
  }

  private restore(s: SavedGame) {
    this.set = QUESTION_SETS.find((x) => x.id === s.setId) ?? QUESTION_SETS[0]
    this.quick = s.quick
    this.questions = questionsOf(this.set, this.quick)
    this.players = s.players.map((p) => ({ ...p, connected: false, answer: undefined }))
    this.stats = s.stats ?? []
    this.banned = new Set(s.banned ?? [])
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
