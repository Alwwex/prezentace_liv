import { useState } from 'react'
import { Shape, tileLook } from './common'
import { TF_OPTIONS } from '../game/scoring'
import type { Answer, PublicQuestion } from '../game/types'

interface Props {
  question: PublicQuestion
  onSubmit: (a: Answer) => void
  /** Uplynulý čas otázky v ms – kvůli odkrývání nápověd. */
  elapsedMs?: number
  showHints?: boolean
}

/** Ovládání odpovědi pro telefon hráče (a pro trénink jednoho hráče). */
export function AnswerPad({ question, onSubmit, elapsedMs = 0, showHints = true }: Props) {
  switch (question.type) {
    case 'quiz':
      return <Tiles type="quiz" options={question.options} onPick={onSubmit} />
    case 'truefalse':
      return <Tiles type="truefalse" options={TF_OPTIONS} onPick={onSubmit} />
    case 'hints':
      return (
        <div className="pad-hints">
          {showHints && (
            <ol className="mini-hints">
              {question.hints.map((h, i) =>
                elapsedMs >= question.hintTimes[i] ? (
                  <li key={i} className="pop-in">
                    {h}
                  </li>
                ) : (
                  <li key={i} className="locked">
                    Nápověda {i + 1} se odkryje za {Math.ceil((question.hintTimes[i] - elapsedMs) / 1000)} s
                  </li>
                ),
              )}
            </ol>
          )}
          <Tiles type="hints" options={question.options} onPick={onSubmit} />
        </div>
      )
    case 'multi':
      return <MultiPad options={question.options} onSubmit={onSubmit} />
    case 'order':
      return <OrderPad items={question.items} onSubmit={onSubmit} />
    case 'slider':
      return <SliderPad {...question} onSubmit={onSubmit} />
  }
}

function Tiles({ type, options, onPick }: { type: PublicQuestion['type']; options: string[]; onPick: (i: number) => void }) {
  return (
    <div className={`pad-tiles n${options.length}`}>
      {options.map((o, i) => {
        const look = tileLook(type, i)
        return (
          <button key={i} className="pad-tile" style={{ background: look.color }} onClick={() => onPick(i)}>
            <Shape shape={look.shape} size={30} />
            <span>{o}</span>
          </button>
        )
      })}
    </div>
  )
}

function MultiPad({ options, onSubmit }: { options: string[]; onSubmit: (a: number[]) => void }) {
  const [sel, setSel] = useState<number[]>([])
  const toggle = (i: number) => setSel((s) => (s.includes(i) ? s.filter((x) => x !== i) : [...s, i]))
  return (
    <div className="pad-multi">
      <div className="pad-tiles n4">
        {options.map((o, i) => {
          const look = tileLook('multi', i)
          const on = sel.includes(i)
          return (
            <button
              key={i}
              className={`pad-tile toggle ${on ? 'on' : ''}`}
              style={{ background: look.color }}
              onClick={() => toggle(i)}
              aria-pressed={on}
            >
              <Shape shape={look.shape} size={30} />
              <span>{o}</span>
              <i className="check" aria-hidden="true">{on ? '✓' : ''}</i>
            </button>
          )
        })}
      </div>
      <button className="btn btn-gold btn-block" disabled={sel.length === 0} onClick={() => onSubmit(sel.slice().sort())}>
        Odeslat ({sel.length})
      </button>
    </div>
  )
}

function OrderPad({ items, onSubmit }: { items: { id: number; text: string }[]; onSubmit: (a: number[]) => void }) {
  const [seq, setSeq] = useState<number[]>([])
  const tap = (id: number) => setSeq((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]))
  return (
    <div className="pad-order">
      <p className="pad-help">Ťukej na události od nejstarší. Dalším ťuknutím pořadí zrušíš.</p>
      <div className="order-list">
        {items.map((it) => {
          const pos = seq.indexOf(it.id)
          return (
            <button key={it.id} className={`order-item ${pos >= 0 ? 'on' : ''}`} onClick={() => tap(it.id)}>
              <b className="order-num">{pos >= 0 ? pos + 1 : ''}</b>
              <span>{it.text}</span>
            </button>
          )
        })}
      </div>
      <div className="pad-row">
        <button className="btn btn-ghost" onClick={() => setSeq([])} disabled={seq.length === 0}>
          Vymazat
        </button>
        <button className="btn btn-gold grow" disabled={seq.length !== items.length} onClick={() => onSubmit(seq)}>
          Odeslat pořadí
        </button>
      </div>
    </div>
  )
}

function SliderPad({
  min,
  max,
  step,
  unit,
  onSubmit,
}: {
  min: number
  max: number
  step: number
  unit?: string
  onSubmit: (a: number) => void
}) {
  const [val, setVal] = useState(Math.round((min + max) / 2 / step) * step)
  const clamp = (v: number) => Math.min(max, Math.max(min, v))
  return (
    <div className="pad-slider">
      <div className="slider-value" aria-live="polite">
        {val}
        {unit && <small> {unit}</small>}
      </div>
      <div className="pad-row">
        <button className="btn btn-round" onClick={() => setVal((v) => clamp(v - step))} aria-label="Méně">
          −
        </button>
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={val}
          onChange={(e) => setVal(Number(e.target.value))}
          aria-label="Tvůj odhad"
        />
        <button className="btn btn-round" onClick={() => setVal((v) => clamp(v + step))} aria-label="Více">
          +
        </button>
      </div>
      <div className="slider-scale">
        <span>{min}</span>
        <span>{max}</span>
      </div>
      <button className="btn btn-gold btn-block" onClick={() => onSubmit(val)}>
        Odeslat odhad
      </button>
    </div>
  )
}
