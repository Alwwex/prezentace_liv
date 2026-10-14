/**
 * Časovač, který běží i ve skryté kartě. Prohlížeče zpomalují setTimeout v kartách na pozadí
 * (třeba když prezentující přepne do PowerPointu) až na jednou za minutu. Zprávy z Web Workeru
 * ale chodí dál, takže hostitel přijímá hráče a ukončuje otázky včas.
 */
type Fn = () => void

const subs = new Set<Fn>()
let started = false

function start() {
  if (started) return
  started = true
  const fire = () => {
    subs.forEach((fn) => {
      try {
        fn()
      } catch (e) {
        console.error(e)
      }
    })
  }
  try {
    const src = 'setInterval(function () { postMessage(0) }, 200)'
    const worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })))
    worker.onmessage = fire
  } catch {
    window.setInterval(fire, 200)
  }
}

export function onTick(fn: Fn): () => void {
  start()
  subs.add(fn)
  return () => {
    subs.delete(fn)
  }
}

/** Jako setTimeout, ale spolehlivé i na pozadí. Vrací funkci pro zrušení. */
export function later(fn: Fn, ms: number): () => void {
  const at = Date.now() + ms
  let done = false
  const run = () => {
    if (done) return
    done = true
    off()
    window.clearTimeout(timer)
    fn()
  }
  const off = onTick(() => {
    if (Date.now() >= at) run()
  })
  const timer = window.setTimeout(run, ms)
  return () => {
    done = true
    off()
    window.clearTimeout(timer)
  }
}
