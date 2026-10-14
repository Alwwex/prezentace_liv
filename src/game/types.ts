// ---------- Otázky ----------

interface QuestionBase {
  id: string
  /** Text otázky zobrazený na plátně. */
  text: string
  /** Časový limit v sekundách. */
  time: number
  /** Zajímavost, která se ukáže po vyhodnocení otázky. */
  fact: string
  /** Dvojnásobné body (finálová otázka). */
  double?: boolean
}

/** Klasická otázka se 2–4 možnostmi, právě jedna je správně. */
export interface QuizQuestion extends QuestionBase {
  type: 'quiz'
  options: string[]
  correct: number
  /** Zobrazí text otázky jako citát. */
  quote?: boolean
}

/** Pravda, nebo lež? */
export interface TrueFalseQuestion extends QuestionBase {
  type: 'truefalse'
  correct: boolean
}

/** Vyber všechny správné možnosti. */
export interface MultiQuestion extends QuestionBase {
  type: 'multi'
  options: string[]
  correct: number[]
}

/** Seřaď položky – v datech jsou uvedeny ve správném pořadí. */
export interface OrderQuestion extends QuestionBase {
  type: 'order'
  items: string[]
  /** Popisky ke správnému pořadí (např. letopočty), zobrazí se až ve výsledcích. */
  labels?: string[]
}

/** Odhadni číslo na posuvníku. */
export interface SliderQuestion extends QuestionBase {
  type: 'slider'
  min: number
  max: number
  step: number
  answer: number
  /** Při jaké odchylce už hráč nedostane žádné body. */
  maxOff: number
  unit?: string
}

/** „Kdo jsem?“ – nápovědy se odkrývají postupně, kdo odpoví dřív, dostane víc bodů. */
export interface HintsQuestion extends QuestionBase {
  type: 'hints'
  hints: string[]
  options: string[]
  correct: number
}

export type Question =
  | QuizQuestion
  | TrueFalseQuestion
  | MultiQuestion
  | OrderQuestion
  | SliderQuestion
  | HintsQuestion

export type QuestionType = Question['type']

export interface QuestionSet {
  id: string
  title: string
  subtitle: string
  questions: Question[]
  /** Id otázek pro krátkou verzi hry. */
  quick?: string[]
}

/** Odpověď hráče – index, pole indexů (multi/order) nebo číslo (slider). */
export type Answer = number | number[]

// ---------- Co vidí hráč (bez správných odpovědí) ----------

export type PublicQuestion =
  | { type: 'quiz'; options: string[]; quote?: boolean }
  | { type: 'truefalse' }
  | { type: 'multi'; options: string[] }
  | { type: 'order'; items: { id: number; text: string }[] }
  | { type: 'slider'; min: number; max: number; step: number; unit?: string }
  | { type: 'hints'; options: string[]; hints: string[]; hintTimes: number[] }

export interface PlayerResult {
  correct: boolean
  /** 0–1, podíl správnosti (u řazení, výběru více možností a odhadu). */
  fraction: number
  points: number
  streakBonus: number
  joker: boolean
  answered: boolean
  correctText: string
}

export interface MeInfo {
  name: string
  avatar: string
  score: number
  rank: number
  streak: number
  jokerUsed: boolean
}

export type PlayerView =
  | { phase: 'lobby'; me: MeInfo; players: number }
  | { phase: 'intro'; me: MeInfo; qIndex: number; qTotal: number; type: QuestionType; double: boolean; text: string }
  | {
      phase: 'question'
      me: MeInfo
      qIndex: number
      qTotal: number
      text: string
      double: boolean
      question: PublicQuestion
      remainingMs: number
      totalMs: number
      answered: boolean
    }
  | {
      phase: 'result'
      me: MeInfo
      qIndex: number
      qTotal: number
      result: PlayerResult
      behind: { name: string; gap: number } | null
    }
  | { phase: 'leaderboard'; me: MeInfo; qIndex: number; qTotal: number }
  | { phase: 'final'; me: MeInfo; total: number }

// ---------- Zprávy mezi hostitelem a hráči ----------

export type ClientMsg =
  | { t: 'hello'; playerId: string; name: string; avatar: string }
  | { t: 'answer'; qIndex: number; answer: Answer; joker: boolean }
  | { t: 'react'; emoji: string }
  | { t: 'ping' }

export type HostMsg =
  | { t: 'welcome'; playerId: string; name: string }
  | { t: 'rejected'; reason: string }
  | { t: 'view'; view: PlayerView }
  | { t: 'kicked' }
  | { t: 'pong' }
