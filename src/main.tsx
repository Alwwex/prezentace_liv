import { createRoot } from 'react-dom/client'
import '@fontsource/nunito/600.css'
import '@fontsource/nunito/800.css'
import '@fontsource/nunito/900.css'
import '@fontsource/playfair-display/700.css'
import '@fontsource/playfair-display/700-italic.css'
import '@fontsource/playfair-display/900.css'
import './styles.css'
import { App } from './App'
import { ErrorBoundary } from './components/ErrorBoundary'

createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
)
