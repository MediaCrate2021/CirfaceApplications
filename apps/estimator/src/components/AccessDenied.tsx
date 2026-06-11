//-------------------------//
// AccessDenied.tsx
// Shown when an authenticated Asana user is not on the Cirface access list.
// Pre-fills name and email from OAuth; collects company and a short note.
//-------------------------//

import { useState } from 'react';
import type { AppUser } from '../App.tsx';

interface Props {
  user: AppUser;
}

export default function AccessDenied({ user }: Props) {
  const [company, setCompany] = useState('');
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(e: React.SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    setSubmitting(true);
    setError('');
    try {
      await fetch('/api/access/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: user.name, email: user.email, company, note }),
      });
      setSubmitted(true);
    } catch {
      setError('Something went wrong. Please try again or contact Cirface directly.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="login-screen">
      <div className="login-card" style={{ maxWidth: 480, textAlign: 'left' }}>
        <img src="/logo" alt="Cirface" style={{ height: 40, marginBottom: '0.25rem', alignSelf: 'center' }} />

        {submitted ? (
          <div style={{ textAlign: 'center' }}>
            <h1>Request received</h1>
            <p className="subtitle" style={{ marginTop: '0.5rem' }}>
              Thanks, {user.name.split(' ')[0]}. We'll be in touch shortly at <strong>{user.email}</strong>.
            </p>
            <a href="/api/auth/logout" className="btn btn-ghost" style={{ marginTop: '1.5rem', display: 'inline-block' }}>
              Sign out
            </a>
          </div>
        ) : (
          <>
            <h1 style={{ textAlign: 'center' }}>Access required</h1>
            <p className="subtitle" style={{ textAlign: 'center' }}>
              Your account isn't on the access list yet. Fill in the form below and we'll reach out to get you set up.
            </p>

            <form onSubmit={handleSubmit} style={{ marginTop: '0.5rem', width: '100%' }}>
              <div className="field-group">
                <label>Name</label>
                <input type="text" value={user.name} readOnly className="input-readonly" />
              </div>

              <div className="field-group">
                <label>Email</label>
                <input type="email" value={user.email} readOnly className="input-readonly" />
              </div>

              <div className="field-group">
                <label htmlFor="company">Company</label>
                <input
                  id="company"
                  type="text"
                  value={company}
                  onChange={(e) => setCompany(e.target.value)}
                  placeholder="Your company name"
                  required
                />
              </div>

              <div className="field-group">
                <label htmlFor="note">What are you looking to migrate?</label>
                <textarea
                  id="note"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Briefly describe your project or what platform you're migrating from…"
                  rows={3}
                />
              </div>

              {error && <p className="error-text">{error}</p>}

              <div className="step-actions" style={{ marginTop: '1.25rem' }}>
                <a href="/api/auth/logout" className="btn btn-ghost">Sign out</a>
                <button type="submit" className="btn btn-primary" disabled={submitting || !company.trim()}>
                  {submitting ? 'Sending…' : 'Request access'}
                </button>
              </div>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
