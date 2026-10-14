import { HostPage } from './pages/Host'
import { PlayPage } from './pages/Play'
import { SoloPage } from './pages/Solo'

export function App() {
  const path = location.pathname.replace(/\/+$/, '') || '/'
  if (path === '/host') return <HostPage />
  if (path === '/trenink') return <SoloPage />
  if (path === '/hrat') return <PlayPage />
  return <PlayPage landing />
}
