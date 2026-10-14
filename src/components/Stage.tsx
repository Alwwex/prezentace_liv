import { useEffect, useMemo, useState } from 'react'
import { Locomotive, Shape, TypeIcon, czPoints, fireConfetti, tileLook, useCountUp } from './common'
import { TYPE_LABEL, hintTimes, isCorrectOption, tileOptions } from '../game/scoring'
import { sound } from '../game/sound'
import type { Answer, Question } from '../game/types'
import type { HostPlayer } from '../game/host'

// ---------- Otázka na plátně ----------

export function QuestionHeading({ q, qIndex, qTotal }: { q: Question; qIndex: number; qTotal: number }) {
  return (
    <div className="q-heading">
      <div className="q-meta">
        <span className="chip">
          <TypeIcon type={q.type} /> {TYPE_LABEL[q.type]}
        </span>
        <span className="chip chip-dim">
          Otázka {qIndex + 1} / {qTotal}
        </span>
        {q.double && <span className="chip chip-gold">Finále · dvojnásobné body</span>}
      </div>
      {q.type === 'quiz' && q.quote ? (
        <blockquote className="q-text q-quote">„{q.text}“</blockquote>
      ) : (
        <h1 className="q-text">{q.text}</h1>
      )}
    </div>
  )
}

/** Prostřední část plátna během otázky (nápovědy, číselná osa, položky k řazení). */
export function QuestionCenter({ q, orderShuffle, elapsedMs }: { q: Question; orderShuffle: number[]; elapsedMs: number }) {
  if (q.type === 'hints') {
    const times = hintTimes(q)
    return (
      <ol className="hint-cards">
        {q.hints.map((h, i) => {
          const open = elapsedMs >= times[i]
          return (
            <li key={i} className={open ? 'open' : 'closed'}>
              <span className="hint-no">{i + 1}</span>
              {open ? <span className="hint-text">{h}</span> : <span className="hint-wait">odkryje se za {Math.max(1, Math.ceil((times[i] - elapsedMs) / 1000))} s</span>}
            </li>
          )
        })}
      </ol>
    )
  }
  if (q.type === 'order') {
    return (
      <ul className="order-cards">
        {orderShuffle.map((id) => (
          <li key={id}>{q.items[id]}</li>
        ))}
      </ul>
    )
  }
  if (q.type === 'slider') {
    return (
      <div className="numline big">
        <div className="numline-bar" />
        <div className="numline-q" style={{ left: '50%' }}>
          ?
        </div>
        <span className="numline-min">{q.min}</span>
        <span className="numline-max">{q.max}</span>
        <p className="numline-help">Hráči posouvají odhad na svých telefonech. Čím blíž, tím víc bodů.</p>
      </div>
    )
  }
  if (q.type === 'multi') return <p className="center-help">Může být správně víc možností. Za každou chybnou se body strhávají.</p>
  return null
}

export function Tiles({ q, reveal }: { q: Question; reveal?: boolean }) {
  const opts = tileOptions(q)
  if (!opts) return null
  return (
    <div className={`stage-tiles n${opts.length}`}>
      {opts.map((o, i) => {
        const look = tileLook(q.type, i)
        const ok = isCorrectOption(q, i)
        const dim = reveal && !ok
        return (
          <div key={i} className={`stage-tile ${dim ? 'dim' : ''}`} style={{ background: look.color }}>
            <Shape shape={look.shape} size={40} />
            <span className="tile-text">{o}</span>
            {reveal && <span className="tile-mark">{ok ? '✓' : '✗'}</span>}
          </div>
        )
      })}
    </div>
  )
}

// ---------- Vyhodnocení otázky ----------

export function ResultCenter({ q, answers, players }: { q: Question; answers: Answer[]; players: { name: string; value?: Answer }[] }) {
  const opts = tileOptions(q)
  if (opts) {
    const counts = opts.map((_, i) =>
      answers.filter((a) => (Array.isArray(a) ? a.includes(i) : a === i)).length,
    )
    const max = Math.max(1, ...counts)
    return (
      <div className="bars">
        {opts.map((_, i) => {
          const look = tileLook(q.type, i)
          const ok = isCorrectOption(q, i)
          return (
            <div key={i} className={`bar-col ${ok ? 'ok' : 'no'}`}>
              <span className="bar-count">{counts[i]}</span>
              <div className="bar" style={{ height: `${8 + (counts[i] / max) * 92}%`, background: look.color }} />
              <div className="bar-foot" style={{ background: look.color }}>
                <Shape shape={look.shape} size={26} />
                {ok && <b>✓</b>}
              </div>
            </div>
          )
        })}
      </div>
    )
  }
  if (q.type === 'order') {
    const full = answers.filter((a) => Array.isArray(a) && a.every((id, pos) => id === pos)).length
    return (
      <div className="order-result">
        <ol>
          {q.items.map((t, i) => {
            const right = answers.filter((a) => Array.isArray(a) && a[i] === i).length
            const pct = answers.length ? Math.round((right / answers.length) * 100) : 0
            return (
              <li key={i} style={{ animationDelay: `${i * 0.25}s` }}>
                <span className="order-pos">{i + 1}</span>
                <span className="order-text">{t}</span>
                {q.labels?.[i] && <span className="order-label">{q.labels[i]}</span>}
                <span className="order-pct">{pct} %</span>
              </li>
            )
          })}
        </ol>
        <p className="order-help">
          Celé pořadí správně: <b>{full}</b> z {answers.length} · procenta ukazují, kolik hráčů dalo položku na správné místo
        </p>
      </div>
    )
  }
  if (q.type === 'slider') {
    const range = q.max - q.min
    const pos = (v: number) => `${((v - q.min) / range) * 100}%`
    const stacks = new Map<number, number>()
    const guesses = players.filter((p) => typeof p.value === 'number') as { name: string; value: number }[]
    let best: { name: string; value: number } | null = null
    for (const g of guesses) {
      if (!best || Math.abs(g.value - q.answer) < Math.abs(best.value - q.answer)) best = g
    }
    return (
      <div className="numline big result">
        <div className="numline-bar" />
        {guesses.map((g, i) => {
          const level = stacks.get(g.value) ?? 0
          stacks.set(g.value, level + 1)
          return (
            <span
              key={i}
              className="numline-dot"
              title={`${g.name}: ${g.value}`}
              style={{ left: pos(g.value), bottom: `calc(50% + ${14 + level * 16}px)`, animationDelay: `${i * 0.03}s` }}
            />
          )
        })}
        <div className="numline-answer" style={{ left: pos(q.answer) }}>
          {q.answer}
          {q.unit && <small> {q.unit}</small>}
        </div>
        <span className="numline-min">{q.min}</span>
        <span className="numline-max">{q.max}</span>
        <p className="numline-help">
          {best ? (
            <>
              Nejblíž: <b>{best.name}</b> ({best.value}){best.value === q.answer ? ' – přesně!' : ''}
            </>
          ) : (
            'Nikdo netipoval.'
          )}
        </p>
      </div>
    )
  }
  return null
}

export function FactCard({ fact }: { fact: string }) {
  return (
    <aside className="fact">
      <span className="fact-label">Věděli jste?</span>
      <p>{fact}</p>
    </aside>
  )
}

// ---------- Závod vlaků (průběžné pořadí) ----------

const LANE_COLORS = ['#7A2639', '#2F4858', '#8C5A12', '#26604A', '#5A3470']

export function TrainRace({ players, qIndex, qTotal }: { players: HostPlayer[]; qIndex: number; qTotal: number }) {
  const sorted = useMemo(() => players.slice().sort((a, b) => a.rank - b.rank), [players])
  const top = sorted.slice(0, 5)
  const progress = (qIndex + 1) / qTotal
  const prevProgress = qIndex / qTotal
  const leader = Math.max(1, ...players.map((p) => p.score))
  const prevLeader = Math.max(1, ...players.map((p) => p.prevScore))
  const [go, setGo] = useState(false)
  useEffect(() => {
    sound.whistle()
    const t = window.setTimeout(() => setGo(true), 150)
    return () => window.clearTimeout(t)
  }, [])

  const climber = sorted
    .filter((p) => p.prevRank - p.rank >= 2)
    .sort((a, b) => b.prevRank - b.rank - (a.prevRank - a.rank))[0]

  return (
    <div className="race">
      <div className="race-stations">
        <span className="station">🏛️ Moskva</span>
        <span className="race-progress">
          {qIndex + 1} z {qTotal} úseků trati
        </span>
        <span className="station">Petrohrad 🏁</span>
      </div>
      <div className="lanes">
        {top.map((p, i) => {
          const from = (p.prevScore / prevLeader) * prevProgress
          const to = (p.score / leader) * progress
          const x = go ? to : from
          const delta = p.prevRank - p.rank
          return (
            <div key={p.id} className="lane" style={{ animationDelay: `${i * 0.08}s` }}>
              <span className="lane-rank">{p.rank}</span>
              <div className="track">
                <div className="train" style={{ left: `calc(${x} * (100% - var(--train-w)))` }}>
                  <div className="steam" aria-hidden="true">
                    <i />
                    <i />
                    <i />
                  </div>
                  <Locomotive avatar={p.avatar} color={LANE_COLORS[i]} moving={go && to > from} />
                </div>
              </div>
              <div className="lane-info">
                <b>{p.name}</b>
                <RaceScore from={p.prevScore} to={p.score} />
                {delta > 0 && <span className="rank-up">▲ {delta}</span>}
              </div>
            </div>
          )
        })}
      </div>
      <div className="race-foot">
        {climber && (
          <p className="climber">
            🚀 <b>{climber.name}</b> se posouvá o {czPlaces(climber.prevRank - climber.rank)} nahoru!
          </p>
        )}
        {sorted.length > 5 && <p className="others">a dalších {sorted.length - 5} vlaků za nimi</p>}
      </div>
    </div>
  )
}

function czPlaces(n: number) {
  return n <= 4 ? `${n} místa` : `${n} míst`
}

function RaceScore({ from, to }: { from: number; to: number }) {
  const v = useCountUp(to, from, 1600)
  return <span className="lane-score">{v.toLocaleString('cs-CZ')}</span>
}

// ---------- Stupně vítězů ----------

export function Podium({ players }: { players: HostPlayer[] }) {
  const sorted = useMemo(() => players.slice().sort((a, b) => a.rank - b.rank), [players])
  const [step, setStep] = useState(0)
  useEffect(() => {
    sound.drumroll(Math.min(3, sorted.length) * 1.3)
    const timers = [
      window.setTimeout(() => setStep(1), 1300),
      window.setTimeout(() => setStep(2), 2600),
      window.setTimeout(() => {
        setStep(3)
        sound.fanfare()
        fireConfetti(true)
      }, 3900),
    ]
    return () => timers.forEach((t) => window.clearTimeout(t))
  }, [sorted.length])

  // pořadí na stupních: 2. – 1. – 3.
  const slots: [number, string][] = [
    [1, 'second'],
    [0, 'first'],
    [2, 'third'],
  ]
  const revealAt = [3, 2, 1] // 1. místo se ukáže až jako poslední
  return (
    <div className="podium">
      {slots.map(([idx, cls]) => {
        const p = sorted[idx]
        const shown = step >= revealAt[idx]
        return (
          <div key={cls} className={`podium-col ${cls}`}>
            <div className={`podium-player ${shown && p ? 'shown' : ''}`}>
              {p && (
                <>
                  <span className="podium-avatar">{p.avatar}</span>
                  <b className="podium-name">{p.name}</b>
                  <span className="podium-score">{czPoints(p.score)}</span>
                </>
              )}
            </div>
            <div className="podium-block">
              <span>{idx + 1}</span>
            </div>
          </div>
        )
      })}
    </div>
  )
}
