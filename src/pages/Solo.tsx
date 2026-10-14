import { useEffect, useMemo, useState } from 'react'
import { QUESTION_SETS } from '../data/questions'
import {
  correctText,
  evaluate,
  questionPoints,
  shuffledOrder,
  streakBonus,
  toPublic,
} from '../game/scoring'
import { sound, vibrate } from '../game/sound'
import { AnswerPad } from '../components/AnswerPad'
import { FactCard, QuestionCenter, QuestionHeading } from '../components/Stage'
import { MuteButton, TimerRing, czPoints, fireConfetti, useNow, useTicking } from '../components/common'
import type { Answer, Question } from '../game/types'

interface Done {
  correct: boolean
  fraction: number
  points: number
  bonus: number
  answered: boolean
}

type Phase = 'start' | 'question' | 'result' | 'final'

/** Trénink pro jednoho hráče – funguje i bez připojení dalších zařízení. */
export function SoloPage() {
  const set = QUESTION_SETS[0]
  const [quick, setQuick] = useState(false)
  const questions = useMemo(
    () => (quick && set.quick ? set.questions.filter((q) => set.quick!.includes(q.id)) : set.questions),
    [quick, set],
  )
  const [phase, setPhase] = useState<Phase>('start')
  const [i, setI] = useState(0)
  const [startedAt, setStartedAt] = useState(0)
  const [shuffle, setShuffle] = useState<number[]>([])
  const [results, setResults] = useState<Done[]>([])
  const [score, setScore] = useState(0)
  const [streak, setStreak] = useState(0)
  const [jokerUsed, setJokerUsed] = useState(false)
  const [joker, setJoker] = useState(false)
  const [lastJoker, setLastJoker] = useState(false)

  const q = questions[i]

  const begin = (idx: number) => {
    const nq = questions[idx]
    setI(idx)
    setShuffle(nq.type === 'order' ? shuffledOrder(nq.items.length) : [])
    setStartedAt(Date.now())
    setJoker(false)
    setPhase('question')
  }

  const finishQuestion = (a: Answer | undefined) => {
    const elapsed = Date.now() - startedAt
    const { fraction, correct } = evaluate(q, a)
    const useJoker = a !== undefined && joker && !jokerUsed
    const points = a !== undefined ? questionPoints(q, fraction, elapsed, useJoker) : 0
    const ns = correct ? streak + 1 : 0
    const bonus = correct ? streakBonus(ns) : 0
    if (useJoker) setJokerUsed(true)
    setLastJoker(useJoker)
    setStreak(ns)
    setScore((s) => s + points + bonus)
    setResults((r) => [...r, { correct, fraction, points, bonus, answered: a !== undefined }])
    if (correct) {
      sound.correct()
      vibrate([60, 40, 60])
    } else {
      sound.wrong()
      vibrate(200)
    }
    setPhase('result')
  }

  useEffect(() => {
    sound.playMusic(phase === 'question' ? 'question' : null)
  }, [phase])
  useEffect(() => () => sound.playMusic(null), [])

  if (phase === 'start') {
    return (
      <div className="solo">
        <div className="solo-card center">
          <div className="splash-train" aria-hidden="true">
            🎯
          </div>
          <h1 className="title">Trénink pro jednoho</h1>
          <p className="lead">{set.title}: stejné otázky jako ve společné hře, jen si je zahraješ sám nebo sama.</p>
          {set.quick && (
            <div className="seg" role="radiogroup" aria-label="Délka">
              <button role="radio" aria-checked={!quick} className={!quick ? 'on' : ''} onClick={() => setQuick(false)}>
                Celá jízda · {set.questions.length}
              </button>
              <button role="radio" aria-checked={quick} className={quick ? 'on' : ''} onClick={() => setQuick(true)}>
                Rychlík · {set.quick.length}
              </button>
            </div>
          )}
          <button
            className="btn btn-gold btn-xl"
            onClick={() => {
              sound.unlock()
              setResults([])
              setScore(0)
              setStreak(0)
              setJokerUsed(false)
              begin(0)
            }}
          >
            Začít ▶
          </button>
          <a className="link" href="/">
            ← Zpět
          </a>
        </div>
      </div>
    )
  }

  if (phase === 'final') {
    const correct = results.filter((r) => r.correct).length
    return (
      <div className="solo">
        <SoloBar score={score} />
        <div className="solo-card center">
          <FinalConfetti good={correct >= questions.length * 0.7} />
          <div className="big-icon">{correct === questions.length ? '🏆' : correct >= questions.length * 0.7 ? '🚂' : '📚'}</div>
          <h1 className="title">
            {correct} z {questions.length} správně
          </h1>
          <p className="res-points">{czPoints(score)}</p>
          <ol className="solo-review">
            {questions.map((qq, k) => (
              <li key={qq.id} className={results[k]?.correct ? 'ok' : results[k]?.fraction ? 'part' : 'bad'}>
                <span>{results[k]?.correct ? '✓' : results[k]?.fraction ? '≈' : '✗'}</span>
                {qq.type === 'hints' ? `Kdo jsem? – ${qq.options[qq.correct]}` : qq.text}
              </li>
            ))}
          </ol>
          <div className="pad-row">
            <button className="btn btn-gold" onClick={() => setPhase('start')}>
              Hrát znovu
            </button>
            <a className="btn btn-ghost" href="/">
              Domů
            </a>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="solo">
      <SoloBar score={score} />
      <div className="solo-card">
        <QuestionHeading q={q} qIndex={i} qTotal={questions.length} />
        {phase === 'question' ? (
          <SoloQuestion
            key={q.id}
            q={q}
            startedAt={startedAt}
            shuffle={shuffle}
            joker={joker}
            jokerUsed={jokerUsed}
            onJoker={() => setJoker((j) => !j)}
            onAnswer={finishQuestion}
          />
        ) : (
          <SoloResult
            q={q}
            r={results[results.length - 1]}
            streak={streak}
            joker={lastJoker}
            last={i >= questions.length - 1}
            onNext={() => (i >= questions.length - 1 ? setPhase('final') : begin(i + 1))}
          />
        )}
      </div>
    </div>
  )
}

function SoloBar({ score }: { score: number }) {
  return (
    <header className="host-bar solo-bar">
      <a className="brand" href="/">
        <span aria-hidden="true">🚂</span> Expres Anna Karenina
      </a>
      <div className="bar-right">
        <span className="ph-score">{score.toLocaleString('cs-CZ')}</span>
        <MuteButton />
      </div>
    </header>
  )
}

function SoloQuestion({
  q,
  startedAt,
  shuffle,
  joker,
  jokerUsed,
  onJoker,
  onAnswer,
}: {
  q: Question
  startedAt: number
  shuffle: number[]
  joker: boolean
  jokerUsed: boolean
  onJoker: () => void
  onAnswer: (a: Answer | undefined) => void
}) {
  const now = useNow(200)
  const total = q.time * 1000
  const deadline = startedAt + total
  useTicking(deadline, true)
  const expired = now >= deadline
  useEffect(() => {
    if (expired) onAnswer(undefined)
  }, [expired])
  const pub = useMemo(() => toPublic(q, shuffle), [q, shuffle])
  return (
    <div className="solo-q">
      <div className="solo-q-top">
        <TimerRing deadline={deadline} total={total} size={84} />
        {q.type === 'slider' || q.type === 'order' ? null : (
          <div className="solo-center">
            <QuestionCenter q={q} orderShuffle={shuffle} elapsedMs={now - startedAt} />
          </div>
        )}
      </div>
      {!jokerUsed && (
        <button className={`joker ${joker ? 'on' : ''}`} onClick={onJoker} aria-pressed={joker}>
          ⚡ Expres ×2 {joker ? 'zapnut' : '· jednou za hru zdvojnásobí body'}
        </button>
      )}
      <AnswerPad question={pub} onSubmit={onAnswer} elapsedMs={now - startedAt} showHints={false} />
    </div>
  )
}

function SoloResult({
  q,
  r,
  streak,
  joker,
  last,
  onNext,
}: {
  q: Question
  r: Done
  streak: number
  joker: boolean
  last: boolean
  onNext: () => void
}) {
  const kind = !r.answered ? 'none' : r.correct ? 'ok' : r.fraction > 0 ? 'part' : 'bad'
  const title = { ok: 'Správně!', part: 'Skoro!', bad: 'Tohle nevyšlo', none: 'Čas vypršel' }[kind]
  return (
    <div className="solo-result">
      <div className={`solo-verdict res-${kind}`}>
        <b>{title}</b>
        <span>+{(r.points + r.bonus).toLocaleString('cs-CZ')}</span>
        {r.bonus > 0 && <span className="chip">🔥 Série {streak} · +{r.bonus}</span>}
        {joker && <span className="chip chip-gold">⚡ ×2</span>}
      </div>
      {kind !== 'ok' && (
        <p className="res-correct">
          Správně: <b>{correctText(q)}</b>
        </p>
      )}
      <FactCard fact={q.fact} />
      <button className="btn btn-gold btn-lg" onClick={onNext} autoFocus>
        {last ? 'Výsledky 🏁' : 'Další otázka →'}
      </button>
    </div>
  )
}

function FinalConfetti({ good }: { good: boolean }) {
  useEffect(() => {
    if (good) {
      sound.fanfare()
      fireConfetti(true)
    }
  }, [good])
  return null
}
