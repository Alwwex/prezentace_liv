import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { PlayerClient, clearSavedPlayer, loadSavedPlayer } from '../game/client'
import { AVATARS, REACTIONS, cleanName } from '../game/net'
import { TYPE_LABEL } from '../game/scoring'
import { vibrate } from '../game/sound'
import { AnswerPad } from '../components/AnswerPad'
import { TypeIcon, czPoints, fireConfetti, useCountUp, useNow } from '../components/common'
import type { Answer, PlayerView } from '../game/types'

export function PlayPage({ landing }: { landing?: boolean }) {
  const params = new URLSearchParams(location.search)
  const urlPin = (params.get('pin') ?? '').replace(/\D/g, '').slice(0, 6)
  const [saved] = useState(loadSavedPlayer)
  const [client, setClient] = useState<PlayerClient | null>(() => {
    // Po obnovení stránky (adresa obsahuje PIN rozehrané hry) pokračujeme automaticky.
    if (saved && urlPin === saved.pin) {
      return new PlayerClient(saved.pin, saved.name, saved.avatar, saved.playerId, saved.link, saved.joined)
    }
    return null
  })
  const [resume, setResume] = useState(() => (saved && !urlPin ? saved : null))
  const [formError, setFormError] = useState('')
  const [lastPin, setLastPin] = useState(urlPin)
  useEffect(() => () => client?.destroy(), [client])

  if (!client) {
    return (
      <JoinForm
        initialPin={lastPin}
        landing={landing}
        error={formError}
        resume={
          resume
            ? {
                pin: resume.pin,
                name: resume.name,
                go: () => {
                  setResume(null)
                  setClient(new PlayerClient(resume.pin, resume.name, resume.avatar, resume.playerId, resume.link, resume.joined))
                },
                dismiss: () => {
                  clearSavedPlayer()
                  setResume(null)
                },
              }
            : null
        }
        onJoin={(pin, name, avatar) => {
          setFormError('')
          setLastPin(pin)
          setClient(new PlayerClient(pin, name, avatar))
        }}
      />
    )
  }
  return (
    <Joined
      client={client}
      onLeave={(err) => {
        clearSavedPlayer()
        setFormError(err ?? '')
        // Dobrovolný odchod = začínáme načisto; při chybě necháme PIN k opravě.
        if (!err) setLastPin('')
        // PIN neplatné hry z adresy odstraníme, ať ji obnovení stránky znovu nenačte.
        try {
          history.replaceState(null, '', '/hrat')
        } catch {
          /* nic */
        }
        setClient(null)
      }}
    />
  )
}

// ---------- Připojení ----------

function JoinForm({
  initialPin,
  landing,
  error,
  resume,
  onJoin,
}: {
  initialPin: string
  landing?: boolean
  error: string
  resume: { pin: string; name: string; go: () => void; dismiss: () => void } | null
  onJoin: (pin: string, name: string, avatar: string) => void
}) {
  const [pin, setPin] = useState(initialPin)
  const [step, setStep] = useState<'pin' | 'name'>(initialPin.length === 6 && !error ? 'name' : 'pin')
  const [name, setName] = useState('')
  const [avatar, setAvatar] = useState(() => AVATARS[Math.floor(Math.random() * AVATARS.length)])

  return (
    <div className="phone join">
      <div className="join-hero">
        <div className="join-logo" aria-hidden="true">
          🚂
        </div>
        <h1 className="title">Expres Anna Karenina</h1>
        {landing && <p className="lead">Kvíz o Tolstém a jeho slavném románu</p>}
      </div>

      {resume && (
        <div className="resume-card">
          <p>
            Rozehraná hra <b>{resume.pin}</b> jako <b>{resume.name}</b>
          </p>
          <div className="pad-row">
            <button className="btn btn-gold grow" onClick={resume.go}>
              Pokračovat ve hře
            </button>
            <button className="btn btn-ghost" onClick={resume.dismiss}>
              Zahodit
            </button>
          </div>
        </div>
      )}

      {step === 'pin' ? (
        <form
          className="join-box"
          onSubmit={(e) => {
            e.preventDefault()
            if (pin.length === 6) setStep('name')
          }}
        >
          <label htmlFor="pin" className="sr-only">
            PIN hry
          </label>
          <input
            id="pin"
            className="input input-pin"
            inputMode="numeric"
            autoComplete="off"
            placeholder="PIN hry"
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
            autoFocus
          />
          {error && (
            <p className="form-error">
              {error}{' '}
              <a className="link" href="/test">
                Otestovat připojení
              </a>
            </p>
          )}
          <button className="btn btn-gold btn-block btn-lg" disabled={pin.length !== 6}>
            Pokračovat
          </button>
          {landing ? (
            <ol className="how-to">
              <li>
                Na počítači s projektorem otevři <b>{location.host}/host</b> a klikni na „Otevřít nástupiště“.
              </li>
              <li>Na mobilu zadej PIN z plátna, nebo naskenuj QR kód.</li>
            </ol>
          ) : (
            <p className="join-help">PIN uvidíš na plátně, až hru spustí hostitel na počítači.</p>
          )}
        </form>
      ) : (
        <form
          className="join-box"
          onSubmit={(e) => {
            e.preventDefault()
            const n = cleanName(name)
            if (n) onJoin(pin, n, avatar)
          }}
        >
          <p className="join-pin">
            Hra <b>{pin}</b>{' '}
            <button type="button" className="link" onClick={() => setStep('pin')}>
              změnit
            </button>
          </p>
          <label htmlFor="name" className="sr-only">
            Přezdívka
          </label>
          <input
            id="name"
            className="input"
            placeholder="Tvoje přezdívka"
            maxLength={16}
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
            autoComplete="nickname"
          />
          <p className="pick-label">Vyber si odznak na lokomotivu:</p>
          <div className="avatar-grid" role="radiogroup" aria-label="Odznak">
            {AVATARS.map((a) => (
              <button
                type="button"
                key={a}
                role="radio"
                aria-checked={a === avatar}
                className={a === avatar ? 'on' : ''}
                onClick={() => setAvatar(a)}
              >
                {a}
              </button>
            ))}
          </div>
          <button className="btn btn-gold btn-block btn-lg" disabled={!cleanName(name)}>
            Nastoupit do vlaku
          </button>
        </form>
      )}

      {landing && (
        <nav className="landing-links">
          <a className="btn btn-ghost" href="/host">
            🖥️ Spustit hru na projektoru
          </a>
          <a className="btn btn-ghost" href="/trenink">
            🎯 Trénink pro jednoho
          </a>
          <a className="link landing-test" href="/test">
            Nejde se připojit? Otestuj připojení
          </a>
        </nav>
      )}
    </div>
  )
}

// ---------- Ve hře ----------

function Joined({ client, onLeave }: { client: PlayerClient; onLeave: (err?: string) => void }) {
  const s = useSyncExternalStore(client.subscribe, client.getSnapshot)

  useEffect(() => {
    if (s.status === 'error') onLeave(s.error)
  }, [s.status, s.error, onLeave])

  // Po připojení dáme PIN do adresy, aby obnovení stránky vrátilo hráče rovnou do hry.
  const joined = s.status === 'joined'
  useEffect(() => {
    if (!joined) return
    const want = `/hrat?pin=${client.gamePin}`
    if (location.pathname + location.search !== want) {
      try {
        history.replaceState(null, '', want)
      } catch {
        /* nic */
      }
    }
  }, [joined, client])

  if (s.status === 'kicked') {
    return (
      <div className="phone center">
        <div className="big-icon">🚉</div>
        <h2>Hostitel tě vyřadil ze hry.</h2>
        <button className="btn btn-gold" onClick={() => onLeave()}>
          Zpět
        </button>
      </div>
    )
  }

  const v = s.view
  if (!v || s.status === 'connecting') return <Connecting onCancel={() => onLeave()} />

  return (
    <div className={`phone ingame phase-${v.phase}`}>
      <header className="ph-bar">
        <span className="ph-me">
          <span className="ph-avatar">{v.me.avatar}</span>
          {v.me.name}
        </span>
        {'qIndex' in v && (
          <span className="ph-q">
            {v.qIndex + 1}/{v.qTotal}
          </span>
        )}
        <span className="ph-score">{v.me.score.toLocaleString('cs-CZ')}</span>
      </header>
      {s.status === 'reconnecting' && (
        <div className="banner" role="status">
          Spojení se přerušilo, připojuji znovu…
        </div>
      )}
      {s.status === 'host-away' && (
        <div className="banner banner-error" role="status">
          Počítač se hrou neodpovídá. Je hra na projektoru pořád otevřená?{' '}
          <button className="link" onClick={() => onLeave()}>
            Odejít
          </button>
        </div>
      )}
      <main className="ph-main">
        <PhaseView view={v} deadline={s.deadline} client={client} onLeave={onLeave} />
      </main>
    </div>
  )
}

function Connecting({ onCancel }: { onCancel: () => void }) {
  const [start] = useState(() => Date.now())
  const now = useNow(1000)
  const slow = now - start > 8000
  return (
    <div className="phone center">
      <div className="loader-train" aria-hidden="true">
        🚂
      </div>
      <p>Připojuji se ke hře…</p>
      {slow && (
        <p className="join-help">
          Trvá to dlouho? Zkontroluj PIN a že je hra na počítači spuštěná.{' '}
          <a className="link" href="/test">
            Otestovat připojení
          </a>
        </p>
      )}
      <button className="btn btn-ghost" onClick={onCancel}>
        Zrušit
      </button>
    </div>
  )
}

function PhaseView({
  view: v,
  deadline,
  client,
  onLeave,
}: {
  view: PlayerView
  deadline: number
  client: PlayerClient
  onLeave: () => void
}) {
  switch (v.phase) {
    case 'lobby':
      return (
        <div className="ph-center">
          <div className="big-avatar pop-in">{v.me.avatar}</div>
          <h2>Jsi ve vlaku!</h2>
          <p>Sleduj plátno, za chvíli vyjíždíme.</p>
          <p className="ph-small">Cestujících ve vlaku: {v.players}</p>
          <Reactions client={client} />
        </div>
      )
    case 'intro':
      return (
        <div className="ph-center">
          <p className="ph-kicker">Otázka {v.qIndex + 1}</p>
          <div className="ph-type">
            <TypeIcon type={v.type} /> {TYPE_LABEL[v.type]}
          </div>
          {v.double && <span className="chip chip-gold">Finále · dvojnásobné body</span>}
          <p>Připrav se…</p>
          <div className="intro-bar small">
            <div style={{ animationDuration: '4.5s' }} />
          </div>
        </div>
      )
    case 'question':
      return <QuestionView key={v.qIndex} view={v} deadline={deadline} client={client} />
    case 'result':
      return <ResultView key={v.qIndex} view={v} client={client} />
    case 'leaderboard':
      return (
        <div className="ph-center">
          <div className="big-icon">🚂</div>
          <h2>Jsi na {v.me.rank}. místě</h2>
          <p>Sleduj závod vlaků na plátně!</p>
          <Reactions client={client} />
        </div>
      )
    case 'final':
      return <FinalView view={v} onLeave={onLeave} />
  }
}

function QuestionView({
  view: v,
  deadline,
  client,
}: {
  view: Extract<PlayerView, { phase: 'question' }>
  deadline: number
  client: PlayerClient
}) {
  const [joker, setJoker] = useState(false)
  const now = useNow(200)
  const left = Math.max(0, deadline - now)
  const elapsed = v.totalMs - left

  if (v.answered) {
    return (
      <div className="ph-center">
        <div className="loader-train" aria-hidden="true">
          🚂
        </div>
        <h2>Odpověď odeslána!</h2>
        <p>Čekáme na ostatní cestující…</p>
      </div>
    )
  }
  if (left <= 0) {
    return (
      <div className="ph-center">
        <div className="big-icon">⏰</div>
        <h2>Čas vypršel</h2>
      </div>
    )
  }
  const submit = (a: Answer) => {
    vibrate(30)
    client.answer(v.qIndex, a, joker)
  }
  return (
    <div className="ph-question">
      <div className="ph-timer" aria-hidden="true">
        <i style={{ width: `${(left / v.totalMs) * 100}%` }} />
      </div>
      <p className="ph-qtext">{v.text}</p>
      {!v.me.jokerUsed && (
        <button className={`joker ${joker ? 'on' : ''}`} onClick={() => setJoker((j) => !j)} aria-pressed={joker}>
          ⚡ Expres ×2 {joker ? 'zapnut' : '· jednou za hru zdvojnásobí body'}
        </button>
      )}
      <AnswerPad question={v.question} onSubmit={submit} elapsedMs={elapsed} />
    </div>
  )
}

function ResultView({ view: v, client }: { view: Extract<PlayerView, { phase: 'result' }>; client: PlayerClient }) {
  const r = v.result
  const kind = !r.answered ? 'none' : r.correct ? 'ok' : r.fraction > 0 ? 'part' : 'bad'
  const total = r.points + r.streakBonus
  const shown = useCountUp(total, 0, 900)
  const done = useRef(false)
  useEffect(() => {
    if (done.current) return
    done.current = true
    vibrate(kind === 'ok' ? [60, 40, 60] : kind === 'part' ? 60 : 250)
  }, [kind])

  const title = { ok: 'Správně!', part: 'Skoro!', bad: 'Tohle nevyšlo', none: 'Čas vypršel' }[kind]
  const icon = { ok: '✓', part: '≈', bad: '✗', none: '⏰' }[kind]
  return (
    <div className={`ph-result res-${kind}`}>
      <div className="res-icon pop-in">{icon}</div>
      <h2>{title}</h2>
      <div className="res-points">+{shown.toLocaleString('cs-CZ')}</div>
      <div className="res-badges">
        {r.streakBonus > 0 && <span className="chip">🔥 Série {v.me.streak} · +{r.streakBonus}</span>}
        {r.joker && <span className="chip chip-gold">⚡ Expres ×2</span>}
      </div>
      {kind !== 'ok' && (
        <p className="res-correct">
          Správně: <b>{r.correctText}</b>
        </p>
      )}
      <p className="res-rank">
        Jsi na <b>{v.me.rank}. místě</b>
        {v.behind ? (
          <>
            . Před tebou je <b>{v.behind.name}</b>, o {czPoints(v.behind.gap)}.
          </>
        ) : (
          ' a vedeš! 🏆'
        )}
      </p>
      <Reactions client={client} />
    </div>
  )
}

function FinalView({ view: v, onLeave }: { view: Extract<PlayerView, { phase: 'final' }>; onLeave: () => void }) {
  const medal = ['🥇', '🥈', '🥉'][v.me.rank - 1]
  useEffect(() => {
    if (v.me.rank <= 3) window.setTimeout(() => fireConfetti(v.me.rank === 1), 4000)
  }, [v.me.rank])
  return (
    <div className="ph-center">
      <div className="big-icon pop-in">{medal ?? '🚉'}</div>
      <h2>
        {v.me.rank}. místo z {v.total}
      </h2>
      <p className="res-points">{czPoints(v.me.score)}</p>
      <p>Konečná stanice. Díky za jízdu!</p>
      <button className="btn btn-ghost" onClick={() => onLeave()}>
        Odejít ze hry
      </button>
    </div>
  )
}

function Reactions({ client }: { client: PlayerClient }) {
  const [cool, setCool] = useState(false)
  return (
    <div className="ph-reactions" aria-label="Pošli reakci na plátno">
      {REACTIONS.map((e) => (
        <button
          key={e}
          disabled={cool}
          onClick={() => {
            client.react(e)
            setCool(true)
            window.setTimeout(() => setCool(false), 700)
          }}
        >
          {e}
        </button>
      ))}
    </div>
  )
}
