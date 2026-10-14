import type { PeerOptions } from 'peerjs'

/**
 * Hráči se k hostiteli připojují přímo přes WebRTC (PeerJS). Pro „seznámení“ zařízení
 * se standardně používá bezplatný server PeerJS Cloud, takže web nepotřebuje žádný backend.
 * Vlastní signalizační server lze nastavit proměnnými VITE_PEER_HOST, VITE_PEER_PORT,
 * VITE_PEER_PATH a VITE_PEER_SECURE.
 */
export function peerOptions(): PeerOptions {
  const env = import.meta.env
  const opts: PeerOptions = { debug: 0 }
  if (env.VITE_PEER_HOST) {
    opts.host = env.VITE_PEER_HOST
    opts.port = Number(env.VITE_PEER_PORT || 443)
    opts.path = env.VITE_PEER_PATH || '/'
    opts.secure = env.VITE_PEER_SECURE !== 'false'
  }
  return opts
}

const PREFIX = 'expres-anna-karenina-'

export function hostPeerId(pin: string): string {
  return PREFIX + pin
}

export function randomPin(): string {
  return String(Math.floor(100000 + Math.random() * 900000))
}

export function randomId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return Math.random().toString(36).slice(2) + Date.now().toString(36)
}

/**
 * Veřejná adresa hry, kterou mají otevřít mobily. Vercel při buildu doplní hlavní (produkční)
 * doménu projektu. Hráči tak nedostanou dočasnou adresu nasazení, kterou Vercel chrání přihlášením.
 */
export function publicHost(): string {
  const raw = typeof __PUBLIC_HOST__ === 'string' ? __PUBLIC_HOST__ : ''
  if (raw) {
    const host = raw.replace(/^https?:\/\//, '').replace(/\/.*$/, '')
    if (host) return host
  }
  return location.host
}

export function joinUrl(pin: string): string {
  const host = publicHost()
  const proto = host === location.host ? location.protocol : 'https:'
  return `${proto}//${host}/hrat?pin=${pin}`
}

export const AVATARS = ['🚂', '🎩', '🌹', '🕯️', '❄️', '📜', '🪶', '🫖', '🎻', '🦢', '🐎', '💌', '🌾', '⛪', '🎭', '🧣']

export const REACTIONS = ['👏', '😮', '😂', '❤️', '🔥', '🚂']

export function cleanName(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().slice(0, 16)
}
