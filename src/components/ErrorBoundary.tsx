import { Component, type ReactNode } from 'react'

/** Když se při vykreslení něco pokazí, ukáže srozumitelnou zprávu místo prázdné stránky. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="phone center">
        <div className="big-icon">🚧</div>
        <h2>Něco se pokazilo</h2>
        <p className="join-help">{this.state.error.message}</p>
        <button className="btn btn-gold" onClick={() => location.reload()}>
          Obnovit stránku
        </button>
      </div>
    )
  }
}
