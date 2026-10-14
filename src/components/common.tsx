import { useEffect, useMemo, useState } from 'react'
import QRCode from 'qrcode'
import confetti from 'canvas-confetti'
import { sound } from '../game/sound'
import type { QuestionType } from '../game/types'

// ---------- Barvy a tvary odpovědí (jako u Kahootu) ----------

export const TILE_COLORS = ['#C93838', '#2F6DB5', '#B5740C', '#26804E']
export const SHAPES = ['triangle', 'diamond', 'circle', 'square'] as const

/** U „Pravda, nebo lež?“ je pravda modrý kosočtverec a lež červený trojúhelník. */
export function tileLook(type: QuestionType, i: number): { color: string; shape: (typeof SHAPES)[number] } {
  if (type === 'truefalse') return i === 0 ? { color: TILE_COLORS[1], shape: 'diamond' } : { color: TILE_COLORS[0], shape: 'triangle' }
  return { color: TILE_COLORS[i % 4], shape: SHAPES[i % 4] }
}

export function Shape({ shape, size = 32 }: { shape: (typeof SHAPES)[number]; size?: number }) {
  return (
    <svg className="shape" width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      {shape === 'triangle' && <path d="M16 3 L30 28 H2 Z" fill="currentColor" />}
      {shape === 'diamond' && <path d="M16 1 L31 16 L16 31 L1 16 Z" fill="currentColor" />}
      {shape === 'circle' && <circle cx="16" cy="16" r="14" fill="currentColor" />}
      {shape === 'square' && <rect x="3" y="3" width="26" height="26" rx="2" fill="currentColor" />}
    </svg>
  )
}

// ---------- Čas ----------

export function useNow(interval = 100) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), interval)
    return () => window.clearInterval(id)
  }, [interval])
  return now
}

export function TimerRing({ deadline, total, size = 120 }: { deadline: number; total: number; size?: number }) {
  const now = useNow(100)
  const left = Math.max(0, deadline - now)
  const frac = total > 0 ? left / total : 0
  const secs = Math.ceil(left / 1000)
  const r = 44
  const c = 2 * Math.PI * r
  return (
    <div className={`timer-ring ${secs <= 5 ? 'urgent' : ''}`} style={{ width: size, height: size }} role="timer" aria-label={`Zbývá ${secs} sekund`}>
      <svg viewBox="0 0 100 100">
        <circle cx="50" cy="50" r={r} className="timer-track" />
        <circle
          cx="50"
          cy="50"
          r={r}
          className="timer-bar"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - frac)}
          transform="rotate(-90 50 50)"
        />
      </svg>
      <span>{secs}</span>
    </div>
  )
}

/** Odtikávání posledních vteřin. */
export function useTicking(deadline: number, active: boolean) {
  const now = useNow(250)
  const secs = Math.ceil((deadline - now) / 1000)
  useEffect(() => {
    if (active && secs > 0 && secs <= 5) sound.tick(secs <= 3)
  }, [secs, active])
}

// ---------- QR kód ----------

export function QR({ text, size = 220 }: { text: string; size?: number }) {
  const [svg, setSvg] = useState('')
  useEffect(() => {
    QRCode.toString(text, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#2A0A14', light: '#FFFFFF' } })
      .then(setSvg)
      .catch(() => setSvg(''))
  }, [text])
  return <div className="qr" style={{ width: size, height: size }} dangerouslySetInnerHTML={{ __html: svg }} aria-label="QR kód pro připojení" />
}

// ---------- Konfety ----------

export function fireConfetti(big = false) {
  const colors = ['#E2B85A', '#F3EFF0', '#C93838', '#8C3B4E', '#FFFFFF']
  confetti({ particleCount: big ? 160 : 80, spread: big ? 100 : 70, origin: { y: 0.6 }, colors, disableForReducedMotion: true })
  if (big) {
    window.setTimeout(() => confetti({ particleCount: 80, angle: 60, spread: 60, origin: { x: 0, y: 0.7 }, colors, disableForReducedMotion: true }), 250)
    window.setTimeout(() => confetti({ particleCount: 80, angle: 120, spread: 60, origin: { x: 1, y: 0.7 }, colors, disableForReducedMotion: true }), 400)
  }
}

// ---------- Lokomotiva ----------

export function Locomotive({ avatar, color = '#5B1A2B', moving = false }: { avatar: string; color?: string; moving?: boolean }) {
  return (
    <svg className={`loco ${moving ? 'moving' : ''}`} viewBox="0 0 132 72" aria-hidden="true">
      {/* komín */}
      <path d="M86 6 h16 l-4 14 h-8 Z" fill="#2A1A1F" />
      {/* kotel */}
      <rect x="62" y="20" width="56" height="26" rx="12" fill={color} />
      <rect x="62" y="30" width="56" height="4" fill="#E2B85A" opacity=".85" />
      <circle cx="116" cy="33" r="5" fill="#F7E3A8" />
      {/* budka strojvedoucího */}
      <rect x="18" y="8" width="48" height="40" rx="4" fill={color} />
      <rect x="14" y="4" width="56" height="7" rx="3" fill="#2A1A1F" />
      <rect x="25" y="15" width="34" height="24" rx="4" fill="#F3EFF0" />
      <text x="42" y="34" textAnchor="middle" fontSize="18">
        {avatar}
      </text>
      {/* rám a pluh */}
      <rect x="14" y="46" width="108" height="6" rx="2" fill="#2A1A1F" />
      <path d="M120 46 l10 12 h-14 Z" fill="#2A1A1F" />
      {/* kola */}
      {[34, 62, 94].map((cx, i) => (
        <g key={cx} className="wheel" style={{ transformOrigin: `${cx}px ${i === 0 ? 56 : 58}px` }}>
          <circle cx={cx} cy={i === 0 ? 56 : 58} r={i === 0 ? 12 : 10} fill="#2A1A1F" stroke="#E2B85A" strokeWidth="2.5" />
          <path
            d={`M${cx - 8} ${i === 0 ? 56 : 58} h16 M${cx} ${(i === 0 ? 56 : 58) - 8} v16`}
            stroke="#E2B85A"
            strokeWidth="2"
          />
        </g>
      ))}
      <rect x="34" y="54" width="60" height="3" rx="1.5" fill="#B8913A" />
    </svg>
  )
}

// ---------- Ostatní ----------

export function MuteButton() {
  const [muted, setMuted] = useState(sound.muted)
  return (
    <button
      className="icon-btn"
      onClick={() => {
        sound.unlock()
        sound.setMuted(!muted)
        setMuted(!muted)
      }}
      aria-label={muted ? 'Zapnout zvuk' : 'Vypnout zvuk'}
      title={muted ? 'Zapnout zvuk' : 'Vypnout zvuk'}
    >
      {muted ? '🔇' : '🔊'}
    </button>
  )
}

export function FullscreenButton() {
  return (
    <button
      className="icon-btn"
      onClick={() => {
        if (document.fullscreenElement) void document.exitFullscreen()
        else void document.documentElement.requestFullscreen?.()
      }}
      aria-label="Celá obrazovka"
      title="Celá obrazovka"
    >
      ⛶
    </button>
  )
}

export function formatPin(pin: string) {
  return pin.length === 6 ? `${pin.slice(0, 3)} ${pin.slice(3)}` : pin
}

/** Plynule „napočítá“ číslo. */
export function useCountUp(target: number, from: number, ms = 1200) {
  const [val, setVal] = useState(from)
  useEffect(() => {
    let raf = 0
    const start = performance.now()
    const run = (t: number) => {
      const k = Math.min(1, (t - start) / ms)
      const e = 1 - Math.pow(1 - k, 3)
      setVal(Math.round(from + (target - from) * e))
      if (k < 1) raf = requestAnimationFrame(run)
    }
    raf = requestAnimationFrame(run)
    return () => cancelAnimationFrame(raf)
  }, [target, from, ms])
  return val
}

export function TypeIcon({ type }: { type: QuestionType }) {
  const icon = useMemo(
    () => ({ quiz: '❓', truefalse: '⚖️', multi: '☑️', order: '🔢', slider: '🎚️', hints: '🕵️' })[type],
    [type],
  )
  return <span className="type-icon" aria-hidden="true">{icon}</span>
}

export function czPlayers(n: number) {
  return n >= 1 && n <= 4 ? `${n} cestující` : `${n} cestujících`
}

export function czPoints(n: number) {
  const abs = Math.abs(n)
  const num = n.toLocaleString('cs-CZ')
  if (abs === 1) return `${num} bod`
  if (abs >= 2 && abs <= 4) return `${num} body`
  return `${num} bodů`
}
