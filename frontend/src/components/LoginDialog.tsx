import { FormEvent, useState, useEffect } from 'react';

interface LoginDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (email: string, password: string) => Promise<void>;
  isSubmitting?: boolean;
  errorMessage?: string | null;
}

export const LoginDialog = ({ isOpen, onClose, onSubmit, isSubmitting = false, errorMessage }: LoginDialogProps) => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) {
      setEmail('');
      setPassword('');
      setLocalError(null);
    }
  }, [isOpen]);

  if (!isOpen) {
    return null;
  }

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setLocalError(null);

    if (!email.trim() || !password) {
      setLocalError('Bitte E-Mail und Passwort eingeben.');
      return;
    }

    try {
      await onSubmit(email.trim(), password);
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : 'Anmeldung fehlgeschlagen.');
    }
  };

  const displayError = localError ?? errorMessage;

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-labelledby="login-dialog-title">
      <div className="modal__backdrop" onClick={onClose} aria-hidden="true" />
      <div className="modal__content modal__content--compact">
        <header className="modal__header">
          <h2 id="login-dialog-title">Anmeldung</h2>
          <button type="button" className="modal__close" onClick={onClose} aria-label="Dialog schließen">
            ×
          </button>
        </header>
        <form className="modal__body" onSubmit={handleSubmit}>
          <label className="form-field">
            <span>E-Mail</span>
            <input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoComplete="email"
              required
            />
          </label>
          <label className="form-field">
            <span>Passwort</span>
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              required
            />
          </label>
          {displayError ? <p className="form-error">{displayError}</p> : null}
          <div className="modal__actions">
            <button type="button" className="button" onClick={onClose} disabled={isSubmitting}>
              Abbrechen
            </button>
            <button type="submit" className="button button--primary" disabled={isSubmitting}>
              {isSubmitting ? 'Anmeldung…' : 'Anmelden'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
