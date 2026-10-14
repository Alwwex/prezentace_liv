import type { Answer, PublicQuestion, Question } from './types'

export const BASE_POINTS = 1000
export const STREAK_STEP = 100
export const STREAK_MAX = 500

export const TYPE_LABEL: Record<Question['type'], string> = {
  quiz: 'Kvíz',
  truefalse: 'Pravda, nebo lež?',
  multi: 'Vyber všechna správná',
  order: 'Seřaď',
  slider: 'Odhadni číslo',
  hints: 'Kdo jsem?',
}

export const TF_OPTIONS = ['Pravda', 'Lež']

/** Možnosti, které se zobrazí jako barevné dlaždice (nebo null u řazení a odhadu). */
export function tileOptions(q: Question): string[] | null {
  switch (q.type) {
    case 'quiz':
    case 'multi':
    case 'hints':
      return q.options
    case 'truefalse':
      return TF_OPTIONS
    default:
      return null
  }
}

/** Je možnost i správná? (pro dlaždicové otázky) */
export function isCorrectOption(q: Question, i: number): boolean {
  switch (q.type) {
    case 'quiz':
    case 'hints':
      return q.correct === i
    case 'truefalse':
      return (q.correct ? 0 : 1) === i
    case 'multi':
      return q.correct.includes(i)
    default:
      return false
  }
}

function shuffle<T>(arr: T[]): T[] {
  const a = arr.slice()
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

/** Zamíchá položky k řazení tak, aby nebyly ve správném pořadí. */
export function shuffledOrder(n: number): number[] {
  const ids = Array.from({ length: n }, (_, i) => i)
  if (n < 2) return ids
  let s = shuffle(ids)
  while (s.every((v, i) => v === i)) s = shuffle(ids)
  return s
}

export function toPublic(q: Question, orderShuffle: number[]): PublicQuestion {
  switch (q.type) {
    case 'quiz':
      return { type: 'quiz', options: q.options, quote: q.quote }
    case 'truefalse':
      return { type: 'truefalse' }
    case 'multi':
      return { type: 'multi', options: q.options }
    case 'hints':
      return { type: 'hints', options: q.options, hints: q.hints, hintTimes: hintTimes(q) }
    case 'order':
      return { type: 'order', items: orderShuffle.map((id) => ({ id, text: q.items[id] })) }
    case 'slider':
      return { type: 'slider', min: q.min, max: q.max, step: q.step, unit: q.unit }
  }
}

/** Vrací podíl správnosti 0–1 a zda je odpověď úplně správně. */
export function evaluate(q: Question, a: Answer | undefined): { fraction: number; correct: boolean } {
  if (a === undefined) return { fraction: 0, correct: false }
  switch (q.type) {
    case 'quiz':
    case 'hints': {
      const ok = a === q.correct
      return { fraction: ok ? 1 : 0, correct: ok }
    }
    case 'truefalse': {
      const ok = a === (q.correct ? 0 : 1)
      return { fraction: ok ? 1 : 0, correct: ok }
    }
    case 'multi': {
      if (!Array.isArray(a)) return { fraction: 0, correct: false }
      const sel = new Set(a)
      let good = 0
      let bad = 0
      sel.forEach((i) => (q.correct.includes(i) ? good++ : bad++))
      const fraction = Math.max(0, (good - bad) / q.correct.length)
      return { fraction, correct: fraction === 1 && bad === 0 }
    }
    case 'order': {
      if (!Array.isArray(a) || a.length !== q.items.length) return { fraction: 0, correct: false }
      const right = a.filter((id, pos) => id === pos).length
      return { fraction: right / q.items.length, correct: right === q.items.length }
    }
    case 'slider': {
      if (typeof a !== 'number') return { fraction: 0, correct: false }
      const off = Math.abs(a - q.answer)
      return { fraction: Math.max(0, 1 - off / q.maxOff), correct: off === 0 }
    }
  }
}

/**
 * Body za otázku: rychlost se počítá jako u Kahootu (okamžitá odpověď = 100 %,
 * odpověď v poslední vteřině = 50 %), k tomu násobek za žolíka a finálovou otázku.
 */
export function questionPoints(
  q: Question,
  fraction: number,
  elapsedMs: number,
  joker: boolean,
): number {
  if (fraction <= 0) return 0
  const t = Math.min(1, Math.max(0, elapsedMs / (q.time * 1000)))
  const speed = 1 - t / 2
  const mult = (q.double ? 2 : 1) * (joker ? 2 : 1)
  return Math.round(BASE_POINTS * fraction * speed * mult)
}

export function streakBonus(streak: number): number {
  if (streak < 2) return 0
  return Math.min(STREAK_MAX, (streak - 1) * STREAK_STEP)
}

/** Text správné odpovědi pro telefon hráče. */
export function correctText(q: Question): string {
  switch (q.type) {
    case 'quiz':
    case 'hints':
      return q.options[q.correct]
    case 'truefalse':
      return q.correct ? 'Pravda' : 'Lež'
    case 'multi':
      return q.correct.map((i) => q.options[i]).join(' + ')
    case 'order':
      return q.items.map((t, i) => `${i + 1}. ${t}`).join('  ')
    case 'slider':
      return `${q.answer}${q.unit ? ' ' + q.unit : ''}`
  }
}

/** Kdy se ukáže která nápověda (ms od začátku otázky). */
export function hintTimes(q: Question): number[] {
  if (q.type !== 'hints') return []
  const step = (q.time * 1000) / (q.hints.length + 0.5)
  return q.hints.map((_, i) => Math.round(i * step))
}
