import { useEffect, useState } from 'react';
import { HashRouter, Route, Routes, NavLink } from 'react-router-dom';
import { applyTheme, loadTheme, nextTheme, type Theme } from './theme.js';
import { useMe } from './hooks/useMe.js';
import { api } from './api.js';
import { LoginPage } from './pages/Login.js';
import { WalletPage } from './pages/Wallet.js';
import { MinePage } from './pages/Mine.js';
import { SendPage } from './pages/Send.js';
import { ActivityPage } from './pages/Activity.js';
import { LedgerPage } from './pages/Ledger.js';
import { StatsPage } from './pages/Stats.js';

const HEADER = [
  '+======================================================================+',
  '|                   RPOW3 - Reusable Proofs of Work                    |',
  '+======================================================================+',
].join('\n');

const STATS_HEADER = [
  '+======================================================================+',
  '|                  RPOW3 - LIVE NETWORK STATS                          |',
  '+======================================================================+',
].join('\n');

/**
 * Returns true when the page is being served from the dedicated stats
 * subdomain. We render a stripped-down "stats only" shell in that case
 * (no wallet/mine/send nav, no auth probe). Falls back to false during
 * SSR or in odd contexts.
 */
function isStatsHost(): boolean {
  if (typeof window === 'undefined') return false;
  const h = window.location.hostname;
  // Match exact subdomain plus a couple of preview/staging variants. We
  // intentionally don't match arbitrary "stats." prefixes — Cloudflare
  // Pages preview hosts shouldn't render the stats-only chrome.
  return h === 'stats.rpow3.com' || h === 'stats.localhost';
}

function StatsOnlyShell() {
  const [theme, setTheme] = useState<Theme>(loadTheme());
  useEffect(() => { applyTheme(theme); }, [theme]);
  return (
    <div className="app-shell">
      <header>
        <pre className="ascii-header" style={{ margin: 0 }}>{STATS_HEADER}</pre>
        <h1 className="mobile-header">RPOW3 — Live Network Stats</h1>
        <div className="tagline">
          public dashboard for the rpow3 proof-of-work token network ·{' '}
          <a href="https://rpow3.com">rpow3.com</a>
        </div>
        <nav className="site-nav" style={{ marginTop: 8 }}>
          <a href="https://rpow3.com">[ wallet ]</a>{' '}
          <a href="https://rpow3.com/#/mine">[ mine ]</a>{' '}
          <a href="https://rpow3.com/#/ledger">[ ledger ]</a>
          {' · '}
          <button onClick={() => setTheme(nextTheme(theme))} title="cycle theme">[ theme: {theme} ]</button>
        </nav>
      </header>
      <main>
        <StatsPage embedded />
      </main>
    </div>
  );
}

function FullShell() {
  const [theme, setTheme] = useState<Theme>(loadTheme());
  useEffect(() => { applyTheme(theme); }, [theme]);
  const { me } = useMe();

  async function logout() {
    try { await api.logout(); } catch { /* ignore */ }
    window.location.href = '/';
  }

  return (
    <HashRouter>
      <div className="app-shell">
        <div className="pyrus-banner">
          built by arben — a new way to buy bitcoin, 1 btc for $1,200/mo at{' '}
          <a href="https://pyrusfinancial.com" target="_blank" rel="noopener noreferrer">[ pyrus financial → ]</a>
        </div>
        <header>
          <pre className="ascii-header" style={{ margin: 0 }}>{HEADER}</pre>
          <h1 className="mobile-header">RPOW3 — Reusable Proofs of Work</h1>
          <div className="tagline">a modern tribute to a tribute to the original rpow by hal finney</div>
          <nav className="site-nav" style={{ marginTop: 8 }}>
            <NavLink to="/">[ wallet ]</NavLink>{' '}
            <NavLink to="/mine">[ mine ]</NavLink>{' '}
            <NavLink to="/send">[ send ]</NavLink>{' '}
            <NavLink to="/activity">[ activity ]</NavLink>{' '}
            <NavLink to="/ledger">[ ledger ]</NavLink>{' '}
            <NavLink to="/stats">[ stats ]</NavLink>{' '}
            {me ? (
              <button onClick={logout} title="end session">[ logout ]</button>
            ) : (
              <NavLink to="/login">[ login ]</NavLink>
            )}
            {' · '}
            <button onClick={() => setTheme(nextTheme(theme))} title="cycle theme">[ theme: {theme} ]</button>
          </nav>
        </header>
        <main>
          <Routes>
            <Route path="/" element={<WalletPage />} />
            <Route path="/login" element={<LoginPage />} />
            <Route path="/mine" element={<MinePage />} />
            <Route path="/send" element={<SendPage />} />
            <Route path="/activity" element={<ActivityPage />} />
            <Route path="/ledger" element={<LedgerPage />} />
            <Route path="/stats" element={<StatsPage />} />
          </Routes>
        </main>
      </div>
    </HashRouter>
  );
}

export default function App() {
  return isStatsHost() ? <StatsOnlyShell /> : <FullShell />;
}
