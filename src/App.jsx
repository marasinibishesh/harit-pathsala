import React, { useState } from 'react';
import Navbar from './components/Navbar.jsx';
import CalculatorPage from './components/Calculator.jsx';
import ExplorerGamePage from './components/ExplorerGame.jsx';
import AskBanaPage from './components/AskBana.jsx';
import { LanguageProvider } from './i18n.jsx';

// Catches any render error so the page never goes blank silently.
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // eslint-disable-next-line no-console
    console.error('Harit Pathsala render error:', error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="page">
          <div className="card">
            <h2 style={{ color: 'var(--danger)' }}>Something went wrong rendering this view.</h2>
            <p className="muted" style={{ fontWeight: 700 }}>Open the browser console for details. You can switch tabs to recover.</p>
            <pre style={{ whiteSpace: 'pre-wrap', fontSize: '.8rem' }}>{String(this.state.error)}</pre>
            <button className="btn" style={{ marginTop: 10 }} onClick={() => this.setState({ error: null })}>Try again</button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function App() {
  const [tab, setTab] = useState('calc');
  return (
    <LanguageProvider>
    <div className="app">
      <Navbar tab={tab} setTab={setTab} />
      <ErrorBoundary key={tab}>
        {tab === 'calc' && <CalculatorPage />}
        {tab === 'explore' && <ExplorerGamePage />}
        {tab === 'ask' && <AskBanaPage />}
      </ErrorBoundary>
      <footer className="footer">
        हरित पाठशाला · Harit Pathsala — Green School · Built for Nepal's students · Powered by correct science · Runs on your school laptop
      </footer>
    </div>
    </LanguageProvider>
  );
}
