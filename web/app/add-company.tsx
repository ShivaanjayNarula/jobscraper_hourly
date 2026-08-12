'use client';

import { useState } from 'react';
import { REPO_URL } from '@/lib/types';
import { detectBoard, toEntry, type Detected } from '@/lib/ats';

/**
 * Paste a careers URL, get a validated companies.json entry.
 *
 * The validation happens in your browser against the ATS directly — those
 * endpoints allow cross-origin reads, so the board is confirmed to exist and have
 * open jobs before you commit anything. There's no backend to persist to, so the
 * final step is a prefilled GitHub issue.
 */
export function AddCompany() {
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [industry, setIndustry] = useState('tech');
  const [busy, setBusy] = useState(false);
  const [found, setFound] = useState<Detected | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function check() {
    setBusy(true);
    setError(null);
    setFound(null);
    try {
      setFound(await detectBoard(url.trim()));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const label = name.trim() || found?.token || 'Company';
  const entry = found ? toEntry(found, label, industry) : '';
  const issueUrl = found
    ? `${REPO_URL}/issues/new?title=${encodeURIComponent(`Add ${label}`)}&body=${encodeURIComponent(
        `Add to companies.json:\n\n\`\`\`json\n${entry}\n\`\`\`\n`,
      )}`
    : '#';

  return (
    <details className="adder panel">
      <summary>Add a company</summary>
      <div className="body">
        <p style={{ margin: 0, fontSize: 13, color: 'var(--muted)' }}>
          Open the company&apos;s careers page, click through to their job listings, and paste that
          URL here.
        </p>

        <div className="row">
          <input
            type="text"
            style={{ flex: '1 1 320px' }}
            placeholder="https://jobs.lever.co/acme"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          <button className="primary" onClick={check} disabled={busy || url.trim().length < 8}>
            {busy ? 'Checking…' : 'Check'}
          </button>
        </div>

        {error && <div className="result err">{error}</div>}

        {found && (
          <>
            <div className="result ok">
              Found <strong>{found.ats}</strong> board <code>{found.token}</code>
              {found.jobCount !== null ? ` — ${found.jobCount} open jobs` : ''}
              {found.note ? ` · ${found.note}` : ''}
            </div>

            <div className="row">
              <label className="field" style={{ flex: '1 1 200px' }}>
                Display name
                <input
                  type="text"
                  placeholder={found.token}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
              <label className="field">
                Industry
                <select value={industry} onChange={(e) => setIndustry(e.target.value)}>
                  <option value="tech">tech</option>
                  <option value="fintech">fintech</option>
                  <option value="quant">quant</option>
                  <option value="banking">banking</option>
                  <option value="consulting">consulting</option>
                </select>
              </label>
            </div>

            <pre>{entry}</pre>

            <div className="row">
              <button className="primary" onClick={() => navigator.clipboard.writeText(entry)}>
                Copy entry
              </button>
              <a className="chip" href={issueUrl} target="_blank" rel="noreferrer">
                Open prefilled GitHub issue
              </a>
            </div>

            <p style={{ margin: 0, fontSize: 12, color: 'var(--muted)' }}>
              Paste it into <code>companies.json</code> and push — the next hourly run picks it up.
            </p>
          </>
        )}
      </div>
    </details>
  );
}
