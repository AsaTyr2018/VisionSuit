import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';

interface RegisterDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (payload: { email: string; displayName: string; password: string }) => Promise<void>;
  isSubmitting?: boolean;
  errorMessage?: string | null;
}

export const RegisterDialog = ({
  isOpen,
  onClose,
  onSubmit,
  isSubmitting = false,
  errorMessage,
}: RegisterDialogProps) => {
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) {
      setEmail('');
      setDisplayName('');
      setPassword('');
      setConfirmPassword('');
      setLocalError(null);
    }
  }, [isOpen]);

  if (!isOpen) {
    return null;
  }

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setLocalError(null);

    const trimmedEmail = email.trim();
    const trimmedName = displayName.trim();

    if (!trimmedEmail || !trimmedName || !password || !confirmPassword) {
      setLocalError('Please fill out all fields to continue.');
      return;
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
      setLocalError('Please provide a valid email address.');
      return;
    }

    if (password.length < 8) {
      setLocalError('Passwords must contain at least 8 characters.');
      return;
    }

    if (password !== confirmPassword) {
      setLocalError('Password confirmation does not match.');
      return;
    }

    try {
      await onSubmit({ email: trimmedEmail, displayName: trimmedName, password });
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : 'Registration failed.');
    }
  };

  const displayError = localError ?? errorMessage;

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-labelledby="register-dialog-title">
      <div className="modal__backdrop" onClick={onClose} aria-hidden="true" />
      <div className="modal__content modal__content--compact">
        <header className="modal__header">
          <h2 id="register-dialog-title">Create account</h2>
          <button type="button" className="modal__close" onClick={onClose} aria-label="Close dialog">
            ×
          </button>
        </header>
        <form className="modal__body" onSubmit={handleSubmit}>
          <label className="form-field">
            <span>Email</span>
            <input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoComplete="email"
              required
            />
          </label>
          <label className="form-field">
            <span>Display name</span>
            <input
              type="text"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              autoComplete="name"
              required
              minLength={2}
            />
          </label>
          <label className="form-field">
            <span>Password</span>
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="new-password"
              required
              minLength={8}
            />
          </label>
          <label className="form-field">
            <span>Confirm password</span>
            <input
              type="password"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              autoComplete="new-password"
              required
              minLength={8}
            />
          </label>
          {displayError ? <p className="form-error">{displayError}</p> : null}
          <div className="modal__actions">
            <button type="button" className="button" onClick={onClose} disabled={isSubmitting}>
              Cancel
            </button>
            <button type="submit" className="button button--primary" disabled={isSubmitting}>
              {isSubmitting ? 'Creating…' : 'Create account'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
