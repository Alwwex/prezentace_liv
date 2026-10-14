import { useEffect, useState } from 'react'
import Peer from 'peerjs'
import { peerOptions } from '../game/net'

type State = 'wait' | 'ok' | 'warn' | 'bad'

interface Check {
  key: string
  label: string
  state: State
  detail: string
}

const ICON: Record<State, string> = { wait: '⏳', ok: '✅', warn: '⚠️', bad: '❌' }

async function timed<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const t0 = performance.now()
  const r = await fn()
  return [r, Math.round(performance.now() - t0)]
}

async function post(body: object) {
  const res = await fetch('/api/relay', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`HTTP ${res.status} ${(data as { error?: string }).error ?? ''}`)
  return data as Record<string, unknown>
}

/** Stránka /test: ukáže, jestli na tomhle zařízení a síti funguje připojení ke hře. */
export function DiagPage() {
  const [checks, setChecks] = useState<Check[]>([
    { key: 'web', label: 'Web a JavaScript', state: 'ok', detail: 'Stránka se načetla.' },
    { key: 'relay', label: 'Server hry (spolehlivé spojení)', state: 'wait', detail: 'Zjišťuji…' },
    { key: 'p2p', label: 'Přímé spojení (PeerJS)', state: 'wait', detail: 'Zjišťuji…' },
  ])
  const [copied, setCopied] = useState(false)

  const set = (key: string, state: State, detail: string) =>
    setChecks((cs) => cs.map((c) => (c.key === key ? { ...c, state, detail } : c)))

  useEffect(() => {
    let alive = true
    const upd = (key: string, state: State, detail: string) => alive && set(key, state, detail)

    void (async () => {
      try {
        const [health, ms] = await timed(async () => {
          const r = await fetch('/api/relay', { cache: 'no-store' })
          if (!r.ok) throw new Error(`HTTP ${r.status}`)
          return (await r.json()) as { relay?: boolean; reason?: string }
        })
        if (!health.relay) {
          if (health.reason === 'store-error') {
            upd('relay', 'bad', 'Databáze je připojená, ale neodpovídá (vyčerpaný měsíční limit, nebo smazaná databáze). Hra zatím použije přímé spojení.')
          } else {
            upd('relay', 'warn', 'Server běží, ale nemá připojenou databázi. Hra použije přímé spojení. Návod na zapnutí je v README.')
          }
          return
        }
        const [room, ms2] = await timed(() => post({ op: 'create' }))
        const [, ms3] = await timed(() =>
          post({ op: 'send', pin: room.pin, playerId: 'diag', msg: { t: 'ping' } }),
        )
        await post({ op: 'sync', pin: room.pin, secret: room.secret, slots: {} })
        upd('relay', 'ok', `Funguje. Odezva ${ms} / ${ms2} / ${ms3} ms.`)
      } catch (e) {
        upd('relay', 'bad', `Server neodpovídá (${(e as Error).message}).`)
      }
    })()

    let peer: Peer | null = null
    const timer = window.setTimeout(() => {
      upd('p2p', 'bad', 'Server PeerJS neodpověděl do 10 s (síť ho možná blokuje).')
      peer?.destroy()
    }, 10000)
    if (typeof RTCPeerConnection === 'undefined') {
      window.clearTimeout(timer)
      upd('p2p', 'bad', 'Prohlížeč nepodporuje WebRTC.')
    } else {
      const t0 = performance.now()
      peer = new Peer(peerOptions())
      peer.on('open', () => {
        window.clearTimeout(timer)
        upd('p2p', 'ok', `Server PeerJS dostupný (${Math.round(performance.now() - t0)} ms). Samotné spojení mezi zařízeními ale může zablokovat síť.`)
        peer?.destroy()
      })
      peer.on('error', (err) => {
        window.clearTimeout(timer)
        upd('p2p', 'bad', `Chyba PeerJS: ${(err as { type?: string }).type ?? err.message}`)
        peer?.destroy()
      })
    }
    return () => {
      alive = false
      window.clearTimeout(timer)
      peer?.destroy()
    }
  }, [])

  const report = [
    ...checks.map((c) => `${ICON[c.state]} ${c.label}: ${c.detail}`),
    `Prohlížeč: ${navigator.userAgent}`,
    `Adresa: ${location.host}`,
  ].join('\n')

  return (
    <div className="phone diag">
      <h1 className="title">Test připojení</h1>
      <p className="lead">Otevři tuhle stránku na mobilu i na počítači se hrou. Ukáže, jestli se zařízení můžou spojit.</p>
      <ul className="diag-list">
        {checks.map((c) => (
          <li key={c.key} className={`diag-${c.state}`}>
            <span className="diag-icon" aria-hidden="true">
              {ICON[c.state]}
            </span>
            <div>
              <b>{c.label}</b>
              <p>{c.detail}</p>
            </div>
          </li>
        ))}
      </ul>
      <p className="hint diag-ua">{navigator.userAgent}</p>
      <div className="pad-row">
        <button
          className="btn btn-gold grow"
          onClick={() => {
            void navigator.clipboard?.writeText(report).then(() => setCopied(true))
          }}
        >
          {copied ? 'Zkopírováno ✓' : 'Zkopírovat výsledek'}
        </button>
        <a className="btn btn-ghost" href="/">
          Zpět
        </a>
      </div>
    </div>
  )
}
