import { useState } from 'react';

import { useAuth } from '@/context/auth';
import { friendlyAuthError } from '@/lib/auth-errors';

export function LoginPage() {
  const { signIn, signedOutReason, dismissSignedOutReason } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const canSubmit = email.trim().length > 0 && password.length > 0 && !submitting;

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;
    setError(null);
    setSubmitting(true);
    try {
      await signIn(email, password);
      // On success the auth guard swaps screens for us — nothing to do here.
    } catch (err) {
      setError(friendlyAuthError(err));
      setSubmitting(false);
    }
  }

  return (
    <div className="auth-screen">
      {/*
        Why the user is looking at this screen, when the app is the thing that
        put them here. Above the card rather than inside it, because it is about
        the session that just ended, not about the one they are starting — and
        because a message tucked between two fields is one people sign straight
        past without reading, then ask someone about.
      */}
      {signedOutReason && (
        <div className="auth-notice" role="alert">
          <div className="auth-notice-body">
            <strong>{signedOutReason.title}</strong>
            <p>{signedOutReason.detail}</p>
          </div>
          <button
            type="button"
            className="auth-notice-dismiss"
            aria-label="Dismiss"
            onClick={dismissSignedOutReason}>
            ×
          </button>
        </div>
      )}

      <form className="auth-card" onSubmit={handleSubmit}>
        <h1>NewOldWorld Dashboard</h1>

        <label className="field">
          <span>Email</span>
          <input
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="you@example.com"
            autoComplete="email"
            disabled={submitting}
          />
        </label>

        <label className="field">
          <span>Password</span>
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="Your password"
            autoComplete="current-password"
            disabled={submitting}
          />
        </label>

        {error && <p className="error">{error}</p>}

        <button type="submit" disabled={!canSubmit}>
          {submitting ? 'Signing in…' : 'Sign in'}
        </button>

        <p className="hint">
          Accounts are managed by your dashboard administrator — ask them to add you, or to send you a new
          password link. Each account can only be signed in on one browser at a time.
        </p>
      </form>
    </div>
  );
}
