import { HashRouter, Route, Routes, Link } from 'react-router-dom';

export default function App() {
  return (
    <HashRouter>
      <div className="app-shell">
        <header>
          <pre>+======================================================================+
|  RPOW2 - Reusable Proofs of Work                            v0.1.0  |
+======================================================================+</pre>
          <div className="tagline">a tribute to the original rpow by hal finney</div>
          <nav><Link to="/">home</Link> · <Link to="/ledger">ledger</Link></nav>
        </header>
        <main>
          <Routes>
            <Route path="/" element={<div>welcome.</div>} />
            <Route path="/ledger" element={<div>ledger TBD</div>} />
          </Routes>
        </main>
      </div>
    </HashRouter>
  );
}
