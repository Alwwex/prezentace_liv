/**
 * Všechny zvuky se generují přímo v prohlížeči přes Web Audio API,
 * takže web nepotřebuje žádné zvukové soubory.
 */

type MusicName = 'lobby' | 'question' | null

const MUTE_KEY = 'expres-ak-muted'

function midi(n: number) {
  return 440 * Math.pow(2, (n - 69) / 12)
}

// Valčík a moll v rytmu 3/4: [doba, tón, délka v dobách]
const WALTZ_MELODY: [number, number, number][] = [
  [0, 69, 1], [1, 72, 1], [2, 76, 1],
  [3, 74, 2], [5, 71, 1],
  [6, 72, 1], [7, 76, 1], [8, 81, 1],
  [9, 77, 2], [11, 74, 1],
  [12, 71, 1], [13, 74, 1], [14, 79, 1],
  [15, 76, 2], [17, 72, 1],
  [18, 71, 1], [19, 68, 1], [20, 71, 1],
  [21, 69, 3],
]
// Akordy po taktech: bas a dva tóny doprovodu
const WALTZ_CHORDS: [number, number[]][] = [
  [45, [60, 64]], [40, [62, 68]], [45, [60, 64]], [38, [62, 65]],
  [43, [62, 67]], [36, [60, 64]], [40, [62, 68]], [45, [60, 64]],
]
// Napínavá smyčka při otázce (osminy, 2 takty 4/4)
const PULSE_BASS = [45, 57, 45, 57, 45, 57, 43, 55, 41, 53, 41, 53, 40, 52, 40, 52]

class SoundEngine {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private noiseBuf: AudioBuffer | null = null
  private music: MusicName = null
  private musicTimer = 0
  private nextTime = 0
  private step = 0
  muted = false

  constructor() {
    try {
      this.muted = localStorage.getItem(MUTE_KEY) === '1'
    } catch {
      /* nic */
    }
  }

  /** Musí se zavolat po kliknutí uživatele (prohlížeče jinak zvuk blokují). */
  unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      if (!AC) return
      this.ctx = new AC()
      const comp = this.ctx.createDynamicsCompressor()
      comp.connect(this.ctx.destination)
      this.master = this.ctx.createGain()
      this.master.gain.value = this.muted ? 0 : 0.55
      this.master.connect(comp)
      const len = this.ctx.sampleRate
      this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate)
      const data = this.noiseBuf.getChannelData(0)
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume()
  }

  setMuted(m: boolean) {
    this.muted = m
    try {
      localStorage.setItem(MUTE_KEY, m ? '1' : '0')
    } catch {
      /* nic */
    }
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(m ? 0 : 0.55, this.ctx.currentTime, 0.05)
  }

  // ---------- nástroje ----------

  private tone(freq: number, at: number, dur: number, opts: { type?: OscillatorType; vol?: number; attack?: number; to?: number } = {}) {
    const { ctx, master } = this
    if (!ctx || !master) return
    const osc = ctx.createOscillator()
    const g = ctx.createGain()
    osc.type = opts.type ?? 'triangle'
    osc.frequency.setValueAtTime(freq, at)
    if (opts.to) osc.frequency.exponentialRampToValueAtTime(opts.to, at + dur)
    const vol = opts.vol ?? 0.2
    const attack = opts.attack ?? 0.005
    g.gain.setValueAtTime(0.0001, at)
    g.gain.exponentialRampToValueAtTime(vol, at + attack)
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur)
    osc.connect(g).connect(master)
    osc.start(at)
    osc.stop(at + dur + 0.05)
  }

  private noise(at: number, dur: number, vol: number, freq = 8000, q = 0.8) {
    const { ctx, master, noiseBuf } = this
    if (!ctx || !master || !noiseBuf) return
    const src = ctx.createBufferSource()
    src.buffer = noiseBuf
    const f = ctx.createBiquadFilter()
    f.type = 'bandpass'
    f.frequency.value = freq
    f.Q.value = q
    const g = ctx.createGain()
    g.gain.setValueAtTime(vol, at)
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur)
    src.connect(f).connect(g).connect(master)
    src.start(at, Math.random() * 0.5)
    src.stop(at + dur + 0.05)
  }

  // ---------- hudba ----------

  playMusic(name: MusicName) {
    if (this.music === name) return
    this.music = name
    window.clearInterval(this.musicTimer)
    if (!name || !this.ctx) return
    this.step = 0
    this.nextTime = this.ctx.currentTime + 0.1
    this.musicTimer = window.setInterval(() => this.schedule(), 50)
  }

  private schedule() {
    const ctx = this.ctx
    if (!ctx || !this.music) return
    while (this.nextTime < ctx.currentTime + 0.25) {
      if (this.music === 'lobby') this.waltzBeat(this.step, this.nextTime)
      else this.pulseStep(this.step, this.nextTime)
      this.nextTime += this.music === 'lobby' ? 60 / 150 : 60 / 132 / 2
      this.step++
    }
  }

  private waltzBeat(step: number, at: number) {
    const beat = step % 24
    const bar = Math.floor(beat / 3)
    const [bass, chord] = WALTZ_CHORDS[bar]
    const spb = 60 / 150
    if (beat % 3 === 0) this.tone(midi(bass), at, spb * 1.4, { type: 'sine', vol: 0.22 })
    else chord.forEach((n) => this.tone(midi(n), at, spb * 0.6, { type: 'triangle', vol: 0.05 }))
    for (const [b, n, d] of WALTZ_MELODY) {
      if (b === beat) {
        this.tone(midi(n + 12), at, spb * d * 1.1, { type: 'sine', vol: 0.11 })
        this.tone(midi(n + 24), at, spb * 0.5, { type: 'sine', vol: 0.025 })
      }
    }
  }

  private pulseStep(step: number, at: number) {
    const s = step % 16
    this.tone(midi(PULSE_BASS[s]), at, 0.16, { type: 'square', vol: 0.06 })
    if (s % 2 === 1) this.noise(at, 0.04, 0.12, 9000, 1)
    if (s % 4 === 0) this.tone(midi(PULSE_BASS[s] + 36), at, 0.25, { type: 'sine', vol: 0.05 })
    if (s === 0) this.noise(at, 0.12, 0.18, 300, 0.7)
  }

  // ---------- efekty ----------

  private now() {
    return this.ctx ? this.ctx.currentTime + 0.01 : 0
  }

  tick(urgent = false) {
    const t = this.now()
    this.tone(urgent ? 1400 : 1000, t, 0.06, { type: 'square', vol: urgent ? 0.08 : 0.05 })
  }

  pop() {
    const t = this.now()
    this.tone(500, t, 0.12, { type: 'sine', vol: 0.18, to: 1100 })
  }

  correct() {
    const t = this.now()
    ;[72, 76, 79, 84].forEach((n, i) => this.tone(midi(n), t + i * 0.08, 0.35, { type: 'triangle', vol: 0.16 }))
  }

  wrong() {
    const t = this.now()
    this.tone(220, t, 0.25, { type: 'sawtooth', vol: 0.08, to: 150 })
    this.tone(207, t + 0.22, 0.4, { type: 'sawtooth', vol: 0.08, to: 110 })
  }

  gong() {
    const t = this.now()
    ;[110, 165, 220, 277].forEach((f, i) => this.tone(f, t, 2.2 - i * 0.3, { type: 'sine', vol: 0.16 / (i + 1), attack: 0.01 }))
    this.noise(t, 0.4, 0.1, 1200, 0.5)
  }

  reveal() {
    const t = this.now()
    ;[69, 72, 76, 81].forEach((n, i) => this.tone(midi(n), t + i * 0.06, 0.5, { type: 'triangle', vol: 0.12 }))
  }

  /** Parní píšťala lokomotivy. */
  whistle() {
    const { ctx, master } = this
    if (!ctx || !master) return
    const t = this.now()
    const toot = (start: number, dur: number) => {
      const g = ctx.createGain()
      g.gain.setValueAtTime(0.0001, start)
      g.gain.exponentialRampToValueAtTime(0.09, start + 0.06)
      g.gain.setValueAtTime(0.09, start + dur - 0.12)
      g.gain.exponentialRampToValueAtTime(0.0001, start + dur)
      const f = ctx.createBiquadFilter()
      f.type = 'bandpass'
      f.frequency.value = 900
      f.Q.value = 1.2
      f.connect(g).connect(master)
      for (const freq of [554, 659, 784]) {
        const o = ctx.createOscillator()
        o.type = 'sawtooth'
        o.frequency.setValueAtTime(freq * 0.97, start)
        o.frequency.linearRampToValueAtTime(freq, start + 0.12)
        o.connect(f)
        o.start(start)
        o.stop(start + dur + 0.05)
      }
      this.noise(start, dur, 0.05, 3000, 0.6)
    }
    toot(t, 0.35)
    toot(t + 0.45, 0.8)
  }

  drumroll(seconds = 2.2) {
    const t = this.now()
    const n = Math.floor(seconds / 0.035)
    for (let i = 0; i < n; i++) {
      const at = t + i * 0.035
      this.noise(at, 0.05, 0.03 + (i / n) * 0.12, 1800, 0.6)
    }
    this.noise(t + seconds, 1.2, 0.25, 6000, 0.4)
  }

  fanfare() {
    const t = this.now()
    const notes: [number, number, number][] = [
      [60, 0, 0.18], [64, 0.18, 0.18], [67, 0.36, 0.18], [72, 0.54, 0.6],
      [67, 1.2, 0.18], [72, 1.38, 1.2],
    ]
    for (const [n, at, d] of notes) {
      this.tone(midi(n), t + at, d + 0.2, { type: 'sawtooth', vol: 0.07, attack: 0.03 })
      this.tone(midi(n + 12), t + at, d + 0.2, { type: 'triangle', vol: 0.08, attack: 0.02 })
    }
  }
}

export const sound = new SoundEngine()

export function vibrate(pattern: number | number[]) {
  try {
    navigator.vibrate?.(pattern)
  } catch {
    /* nic */
  }
}
