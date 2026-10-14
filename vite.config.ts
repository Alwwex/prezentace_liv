import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * Při `npm run dev` obslouží /api/relay stejným kódem, jaký na Vercelu běží jako
 * Vercel Function (api/relay.ts). Bez proměnných KV_REST_API_URL/TOKEN se data drží v paměti.
 */
function relayDev(): Plugin {
  return {
    name: 'relay-dev',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url || !req.url.startsWith('/api/relay')) return next()
        try {
          const mod = (await server.ssrLoadModule('/api/relay.ts')) as {
            GET: (r: Request) => Promise<Response>
            POST: (r: Request) => Promise<Response>
          }
          const chunks: Buffer[] = []
          for await (const c of req) chunks.push(c as Buffer)
          const request = new Request(`http://localhost${req.url}`, {
            method: req.method,
            headers: { 'content-type': String(req.headers['content-type'] ?? 'application/json') },
            body: req.method === 'POST' ? Buffer.concat(chunks).toString('utf8') : undefined,
          })
          const response = await (req.method === 'POST' ? mod.POST : mod.GET)(request)
          res.statusCode = response.status
          response.headers.forEach((value, key) => res.setHeader(key, value))
          res.end(await response.text())
        } catch (e) {
          next(e)
        }
      })
    },
  }
}

export default defineConfig({
  plugins: [react(), relayDev()],
  define: {
    // Hlavní adresa webu pro QR kód (Vercel ji při buildu dává do VERCEL_PROJECT_PRODUCTION_URL).
    __PUBLIC_HOST__: JSON.stringify(process.env.VITE_PUBLIC_URL || process.env.VERCEL_PROJECT_PRODUCTION_URL || ''),
  },
  build: {
    // Starší telefony (iOS 14, Android Chrome 85) neumějí nejnovější syntaxi JavaScriptu.
    target: ['es2020', 'chrome87', 'edge88', 'firefox78', 'safari14', 'ios14'],
  },
})
