import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { QUESTION_SETS } from '../data/questions'
import { HostGame, INTRO_MS, clearSavedGame, loadSavedGame, type HostSnapshot } from '../game/host'
import { joinUrl, publicHost } from '../game/net'
import { TYPE_LABEL } from '../game/scoring'
import { sound } from '../game/sound'
import {
  FullscreenButton,
  MuteButton,
  QR,
  TimerRing,
  TypeIcon,
  czPlayers,
  czPoints,
  formatPin,
  useNow,
  useTicking,
} from '../components/common'
import { FactCard, Podium, QuestionCenter, QuestionHeading, ResultCenter, Tiles, TrainRace } from '../components/Stage'

export function HostPage() {
  const [saved] = useState(loadSavedGame)
  const [mode, setMode] = useState<'splash' | 'new' | 'resume'>('splash')
  const [run, setRun] = useState(0)

  if (mode === 'splash') {
    return (
      <div className="host splash">
        <div className="splash-card">
          <div className="splash-train" aria-hidden="true">
            🚂
          </div>
          <h1 className="title">Expres Anna Karenina</h1>
          <p className="lead">Kvíz k prezentaci o L. N. Tolstém. Spusť ho na projektoru, hráči se připojí z mobilů.</p>
          <div className="splash-actions">
            <button
              className="btn btn-gold btn-xl"
              onClick={() => {
                sound.unlock()
                clearSavedGame()
                setMode('new')
              }}
            >
              Otevřít nástupiště
            </button>
            {saved && (
              <button
                className="btn btn-ghost btn-xl"
                onClick={() => {
                  sound.unlock()
                  setMode('resume')
                }}
              >
                Obnovit rozehranou hru (PIN {formatPin(saved.link?.pin ?? '')}, {czPlayers(saved.players.length)})
              </button>
            )}
          </div>
          <p className="hint">Tip: tlačítkem ⛶ přepneš na celou obrazovku. Hru posouváš mezerníkem, šipkou nebo klikátkem.</p>
          {window.innerWidth < 700 && (
            <p className="lobby-warn">
              📱 Tahle stránka patří na počítač s projektorem a musí zůstat otevřená v popředí. Hráči se připojují na svých
              mobilech přes úvodní stránku.
            </p>
          )}
          <a className="link" href="/">
            ← Zpět
          </a>
        </div>
      </div>
    )
  }

  return (
    <HostRunner
      key={run}
      resume={mode === 'resume'}
      onNewGame={() => {
        clearSavedGame()
        setMode('new')
        setRun((r) => r + 1)
      }}
    />
  )
}

function HostRunner({ resume, onNewGame }: { resume: boolean; onNewGame: () => void }) {
  const [game] = useState(() => new HostGame(resume ? loadSavedGame() : null))
  useEffect(() => () => game.destroy(), [game])
  const s = useSyncExternalStore(game.subscribe, game.getSnapshot)

  // hudba a zvuky podle fáze hry
  useEffect(() => {
    sound.playMusic(s.phase === 'lobby' ? 'lobby' : s.phase === 'question' ? 'question' : null)
    if (s.phase === 'intro') sound.reveal()
    if (s.phase === 'result') sound.gong()
  }, [s.phase, s.qIndex])
  useEffect(() => () => sound.playMusic(null), [])

  const count = s.players.length
  const prevCount = useRef(count)
  useEffect(() => {
    if (count > prevCount.current && s.phase === 'lobby') sound.pop()
    prevCount.current = count
  }, [count, s.phase])

  // ovládání klávesnicí a prezentačním klikátkem
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement
      if (el && ['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName)) return
      if (![' ', 'Enter', 'ArrowRight', 'PageDown'].includes(e.key)) return
      e.preventDefault()
      const snap = game.getSnapshot()
      if (snap.phase === 'lobby') game.start()
      else if (snap.phase !== 'final') game.next()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [game])

  return (
    <div className={`host phase-${s.phase}`}>
      <header className="host-bar">
        <div className="brand">
          <span aria-hidden="true">🚂</span> Expres Anna Karenina
        </div>
        {s.phase !== 'lobby' && (
          <div className="pin-mini">
            {publicHost()}/hrat · PIN <b>{formatPin(s.pin)}</b>
          </div>
        )}
        <div className="bar-right">
          {s.link && (
            <span
              className={`link-chip link-${s.link}`}
              title={
                s.link === 'relay'
                  ? 'Telefony se připojují přes server webu (funguje na každé síti).'
                  : 'Telefony se připojují napřímo přes WebRTC (na některých sítích nefunguje).'
              }
            >
              {s.link === 'relay' ? 'spojení přes server' : 'přímé spojení'}
            </span>
          )}
          <span className={`net net-${s.status}`} title={s.status === 'ready' ? 'Připojeno' : 'Připojuji…'} />
          <MuteButton />
          <FullscreenButton />
        </div>
      </header>

      {s.status !== 'ready' && (
        <div className={`banner ${s.status === 'error' ? 'banner-error' : ''}`} role="status">
          {s.error ?? 'Připojuji se k serveru…'}
        </div>
      )}

      <main className="host-main">
        {s.phase === 'lobby' && <Lobby s={s} game={game} />}
        {s.phase === 'intro' && <Intro s={s} />}
        {s.phase === 'question' && <QuestionPhase s={s} game={game} />}
        {s.phase === 'result' && <ResultPhase s={s} game={game} />}
        {s.phase === 'leaderboard' && (
          <section className="lb-stage">
            <h2 className="stage-title">Průběžné pořadí</h2>
            <TrainRace key={s.qIndex} players={s.players} qIndex={s.qIndex} qTotal={s.questions.length} />
            <div className="stage-actions">
              <button className="btn btn-gold btn-lg" onClick={() => game.next()}>
                Další otázka →
              </button>
            </div>
          </section>
        )}
        {s.phase === 'final' && <FinalPhase s={s} game={game} onNewGame={onNewGame} />}
      </main>

      <div className="reactions" aria-hidden="true">
        {s.reactions.map((r) => (
          <span key={r.key} style={{ left: `${r.x}%` }}>
            {r.emoji}
          </span>
        ))}
      </div>
    </div>
  )
}

function Lobby({ s, game }: { s: HostSnapshot; game: HostGame }) {
  const set = s.set
  const quickLen = set.quick?.length ?? 0
  return (
    <section className="lobby">
      <div className="join-card">
        <div className="join-text">
          <p className="join-step">
            Na mobilu otevři <b className="join-url">{publicHost()}</b>
          </p>
          <p className="join-step">a zadej PIN hry:</p>
          <div className="pin-big" aria-label={s.pin ? `PIN ${s.pin}` : 'Připravuji PIN'}>
            {s.pin ? formatPin(s.pin) : '··· ···'}
          </div>
        </div>
        <div className="join-qr">
          {s.pin ? <QR text={joinUrl(s.pin)} size={190} /> : <div className="qr qr-wait" style={{ width: 190, height: 190 }} />}
          <span>nebo naskenuj</span>
        </div>
      </div>
      {s.link === 'p2p' && (
        <p className="lobby-warn" role="note">
          ⚠️ Web nemá připojenou databázi, takže se telefony spojují s tímto počítačem napřímo. Na školní Wi-Fi nebo mobilních
          datech to často nefunguje. Spolehlivé spojení zapneš podle návodu v README (Vercel → Storage → Upstash Redis).{' '}
          <a className="link" href="/test" target="_blank" rel="noreferrer">
            Test připojení
          </a>
        </p>
      )}

      <div className="lobby-main">
        <div className="lobby-head">
          <h2>
            <b>{s.players.length}</b> {s.players.length >= 1 && s.players.length <= 4 ? 'cestující' : 'cestujících'} na nástupišti
          </h2>
          {s.players.length > 0 && <span className="hint">Kliknutím na jméno hráče odebereš.</span>}
        </div>
        {s.players.length === 0 ? (
          <div className="lobby-empty">
            <div className="empty-train" aria-hidden="true">
              🚂💨
            </div>
            <p>Čekáme na první cestující…</p>
          </div>
        ) : (
          <ul className="player-cloud">
            {s.players.map((p) => (
              <li key={p.id}>
                <button
                  className={`player-chip ${p.connected ? '' : 'offline'}`}
                  onClick={() => {
                    if (confirm(`Odebrat hráče ${p.name}?`)) game.kick(p.id)
                  }}
                  title="Odebrat hráče"
                >
                  <span className="chip-avatar">{p.avatar}</span>
                  {p.name}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <footer className="lobby-foot">
        <div className="settings">
          {QUESTION_SETS.length > 1 && (
            <label className="field">
              <span>Sada otázek</span>
              <select value={set.id} onChange={(e) => game.setOptions(e.target.value, s.quick)}>
                {QUESTION_SETS.map((qs) => (
                  <option key={qs.id} value={qs.id}>
                    {qs.title}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div className="set-info">
            <b>{set.title}</b>
            <span>{set.subtitle}</span>
          </div>
          {quickLen > 0 && (
            <div className="seg" role="radiogroup" aria-label="Délka hry">
              <button role="radio" aria-checked={!s.quick} className={!s.quick ? 'on' : ''} onClick={() => game.setOptions(set.id, false)}>
                Celá jízda · {set.questions.length} otázek
              </button>
              <button role="radio" aria-checked={s.quick} className={s.quick ? 'on' : ''} onClick={() => game.setOptions(set.id, true)}>
                Rychlík · {quickLen} otázky
              </button>
            </div>
          )}
        </div>
        <div className="lobby-actions">
          <button
            className={`btn btn-ghost ${s.locked ? 'is-locked' : ''}`}
            onClick={() => game.setLocked(!s.locked)}
            title="Zamčená hra nepustí nové hráče (třeba když někdo posílá falešné hráče)."
          >
            {s.locked ? '🔒 Vstup zamčený' : '🔓 Zamknout vstup'}
          </button>
          <button className="btn btn-gold btn-xl" disabled={s.players.length === 0} onClick={() => game.start()}>
            Vyjíždíme! ▶
          </button>
        </div>
      </footer>
    </section>
  )
}

function Intro({ s }: { s: HostSnapshot }) {
  const q = s.question!
  return (
    <section className="intro-stage">
      <div className="intro-num">
        Otázka {s.qIndex + 1}
        <small> z {s.questions.length}</small>
      </div>
      <div className="intro-type">
        <TypeIcon type={q.type} /> {TYPE_LABEL[q.type]}
        {q.double && <span className="chip chip-gold">dvojnásobné body</span>}
      </div>
      <h1 className="intro-text">{q.type === 'hints' ? 'Poznáš postavu podle nápověd?' : q.text}</h1>
      <div className="intro-bar">
        <div style={{ animationDuration: `${INTRO_MS}ms` }} />
      </div>
    </section>
  )
}

function QuestionPhase({ s, game }: { s: HostSnapshot; game: HostGame }) {
  const q = s.question!
  const now = useNow(200)
  const deadline = s.startedAt + q.time * 1000
  useTicking(deadline, true)
  const connected = s.players.filter((p) => p.connected).length
  return (
    <section className={`q-stage type-${q.type}`}>
      <QuestionHeading q={q} qIndex={s.qIndex} qTotal={s.questions.length} />
      <div className="q-mid">
        <TimerRing deadline={deadline} total={q.time * 1000} size={130} />
        <div className="q-center">
          <QuestionCenter q={q} orderShuffle={s.orderShuffle} elapsedMs={now - s.startedAt} />
          <Boarded players={s.players} big={q.type === 'quiz' || q.type === 'truefalse'} />
        </div>
        <div className="answered">
          <b>{s.answeredCount}</b>
          <span>z {connected} odpovědí</span>
        </div>
      </div>
      <Tiles q={q} />
      <button className="btn btn-ghost skip" onClick={() => game.next()}>
        Ukončit otázku ⏭
      </button>
    </section>
  )
}

/** Kdo už odpověděl – hráči „nastupují“ do vlaku. */
function Boarded({ players, big }: { players: HostSnapshot['players']; big: boolean }) {
  const done = players.filter((p) => p.answer).sort((a, b) => a.answer!.elapsed - b.answer!.elapsed)
  return (
    <div className={`boarded ${big ? 'big' : ''}`}>
      {big && done.length === 0 && <p className="boarded-empty">Kdo odpoví první? 🚂</p>}
      <ul>
        {done.map((p) => (
          <li key={p.id}>
            <span className="boarded-avatar">{p.avatar}</span>
            <span className="boarded-name">{p.name}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function ResultPhase({ s, game }: { s: HostSnapshot; game: HostGame }) {
  const q = s.question!
  const answers = s.players.flatMap((p) => (p.answer ? [p.answer.value] : []))
  const stat = s.stats.find((x) => x.qIndex === s.qIndex)
  const last = s.qIndex >= s.questions.length - 1
  return (
    <section className={`r-stage type-${q.type}`}>
      <QuestionHeading q={q} qIndex={s.qIndex} qTotal={s.questions.length} />
      <div className="r-mid">
        <div className="r-center">
          <ResultCenter q={q} answers={answers} players={s.players.map((p) => ({ name: p.name, value: p.answer?.value }))} />
        </div>
        <FactCard fact={q.fact} />
      </div>
      <Tiles q={q} reveal />
      <div className="stage-actions">
        <span className="pct">{stat ? `${stat.correctPct} % hráčů odpovědělo úplně správně` : ''}</span>
        <button className="btn btn-gold btn-lg" onClick={() => game.next()}>
          {last ? 'Do cílové stanice 🏁' : 'Pořadí →'}
        </button>
      </div>
    </section>
  )
}

function FinalPhase({ s, game, onNewGame }: { s: HostSnapshot; game: HostGame; onNewGame: () => void }) {
  const [details, setDetails] = useState(false)
  const sorted = s.players.slice().sort((a, b) => a.rank - b.rank)
  const hardest = s.stats.length ? s.stats.reduce((a, b) => (b.correctPct < a.correctPct ? b : a)) : null

  const download = () => {
    const rows = [['Pořadí', 'Jméno', 'Body'], ...sorted.map((p) => [String(p.rank), p.name, String(p.score)])]
    // Jména začínající =, +, - nebo @ by Excel spustil jako vzorec – předsadíme apostrof.
    const cell = (c: string) => `"${(/^[=+\-@\t\r]/.test(c) ? "'" + c : c).replace(/"/g, '""')}"`
    const csv = '\uFEFF' + rows.map((r) => r.map(cell).join(';')).join('\r\n')
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
    const a = document.createElement('a')
    a.href = url
    a.download = 'vysledky-anna-karenina.csv'
    a.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  return (
    <section className="final-stage">
      <h2 className="stage-title">Konečná stanice: Petrohrad!</h2>
      {details ? (
        <div className="final-details">
          <div className="standings">
            <h3>Celkové pořadí</h3>
            <ol>
              {sorted.map((p) => (
                <li key={p.id}>
                  <span className="st-rank">{p.rank}.</span>
                  <span className="st-avatar">{p.avatar}</span>
                  <span className="st-name">{p.name}</span>
                  <span className="st-score">{czPoints(p.score)}</span>
                </li>
              ))}
            </ol>
          </div>
          <div className="qstats">
            <h3>Úspěšnost otázek</h3>
            <ul>
              {s.stats
                .slice()
                .sort((a, b) => a.qIndex - b.qIndex)
                .map((st) => {
                  const q = s.questions[st.qIndex]
                  return (
                    <li key={st.qIndex} className={hardest && st.qIndex === hardest.qIndex ? 'hardest' : ''}>
                      <span className="qs-label">
                        {st.qIndex + 1}. {q.type === 'hints' ? `Kdo jsem? (${q.options[q.correct]})` : q.text}
                      </span>
                      <span className="qs-bar">
                        <i style={{ width: `${st.correctPct}%` }} />
                      </span>
                      <b>{st.correctPct} %</b>
                    </li>
                  )
                })}
            </ul>
            {hardest && <p className="hint">Nejtěžší byla otázka č. {hardest.qIndex + 1}. Stojí za to ji probrat.</p>}
          </div>
        </div>
      ) : (
        <Podium players={s.players} />
      )}
      <div className="stage-actions wrap">
        <button className="btn btn-ghost" onClick={() => setDetails((d) => !d)}>
          {details ? 'Zpět na stupně vítězů' : 'Celé pořadí a statistiky'}
        </button>
        <button className="btn btn-ghost" onClick={download}>
          Stáhnout výsledky (CSV)
        </button>
        <button className="btn btn-ghost" onClick={() => game.playAgain()}>
          Hrát znovu se stejnými hráči
        </button>
        <button className="btn btn-gold" onClick={onNewGame}>
          Nová hra
        </button>
      </div>
    </section>
  )
}
